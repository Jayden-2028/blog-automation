// 맥미니 자료조사 폴러 - 맥에서만 돈다(2026-11-01, RESEARCH_PROVIDER=codex 전용).
//
// 하는 일 하나: 클라우드가 `metadata.localResearch`에 남긴 조사 요청 1건을 집어 **Codex로** 조사하고,
// 끝나면 집필 단계(Claude, 클라우드)를 발화한다. 대기열이 없으면 조용히 끝난다(DB 조회 1회).
//
// 왜 맥인가: Codex CLI와 ChatGPT 구독 로그인이 맥에만 있다. 구독 로그인은 스스로 갱신되므로
// 토큰 비밀값을 클라우드로 옮길 수도 없다.
//
// **불변식 ①: 이 폴러는 Codex만 돌린다.** runResearchStage에 provider: "codex"를 못 박아 넘기므로
// 맥의 .env에 RESEARCH_PROVIDER가 어떻게 적혀 있든 여기서 Claude 조사가 돌지 않는다. 대기열 표식도
// provider==="codex"가 아니면 읽지 않는다(localResearchQueue.readLocalResearchRequest).
//
// 중복 실행을 두 겹으로 막는다:
//   ① 파일 락(같은 맥의 겹친 launchd 발화) - Codex 1건이 최대 25분이고 폴러는 60초 주기다.
//   ② DB claim(running + claimedAt) - 프로세스가 죽어 락이 사라져도 다음 주기가 같은 job을 다시
//      집지 않는다. 40분을 넘긴 running만 잔재로 보고 다시 집는다.
//
// 실행: npm run job:research-poll  (launchd 1분 주기 권장 - 폴러·plist 등록은 사용자 승인 사항이다)
import "dotenv/config";

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { acquireSingleInstanceLock } from "./lib/singleInstanceLock.js";
import { ArticleJobRepository } from "../repositories/ArticleJobRepository.js";
import {
  claimLocalResearch,
  finishLocalResearch,
  listPendingLocalResearch,
  readLocalResearchRequest,
} from "../workflows/research/localResearchQueue.js";
import { triggerWritingForJob } from "../workflows/research/triggerWriting.js";
import { runResearchStage } from "../workflows/writing/runArticleJob.js";
import { escapeTelegramHtml } from "../notifications/TelegramNotifier.js";
import { notifierForJobId } from "../notifications/notifierForJob.js";

export type ResearchPollDeps = {
  listPending?: typeof listPendingLocalResearch;
  claim?: typeof claimLocalResearch;
  finish?: typeof finishLocalResearch;
  runResearch?: (jobId: string) => ReturnType<typeof runResearchStage>;
  triggerWriting?: (jobId: string) => Promise<void>;
  notifyFailure?: (jobId: string, message: string) => Promise<void>;
};

export type ResearchPollOutcome =
  | { picked: false }
  | { picked: true; jobId: string; status: "success" | "failed" | "skipped"; detail?: string };

/** 한 주기에 1건만 처리한다 - 1건이 최대 25분이고 맥에서 Codex 세션을 겹쳐 돌릴 이유가 없다. */
export async function pollLocalResearchOnce(deps: ResearchPollDeps = {}): Promise<ResearchPollOutcome> {
  const listPending = deps.listPending ?? listPendingLocalResearch;
  const pending = await listPending();
  const next = pending[0];
  if (!next) return { picked: false };

  const request = readLocalResearchRequest(next);
  if (!request) return { picked: false };

  const jobId = next.id;
  await (deps.claim ?? claimLocalResearch)(jobId, request);

  // provider를 못 박아 넘긴다 - 이 폴러가 Claude 조사를 돌릴 수 있는 경로를 만들지 않는다(불변식 ①).
  const runResearch = deps.runResearch ?? ((id: string) => runResearchStage(id, { provider: "codex" }));
  const result = await runResearch(jobId);

  if (result.status === "success") {
    await (deps.finish ?? finishLocalResearch)(jobId, request, { ok: true });
    console.log(
      `✅ [research-poll] Codex 조사 완료: ${jobId} (${Math.round(result.durationMs / 1000)}초, 근거 ${result.sources.length}건, verdict ${result.verdict})`
    );
    // 집필은 Claude 그대로다(클라우드). 토큰이 없으면 맥에서 돌며 warnLocalFallback이 알린다.
    await (deps.triggerWriting ?? triggerWritingForJob)(jobId);
    return { picked: true, jobId, status: "success" };
  }

  if (result.status === "skipped") {
    // 이미 처리된 job(review/approved/...)이면 표식만 내린다 - 다음 주기에 또 집지 않게.
    await (deps.finish ?? finishLocalResearch)(jobId, request, { ok: false, error: `건너뜀: ${result.reason}` });
    console.log(`⏭ [research-poll] 건너뜀: ${jobId} - ${result.reason}`);
    return { picked: true, jobId, status: "skipped", detail: result.reason };
  }

  // **Codex 실패는 Claude로 폴백하지 않는다**(2026-11-01 사용자 결정) - 한도 때문에 켠 스위치라
  // 되돌리면 켠 이유가 사라지고, 맥에서 Claude 조사를 돌리는 것은 금지다. 기존 실패 경로로 떨어뜨린다.
  await (deps.finish ?? finishLocalResearch)(jobId, request, { ok: false, error: result.error });
  console.error(`❌ [research-poll] Codex 조사 실패: ${jobId} - ${result.error}`);
  await (deps.notifyFailure ?? defaultNotifyFailure)(jobId, result.error);
  return { picked: true, jobId, status: "failed", detail: result.error };
}

async function defaultNotifyFailure(jobId: string, message: string): Promise<void> {
  await (await notifierForJobId(jobId))
    .sendMessages([
      {
        text: [
          "❌ <b>자료조사 실패 (Codex · 맥미니)</b>",
          escapeTelegramHtml(message),
          "",
          "Claude로 자동 폴백하지 않습니다 - 다시 시도하려면 텔레그램에서 다시 선택하거나",
          `<code>npm run job:research-poll</code> 대기열에 다시 올려주세요 (job ${jobId})`,
        ].join("\n"),
      },
    ])
    .catch(() => {});
}

async function main(): Promise<void> {
  const jobId = process.argv[2];
  if (jobId && !jobId.startsWith("--")) {
    // 수동 보조 경로: 대기열을 보지 않고 이 job을 Codex로 지금 조사한다(복구·검증용).
    console.log(`▶ [research-poll] 수동 실행: ${jobId} (provider=codex)`);
    const result = await runResearchStage(jobId, { provider: "codex" });
    if (result.status !== "success") {
      console.error(`❌ ${result.status === "failed" ? result.error : result.reason}`);
      process.exitCode = 1;
      return;
    }
    console.log(`✅ 완료 (${Math.round(result.durationMs / 1000)}초, verdict ${result.verdict}) - ${result.researchFilePath}`);
    return;
  }

  // staleMs 기본(15분)은 Codex 1건(최대 25분)보다 짧다 - 돌고 있는 조사 위에 두 번째가 뜨면 안 된다.
  const lock = acquireSingleInstanceLock(resolve("logs/.research-poll.lock"), { staleMs: 45 * 60 * 1000 });
  if (!lock) return;
  try {
    const outcome = await pollLocalResearchOnce();
    if (!outcome.picked) return; // 대기 없음 - 조용히 종료
  } finally {
    lock.release();
  }
}

// 테스트가 이 파일을 import해도 폴러가 돌지 않게 한다(npm run job:research-poll로 직접 실행할 때만).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`❌ [research-poll] ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}

