// 외부 감시인(watchdog). "감시 대상 수집 job(엔터 오전·오후·저녁 / 사회) 각각이 이번 수집일에 성공했는가"를
// 확인하고, 하나라도 아니면 어느 job인지 이름을 붙여 Telegram으로 알린다.
// 수집일은 KST 05:00에 바뀐다 - collectionDayString 주석 참고.
//
// 왜 필요한가(CURRENT_STATE.md "운영 노트: 잠자기로 인한 조용한 실패"):
// 매일 09:00 job이 caffeinate 보호를 받지만, 전원 차단·강제 재부팅·launchd 미발화 같은 경우엔
// 프로세스가 아예 시작되지 못하거나 강제 종료된다. 강제 종료된 프로세스는 notifyPipelineFailure를
// 실행할 수 없으므로, "실패했다"는 사실조차 아무도 모른다. 이 감시인은 그 구멍을 밖에서 막는다.
//
// 반드시 daily-keyword job과 다른 호스트에서 돌아야 의미가 있다(같은 맥이 꺼져 있으면 감시인도
// 안 돈다). GitHub Actions cron으로 실행하는 것을 전제로 한다 - docs/ai-handoff/CLOUD_MIGRATION.md.
//
// 이 스크립트는 Playwright도 claude CLI도 쓰지 않는다. Supabase 읽기 + Telegram 발송뿐이라
// CI로 그대로 올릴 수 있다. 의존성이 가벼운 것이 이 감시인의 핵심 설계 조건이다.
import "dotenv/config";

import { listRecentDiscoveryRuns } from "../services/supabase/repositories/discoveryRunRepository.js";
import { TelegramNotifier } from "../notifications/TelegramNotifier.js";
import type { DiscoveryRunRow } from "../types/database.js";

const SEOUL_TZ = "Asia/Seoul";

/** Date를 Asia/Seoul 기준 YYYY-MM-DD 문자열로. */
export function seoulDateString(date: Date): string {
  // en-CA 로케일은 YYYY-MM-DD 형식을 준다.
  return date.toLocaleDateString("en-CA", { timeZone: SEOUL_TZ });
}

/**
 * "수집일"의 경계를 KST 자정이 아니라 **새벽 05:00**으로 본다(2026-10-05 개편, 전에는 정오).
 *
 * 왜 자정이면 안 되는가: 감시인은 21:00 KST로 예약돼 있는데 GitHub Actions 네이티브 schedule은 4~6시간
 * 밀린다(10-01 21:00 예약이 10-02 02:42 KST에 돌았다). 자정 경계면 그 시각의 "오늘"에는 수집이 없어
 * 매일 밤 거짓 실패 알림이 나갔다(2026-10-02).
 *
 * 왜 정오가 아니라 05:00인가: 엔터가 09:00 KST에도 돌게 되면서(하루 09/13/18시 + 사회 20시) 모든 수집이
 * 같은 달력 날짜 안의 09~20시에 있다. 정오 경계는 09시 회차를 **전날**로 잘못 분류한다. 05:00이면
 * 09~20시 수집이 한 수집일에 묶이고, 21:00 예약이 8시간(05:00 이전)까지 밀려도 같은 수집일로 본다.
 * 진짜 누락은 여전히 잡는다 - 그날 회차 run이 없으면 수집일이 어긋난다.
 *
 * 수집 시각을 바꾸면 이 값도 같이 봐야 한다.
 */
const COLLECTION_DAY_OFFSET_MS = 5 * 60 * 60 * 1000;

export function collectionDayString(date: Date): string {
  return seoulDateString(new Date(date.getTime() - COLLECTION_DAY_OFFSET_MS));
}

export type WatchdogVerdict =
  | { ok: true; run: DiscoveryRunRow; runDate: string }
  | { ok: false; reason: "no_completed_run"; lastRun: null }
  | { ok: false; reason: "stale_run"; lastRun: DiscoveryRunRow; lastRunDate: string };

/** 최신 completed run이 "이번 수집일" 것인지 판정한다. DB 조회 결과만 받는 순수 함수. */
export function evaluateWatchdog(
  latest: DiscoveryRunRow | null,
  now: Date,
  dayOffset = 0
): WatchdogVerdict {
  // dayOffset가 음수면 "그 수집일 이후" run이면 충분하다(같은 시각에 도는 job 대응 - WATCHED_JOBS 참고).
  // 0이면 예전처럼 오늘 수집일과 정확히 같아야 한다.
  const today = collectionDayString(dayOffset === 0 ? now : new Date(now.getTime() + dayOffset * 24 * 60 * 60 * 1000));

  if (!latest) {
    return { ok: false, reason: "no_completed_run", lastRun: null };
  }

  // started_at을 기준으로 본다(completed_at이 null인 채로 completed 표시된 과거 데이터 방어).
  const runDate = collectionDayString(new Date(latest.started_at));
  if (dayOffset === 0 ? runDate === today : runDate >= today) {
    return { ok: true, run: latest, runDate };
  }

  return { ok: false, reason: "stale_run", lastRun: latest, lastRunDate: runDate };
}

