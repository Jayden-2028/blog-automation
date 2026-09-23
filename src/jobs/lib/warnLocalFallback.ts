// 조사·집필이 **맥에서** 돌게 될 때 알린다(2026-09-24).
//
// 왜 필요한가: 분기가 `GITHUB_TOKEN이 있으면 GitHub Actions, 없으면 맥에서 detached 프로세스`인데
// (triggerResearch.ts / runResearchStageCli.ts), 없는 쪽으로 떨어져도 **아무 말이 없다**. 맥에서
// 도는 프로세스는 맥이 잠들면 통째로 죽으므로 job이 researching/writing에 멈춘 채 남는다.
//
// 2026-09-23~24에 같은 함정에 두 번 걸렸다.
//   1) 토큰이 아예 없었다 - job 4건이 정지한 것을 사람이 먼저 발견했고, 원인을 찾는 데 한참 걸렸다.
//   2) 토큰이 무효였다(복사가 잘려 Bad credentials) - 형식은 멀쩡해 보여 더 헷갈렸다.
// 둘 다 증상을 보고 거슬러 올라가서야 원인을 알았다. 떨어지는 순간에 말해 주면 그럴 일이 없다.
//
// 알림은 조인다. 토큰이 계속 없으면 job마다 알림이 쌓여 소음이 되고, 소음이 되면 사람이 안 본다.
// telegramPollJob.ts의 실패 알림과 같은 방식(마커 파일 + 시간 창)을 쓴다.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { TelegramNotifier } from "../../notifications/TelegramNotifier.js";

const MARKER = resolve("logs/.cloud-fallback-alerted");
const THROTTLE_MS = 6 * 60 * 60 * 1000;

export type FallbackStage = "research" | "write";

const STAGE_LABEL: Record<FallbackStage, string> = {
  research: "자료조사",
  write: "집필",
};

/** 한글 목적격 조사. 받침이 있으면 "을", 없으면 "를"("자료조사를" / "집필을"). */
function objectParticle(word: string): string {
  const last = word.charCodeAt(word.length - 1);
  if (last < 0xac00 || last > 0xd7a3) return "을";
  return (last - 0xac00) % 28 === 0 ? "를" : "을";
}

function recentlyAlerted(now: number): boolean {
  try {
    if (!existsSync(MARKER)) return false;
    const last = Number(readFileSync(MARKER, "utf8").trim());
    return Number.isFinite(last) && now - last < THROTTLE_MS;
  } catch {
    // 마커를 못 읽으면 알림을 보내는 쪽으로 간다 - 놓치는 것보다 낫다.
    return false;
  }
}

export type WarnDeps = {
  notify?: (text: string) => Promise<void>;
  now?: () => number;
  /** 테스트에서 마커 파일을 건드리지 않게 갈아끼운다. */
  wasRecentlyAlerted?: (now: number) => boolean;
  markAlerted?: (now: number) => void;
};

/**
 * 클라우드로 못 보내고 맥에서 돌리게 됐음을 알린다.
 *
 * 알림 실패가 파이프라인을 막지 않는다 - 어차피 job은 맥에서라도 돌기 시작한다. 여기서 던지면
 * 알림 하나 때문에 조사가 발화되지 않는 더 나쁜 상황이 된다.
 */
export async function warnLocalFallback(
  stage: FallbackStage,
  jobId: string,
  deps: WarnDeps = {}
): Promise<void> {
  const now = (deps.now ?? (() => Date.now()))();
  const label = STAGE_LABEL[stage];

  // stdout은 launchd 로그에 남는다. 알림을 조이더라도 이건 매번 찍는다.
  console.warn(
    `⚠️ [${stage}] GITHUB_TOKEN이 없어 ${label}${objectParticle(label)} 맥에서 돌립니다` +
      ` - 맥이 잠들면 중단됩니다 (job ${jobId})`
  );

  const wasRecent = deps.wasRecentlyAlerted ?? recentlyAlerted;
  if (wasRecent(now)) return;

  const notify =
    deps.notify ??
    (async (text: string) => {
      await TelegramNotifier.fromEnv().sendMessages([{ text }]);
    });

  await notify(
    [
      "⚠️ <b>클라우드로 못 넘겼습니다 - 맥에서 돕니다</b>",
      "",
      `${label} 단계가 GitHub Actions가 아니라 이 맥에서 돌고 있습니다.`,
      "<b>맥이 잠들면 그 작업은 통째로 죽습니다.</b>",
      "",
      "원인은 <code>GITHUB_TOKEN</code>입니다 - 없거나 만료됐습니다.",
      "확인:",
      "<code>cd ~/blog-automation/prod && npx tsx -e 'import \"dotenv/config\"; console.log(process.env.GITHUB_TOKEN?.slice(0,11) ?? \"없음\")'</code>",
      "",
      `job ${jobId}`,
      "(같은 알림은 6시간에 한 번만 보냅니다)",
    ].join("\n")
  ).catch(() => {
    // 알림 실패는 삼킨다 - job은 계속 가야 한다.
  });

  const mark = deps.markAlerted ?? ((at: number) => writeFileSync(MARKER, String(at), "utf8"));
  try {
    mark(now);
  } catch {
    // 마커를 못 쓰면 다음에 또 알린다. 소음이 되더라도 놓치는 것보다 낫다.
  }
}
