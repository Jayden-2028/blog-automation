// 맥미니 scenepick 폴러(2026-11-21) - **맥에서만** 돈다. Codex CLI와 사용자의 ChatGPT 구독 로그인이 맥미니에만 있다.
//
// 하는 일 하나: 사회 봇으로 접수된 주제(job.metadata.scenepickCodex.status=requested) 1건을 집어 Codex에 원고·이미지를 발주하고,
// 형식 검사 -> 업로드 -> 뷰어(scenepick.html) 반영 -> 사회 봇 알림까지 끝낸다(workflows/scenepick/runScenepickJob.ts).
// 대기열이 없으면 조용히 끝난다(DB 조회 1회). 제미나이 인물 폴러(geminiPersonPollJob.ts)와 같은 구조다.
//
// 중복 실행: ① 파일 락(같은 맥의 겹친 launchd 발화 - 1건이 최대 80분이다) ② DB claim(claimId를 적고 다시 읽어 확인).
// 60분 넘게 심장 박동이 없는 running은 잔재로 보고 1회만 다시 집고, 그래도 안 끝나면 실패로 닫는다.
//
// 실행: npm run job:scenepick-poll                      (launchd 2분 주기 - scripts/macmini/poll-scenepick.sh)
//       npm run job:scenepick-poll -- <jobId> [--force]  (수동: 대기열을 보지 않고 그 job을 지금 돌린다. --force는 끝난 job도)
import "dotenv/config";

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { cloudflarePagesUrl } from "../config/manuscriptsPageTargets.js";
import { viewerPageLink } from "../config/manuscriptViewerPages.js";
import { notifierForJob } from "../notifications/notifierForJob.js";
import type { TelegramInlineKeyboardButton } from "../notifications/TelegramNotifier.js";
import { ArticleJobRepository } from "../repositories/ArticleJobRepository.js";
import { dispatchGithubWorkflow } from "../services/github/dispatchWorkflow.js";
import { runCodexWorkspace } from "../services/llm/runCodexWorkspace.js";
import { uploadArticleImage } from "../services/supabase/storage/uploadArticleImage.js";
import { saveManifest } from "../workflows/manuscripts/manuscriptManifest.js";
import { runScenepickJob } from "../workflows/scenepick/runScenepickJob.js";
import type { ScenepickRunDeps, ScenepickRunResult } from "../workflows/scenepick/runScenepickJob.js";
import { failedMessage } from "../workflows/scenepick/runScenepickJob.js";
import { claimScenepick, EXHAUSTED_MESSAGE, loadScenepickRows, patchScenepickState, pickScenepickDue } from "../workflows/scenepick/scenepickQueue.js";
import type { ScenepickPendingRow, ScenepickQueueDeps } from "../workflows/scenepick/scenepickQueue.js";
import { validateScenepickDelivery } from "../workflows/scenepick/validateScenepickDelivery.js";
import { acquireSingleInstanceLock } from "./lib/singleInstanceLock.js";

/** 실제 환경 배선. */
export function realScenepickDeps(): ScenepickRunDeps {
  return {
    findJob: (id) => ArticleJobRepository.findById(id),
    mergeMetadata: (id, patch) => ArticleJobRepository.mergeMetadata(id, patch),
    updateStatus: (id, status) => ArticleJobRepository.updateStatus(id, status),
    runCodex: (options) => runCodexWorkspace(options),
    validate: (dir) => validateScenepickDelivery(dir),
    uploadImage: (input) => uploadArticleImage(input),
    // **이 원고 한 행만** 저장한다 - loadManifest()로 전부 읽어 다시 쓰면 618행 upsert가 8초 statement timeout에 걸린다(2026-11-20).
    saveTopic: (topic) => saveManifest({ topics: [topic] }),
    // 맥미니 .env에 GITHUB_TOKEN(+GITHUB_REPOSITORY)이 있어야 발화한다(geminiPersonPollJob·researchPollJob과 같은 전제).
    dispatchRefresh: async () => {
      if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_REPOSITORY) return "no_token";
      await dispatchGithubWorkflow({ workflowFile: "manuscripts-refresh.yml", inputs: {} });
      return "dispatched";
    },
    pageUrlFor: (jobId) => {
      const base = cloudflarePagesUrl();
      return base ? viewerPageLink(base, "scenepick", jobId) : null;
    },
    // 알림은 job 트랙의 봇으로 간다 - scenepick은 사회 봇(telegramTracks.ts TRACK_ENV_KEYS).
    notify: async (job, text, pageUrl) => {
      const rows: TelegramInlineKeyboardButton[][] = pageUrl ? [[{ text: "📄 원고 페이지 열기", url: pageUrl }]] : [];
      await notifierForJob(job).sendMessages([{ text, replyMarkup: rows.length > 0 ? { inline_keyboard: rows } : undefined }]);
    },
  };
}