/**
 * 감시할 수집 job. 각 job은 discovery_runs.metadata.kind에 자기 이름을, 회차가 있는 job은
 * metadata.round에 회차를 남긴다(entertainmentKeywordJob / socialIssueKeywordJob이 넘기는 metadata).
 *
 * 왜 job별로 보는가(2026-10-03): 전에는 "이번 수집일에 완료된 run이 **하나라도** 있는가"만 봤다.
 * 그래서 2026-10-01·10-02에 엔터·커뮤니티 두 job이 통째로 안 돌았는데도 사회·경제가 돌았다는
 * 이유로 정상 판정이었고, 이틀 동안 아무 경보도 없었다. 일부만 죽는 경우를 잡으려면 job마다 따로
 * 봐야 한다.
 *
 * 2026-10-05 개편: 엔터는 회차(오전/오후/저녁)마다 따로 본다. 커뮤니티는 엔터 회차에 통합돼 독립 job이
 * 아니므로 목록에서 뺐다.
 *
 * 2026-10-06 개편3: 사용설명서(kscene_topic, 21시)를 추가했다. watchdog이 Worker 12 UTC 슬롯에서 kscene 수집과
 * **같은 시각에** 깨어나므로 오늘 수집일의 kscene run은 아직 없다 - `dayOffset: -1`로 **전날 수집일 이후**의
 * 완료 run을 요구한다(하루 늦게 잡히는 대신 거짓 경보가 없다). 도입 첫날은 전날 run이 없어 한 번 경보가 날 수
 * 있다(알려진 한계).
 *
 * **job을 없애거나 이름을 바꾸면 여기도 같이 고쳐야 한다.** 목록에 남은 job은 매일 돌아야 하는
 * 것으로 보고 안 돌면 경보를 보낸다.
 */
export const WATCHED_JOBS = [
  { kind: "entertainment", round: "morning", label: "엔터 오전(09시)" },
  { kind: "entertainment", round: "noon", label: "엔터 오후(13시)" },
  { kind: "entertainment", round: "evening", label: "엔터 저녁(18시)" },
  { kind: "social_issue", label: "사회" },
  { kind: "kscene_topic", label: "사용설명서(21시, 전날분)", dayOffset: -1 },
] as const satisfies readonly { kind: string; round?: string; label: string; dayOffset?: number }[];

export type WatchedJob = (typeof WATCHED_JOBS)[number];

export type JobWatchdogCheck = { job: WatchedJob; verdict: WatchdogVerdict };

export type JobWatchdogVerdict = {
  /** 감시 대상 job이 전부 이번 수집일에 돌았을 때만 true. */
  ok: boolean;
  checks: JobWatchdogCheck[];
  /** 이번 수집일에 돌지 않은 job만. */
  failed: JobWatchdogCheck[];
};

function runKind(run: DiscoveryRunRow): string | null {
  const kind = run.metadata?.kind;
  return typeof kind === "string" ? kind : null;
}

function runRound(run: DiscoveryRunRow): string | null {
  const round = run.metadata?.round;
  return typeof round === "string" ? round : null;
}

/**
 * 최근 run 목록에서 job별 최신 완료 run을 찾아 각각 "이번 수집일 것인가"를 판정한다. 순수 함수.
 *
 * - 완료(completed)된 run만 센다. 실패했거나 진행 중인 run은 돌았다고 치지 않는다.
 * - 회차가 있는 job은 kind와 round가 모두 맞는 run만 센다(오전 run이 저녁 누락을 가리면 안 된다).
 * - metadata.kind가 없는 run은 어느 job에도 속하지 않는다. 옛 run이나 수동 실행이 다른 job의
 *   누락을 가려 주면 안 된다.
 */
export function evaluateWatchdogByJob(
  recentRuns: readonly DiscoveryRunRow[],
  now: Date
): JobWatchdogVerdict {
  const completed = recentRuns.filter((run) => run.status === "completed");

  const checks: JobWatchdogCheck[] = WATCHED_JOBS.map((job) => {
    const latest =
      completed
        .filter((run) => runKind(run) === job.kind && (!("round" in job) || runRound(run) === job.round))
        .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at))[0] ?? null;
    return { job, verdict: evaluateWatchdog(latest, now, "dayOffset" in job ? job.dayOffset : 0) };
  });

  const failed = checks.filter((check) => !check.verdict.ok);
  return { ok: failed.length === 0, checks, failed };
}

