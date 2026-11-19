// 맥미니 제미나이 그림자 폴러(2026-11-19) - **맥에서만** 돈다. 사용자의 Google AI 구독 로그인(agy)이 맥미니에만 있다.
//
// 하는 일 하나: 클라우드가 job.metadata.geminiShadow.requestedAt으로 남긴 대기 1건을 집어 agy로 조사+집필하고,
// 결과를 같은 키에 저장한 뒤 (원고 페이지가 이미 있으면) 페이지 갱신을 발화하고 텔레그램 한 통을 보낸다.
// 대기열이 없으면 조용히 끝난다(DB 조회 1회). Codex 조사 폴러(researchPollJob.ts)와 같은 구조다.
//
// 중복 실행: ① 파일 락(같은 맥의 겹친 launchd 발화 - 1건이 최대 30분이다) ② DB claim(startedAt+claimId를 적고 다시 읽어
// 확인). 40분 넘게 안 끝난 진행 표식은 잔재로 보고 1회만 다시 집고, 그래도 안 끝나면 실패로 닫는다.
//
// 실행: npm run job:gemini-person-poll            (launchd 2분 주기 - scripts/macmini/poll-gemini-person.sh)
//       npm run job:gemini-person-poll -- <jobId> [--force]   (수동: 대기열을 보지 않고 그 job을 지금 돌린다)
// 로그인이 풀리면 geminiShadow.error에 "맥미니 agy 로그인 필요"가 남고 텔레그램으로 알린다.
import "dotenv/config";

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { cloudflarePagesUrl } from "../config/manuscriptsPageTargets.js";
import { viewerPageLink } from "../config/manuscriptViewerPages.js";
import { isGeminiPersonShadowEnabled } from "../config/geminiPerson.js";
import { notifierForJob } from "../notifications/notifierForJob.js";
import type { TelegramInlineKeyboardButton } from "../notifications/TelegramNotifier.js";
import { trackOfJob } from "../notifications/telegramTracks.js";
import { dispatchGithubWorkflow } from "../services/github/dispatchWorkflow.js";
import { supabase } from "../services/supabase/client.js";
import { claimGeminiShadow, closeExhausted, loadShadowRows, pickDue } from "../workflows/gemini-person/geminiShadowQueue.js";
import type { PendingRow, QueueDeps } from "../workflows/gemini-person/geminiShadowQueue.js";
import { runGeminiPerson } from "../workflows/gemini-person/runGeminiPerson.js";
import type { GeminiPersonDeps, GeminiPersonResult } from "../workflows/gemini-person/runGeminiPerson.js";
import { acquireSingleInstanceLock } from "./lib/singleInstanceLock.js";

export type GeminiPollDeps = {
  isEnabled?: () => boolean;
  loadRows?: () => Promise<PendingRow[]>;
  queue?: QueueDeps;
  claim?: typeof claimGeminiShadow;
  closeStale?: typeof closeExhausted;
  run?: (jobId: string) => Promise<GeminiPersonResult>;
  now?: () => Date;
};

export type GeminiPollOutcome =
  | { picked: false; reason?: string }
  | { picked: true; jobId: string; status: GeminiPersonResult["status"] | "lost_claim" | "closed_exhausted"; detail?: string };

/** 실제 환경 배선: 페이지 갱신(토큰 있을 때만)·텔레그램(트랙 봇)·뷰어 행 조회. */
export function realRunDeps(): GeminiPersonDeps {
  return {
    hasManifestEntry: async (id) => {
      const { data, error } = await supabase.from("manuscript_manifest_topics").select("job_id").eq("job_id", id).maybeSingle();
      if (error) throw error;
      return Boolean(data);
    },
    // researchPollJob의 triggerWriting과 같은 전제: 맥미니 .env에 GITHUB_TOKEN(+GITHUB_REPOSITORY)이 있어야 발화한다.
    dispatchRefresh: async () => {
      if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_REPOSITORY) return "no_token";
      await dispatchGithubWorkflow({ workflowFile: "manuscripts-refresh.yml", inputs: {} });
      return "dispatched";
    },
    pageUrlFor: (job) => {
      const base = cloudflarePagesUrl();
      return base ? viewerPageLink(base, trackOfJob(job), job.id) : null;
    },
    notify: async (job, text, pageUrl) => {
      const rows: TelegramInlineKeyboardButton[][] = pageUrl ? [[{ text: "📄 원고 페이지 열기", url: pageUrl }]] : [];
      await notifierForJob(job).sendMessages([{ text, replyMarkup: rows.length > 0 ? { inline_keyboard: rows } : undefined }]);
    },
  };
}

/** 한 주기에 1건만 처리한다 - 1건이 최대 30분이고 맥에서 agy 세션을 겹쳐 돌릴 이유가 없다. */
export async function pollGeminiPersonOnce(deps: GeminiPollDeps = {}): Promise<GeminiPollOutcome> {
  if (!(deps.isEnabled ?? (() => isGeminiPersonShadowEnabled()))()) return { picked: false, reason: "switch_off" };
  const now = deps.now ?? (() => new Date());
  const due = pickDue(await (deps.loadRows ?? (() => loadShadowRows()))(), now());
  if (!due) return { picked: false };

  if (due.kind === "exhausted") {
    await (deps.closeStale ?? closeExhausted)(due.id, deps.queue);
    return { picked: true, jobId: due.id, status: "closed_exhausted" };
  }
  const won = await (deps.claim ?? claimGeminiShadow)(due.id, deps.queue);
  if (!won) return { picked: true, jobId: due.id, status: "lost_claim" };

  const run = deps.run ?? ((id: string) => runGeminiPerson(id, {}, realRunDeps()));
  const result = await run(due.id);
  return { picked: true, jobId: due.id, status: result.status, detail: result.status === "failed" ? result.error : result.status === "skipped" ? result.reason : undefined };
}

async function main(): Promise<void> {
  const jobId = process.argv[2];
  if (jobId && !jobId.startsWith("--")) {
    const force = process.argv.includes("--force");
    console.log(`▶ [gemini-person] 수동 실행: ${jobId}${force ? " (force)" : ""}`);
    const result = await runGeminiPerson(jobId, { force }, realRunDeps());
    if (result.status === "done") console.log(`✅ 완료 - "${result.shadow.title}" (${result.shadow.body?.length ?? 0}자, 페이지 갱신: ${result.refresh})`);
    else if (result.status === "failed") {
      console.error(`❌ 실패: ${result.error}`);
      process.exitCode = 1;
    } else console.log(`· 건너뜀: ${result.reason}`);
    return;
  }

  // 1건 최대 30분(호출 2 x 15분) - 락 stale은 그보다 길게 둔다. 짧으면 돌고 있는 위에 두 번째가 뜬다.
  const lock = acquireSingleInstanceLock(resolve("logs/.gemini-person-poll.lock"), { staleMs: 50 * 60 * 1000 });
  if (!lock) return;
  try {
    const outcome = await pollGeminiPersonOnce();
    if (!outcome.picked) return; // 대기 없음 - 조용히 종료
    console.log(`[gemini-person-poll] ${outcome.jobId}: ${outcome.status}${outcome.detail ? ` - ${outcome.detail}` : ""}`);
  } finally {
    lock.release();
  }
}

// 테스트가 이 파일을 import해도 폴러가 돌지 않게 한다.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`❌ [gemini-person-poll] ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