export type ScenepickPollDeps = {
  loadRows?: () => Promise<ScenepickPendingRow[]>;
  queue?: ScenepickQueueDeps;
  claim?: typeof claimScenepick;
  /** 재집기 한도를 넘긴 잔재를 실패로 닫는다. */
  closeExhausted?: (jobId: string) => Promise<void>;
  run?: (jobId: string) => Promise<ScenepickRunResult>;
  now?: () => Date;
};

export type ScenepickPollOutcome =
  | { picked: false }
  | { picked: true; jobId: string; status: ScenepickRunResult["status"] | "lost_claim" | "closed_exhausted"; detail?: string };

async function closeExhaustedReal(jobId: string): Promise<void> {
  const deps = realScenepickDeps();
  const at = new Date().toISOString();
  await patchScenepickState(jobId, { status: "failed", error: EXHAUSTED_MESSAGE, finishedAt: at });
  await deps.mergeMetadata(jobId, { rejectedAt: at });
  await deps.updateStatus(jobId, "rejected");
  const job = await deps.findJob(jobId);
  if (job) await deps.notify(job, failedMessage(job.keyword, EXHAUSTED_MESSAGE), null).catch(() => {});
}

/** 한 주기에 1건만 처리한다 - 1건이 최대 80분(40분 x 2회)이고 맥에서 Codex 세션을 겹쳐 돌릴 이유가 없다. */
export async function pollScenepickOnce(deps: ScenepickPollDeps = {}): Promise<ScenepickPollOutcome> {
  const now = deps.now ?? (() => new Date());
  const due = pickScenepickDue(await (deps.loadRows ?? (() => loadScenepickRows()))(), now());
  if (!due) return { picked: false };

  if (due.kind === "exhausted") {
    await (deps.closeExhausted ?? closeExhaustedReal)(due.id);
    return { picked: true, jobId: due.id, status: "closed_exhausted" };
  }
  const won = await (deps.claim ?? claimScenepick)(due.id, deps.queue);
  if (!won) return { picked: true, jobId: due.id, status: "lost_claim" };

  const run = deps.run ?? ((id: string) => runScenepickJob(id, realScenepickDeps()));
  const result = await run(due.id);
  return {
    picked: true,
    jobId: due.id,
    status: result.status,
    detail: result.status === "failed" ? result.error : result.status === "skipped" ? result.reason : result.title,
  };
}

async function main(): Promise<void> {
  const jobId = process.argv[2];
  if (jobId && !jobId.startsWith("--")) {
    const force = process.argv.includes("--force");
    console.log(`▶ [scenepick] 수동 실행: ${jobId}${force ? " (force)" : ""}`);
    const result = await runScenepickJob(jobId, realScenepickDeps(), { force });
    if (result.status === "done") console.log(`✅ 완료 - "${result.title}" (${result.category}, 이미지 ${result.imageCount}장, Codex ${result.attempts}회, 페이지 갱신: ${result.refresh})`);
    else if (result.status === "failed") {
      console.error(`❌ 실패: ${result.error}`);
      process.exitCode = 1;
    } else console.log(`· 건너뜀: ${result.reason}`);
    return;
  }

  // 1건 최대 80분(Codex 40분 x 2회) + 업로드 - 락 stale은 그보다 길게 둔다. 짧으면 돌고 있는 위에 두 번째가 뜬다.
  const lock = acquireSingleInstanceLock(resolve("logs/.scenepick-poll.lock"), { staleMs: 100 * 60 * 1000 });
  if (!lock) return;
  try {
    const outcome = await pollScenepickOnce();
    if (!outcome.picked) return; // 대기 없음 - 조용히 종료
    console.log(`[scenepick-poll] ${outcome.jobId}: ${outcome.status}${outcome.detail ? ` - ${outcome.detail}` : ""}`);
  } finally {
    lock.release();
  }
}

// 테스트가 이 파일을 import해도 폴러가 돌지 않게 한다.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`❌ [scenepick-poll] ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