/** 알림 본문. 어느 job이 안 돌았는지 이름으로 보여준다. ok일 때는 보내지 않으므로 실패 케이스용이다. */
export function formatWatchdogAlert(verdict: JobWatchdogVerdict, now: Date): string {
  const stamp = now.toLocaleString("ko-KR", { timeZone: SEOUL_TZ });
  const lines = [
    "🚨 키워드 수집 감시 알림",
    "",
    `점검 시각: ${stamp} (KST)`,
    `이번 수집일에 돌지 않은 job: ${verdict.failed.map((check) => check.job.label).join(", ")}`,
    "",
  ];

  for (const { job, verdict: v } of verdict.checks) {
    if (v.ok) {
      lines.push(`✅ ${job.label} - run #${v.run.id}`);
    } else if (v.reason === "no_completed_run") {
      lines.push(`❌ ${job.label} - 최근 기록에 완료된 run이 없습니다`);
    } else {
      lines.push(`❌ ${job.label} - 이번 수집일 run 없음 (마지막: run #${v.lastRun.id}, 수집일 ${v.lastRunDate})`);
    }
  }

  lines.push(
    "",
    "확인할 것: Cloudflare Worker 로그의 [cron] 줄(그 시각에 깨어났는지), GitHub Actions에서 해당 워크플로우의 실행 목록과 실패 로그",
  );

  return lines.join("\n");
}

/** 한 번에 읽을 최근 run 수. 하루 4건이므로 열흘이다 - 한 job이 오래 멈췄다면 어차피 경보 대상이다. */
const RECENT_RUNS_LIMIT = 40;

export type RunWatchdogOptions = {
  /** true면 알림을 실제로 보내지 않고 결과만 반환한다. */
  dryRun?: boolean;
  /** 테스트 주입 지점. 생략하면 실제 Supabase 조회. */
  fetchRecent?: () => Promise<DiscoveryRunRow[]>;
  /** 테스트 주입 지점. 생략하면 TelegramNotifier.fromEnv(). */
  send?: (text: string) => Promise<void>;
  /** 테스트 주입 지점. 생략하면 현재 시각. */
  now?: Date;
};

export type RunWatchdogResult = {
  verdict: JobWatchdogVerdict;
  alerted: boolean;
  /** 보낸(혹은 dryRun이면 보낼 예정인) 알림 본문. ok일 땐 undefined. */
  message?: string;
  /** 발송 실패 사유. 이 함수는 알림 발송 실패로 예외를 던지지 않는다. */
  sendError?: string;
};

export async function runWatchdog(options: RunWatchdogOptions = {}): Promise<RunWatchdogResult> {
  const now = options.now ?? new Date();
  const fetchRecent = options.fetchRecent ?? (() => listRecentDiscoveryRuns(RECENT_RUNS_LIMIT));

  const recent = await fetchRecent();
  const verdict = evaluateWatchdogByJob(recent, now);

  if (verdict.ok) {
    return { verdict, alerted: false };
  }

  const message = formatWatchdogAlert(verdict, now);

  if (options.dryRun) {
    return { verdict, alerted: false, message };
  }

  const send = options.send ?? ((text: string) => TelegramNotifier.fromEnv().send(text));
  try {
    await send(message);
    return { verdict, alerted: true, message };
  } catch (error) {
    return {
      verdict,
      alerted: false,
      message,
      sendError: error instanceof Error ? error.message : String(error),
    };
  }
}

// 직접 실행 진입점.
const isDirectRun = process.argv[1]?.endsWith("watchdogJob.ts") || process.argv[1]?.endsWith("watchdogJob.js");
if (isDirectRun) {
  const dryRun = process.argv.includes("--dry-run");
  runWatchdog({ dryRun })
    .then((result) => {
      if (result.verdict.ok) {
        const runs = result.verdict.checks
          .map((check) => (check.verdict.ok ? `${check.job.label} #${check.verdict.run.id}` : check.job.label))
          .join(", ");
        console.log(`✅ [watchdog] 감시 대상 ${result.verdict.checks.length}개 job 모두 이번 수집일에 돌았다 - ${runs}`);
        return;
      }

      console.error(`🚨 [watchdog] 돌지 않은 job: ${result.verdict.failed.map((check) => check.job.label).join(", ")}`);
      if (result.message) console.error(result.message);

      if (result.sendError) {
        console.error(`⚠️ 알림 발송 실패: ${result.sendError}`);
        process.exit(2);
      }
      if (dryRun) {
        console.error("(dry-run: 실제 발송하지 않음)");
      } else {
        console.error("알림 발송 완료.");
      }
      // 감시인이 문제를 찾았다는 것 자체는 CI를 빨갛게 만들어야 눈에 띈다.
      process.exit(1);
    })
    .catch((error) => {
      console.error("❌ [watchdog] 실패:", error instanceof Error ? error.message : error);
      process.exit(3);
    });
}
