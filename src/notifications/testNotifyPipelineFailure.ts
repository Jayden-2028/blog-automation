// 파이프라인 실패 알림 테스트.
//
// 기본은 dry-run + 주입 발송이라 실제 Telegram으로 보내지 않는다.
// 실제 채팅방에 도착하는지까지 확인하려면 `SEND=1 npm run test:failure-notification`으로 실행한다
// (test:notification과 같은 관례). 무인 job의 실패 알림은 "정말 오는가"를 한 번은 눈으로
// 확인해둬야 의미가 있다.

import "dotenv/config";

import {
  buildPipelineFailureMessage,
  formatStageSummary,
  notifyPipelineFailure,
} from "./notifyPipelineFailure.js";
import type { DailyKeywordStageLogEntry } from "../workflows/dailyKeywordWorkflow.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const shouldActuallySend = process.env.SEND === "1";

// 실제로 일어날 법한 실패 시나리오: Creator Advisor는 비치명적으로 실패하고, collect 단계에서
// NAVER API가 죽어 파이프라인이 멈춘 상황.
const STAGE_LOG: DailyKeywordStageLogEntry[] = [
  { stage: "trendCollect", status: "failed", durationMs: 4200, error: "로그인이 필요합니다" },
  { stage: "seed", status: "success", durationMs: 118 },
  { stage: "collect", status: "failed", durationMs: 30_142, error: "NAVER API 요청 실패: 429 Too Many Requests" },
  { stage: "relevance", status: "skipped", durationMs: 0 },
  { stage: "cluster", status: "skipped", durationMs: 0 },
  { stage: "rank", status: "skipped", durationMs: 0 },
  { stage: "save", status: "skipped", durationMs: 0 },
  { stage: "notify", status: "skipped", durationMs: 0 },
];

async function main(): Promise<void> {
  console.log("▶ 실패 알림 테스트 시작");
  console.log(`모드: ${shouldActuallySend ? "실제 발송(SEND=1)" : "dry-run(기본값, 발송 안 함)"}\n`);

  // 1) 메시지에 실패 단계와 사유가 빠짐없이 들어가야 한다 - 폰으로 이것만 보고 원인을 짚어야 하므로.
  const message = buildPipelineFailureMessage("\"collect\" 단계 실패: NAVER API 요청 실패", STAGE_LOG);
  assert(message.includes("파이프라인 실패"), "제목이 있어야 한다");
  assert(message.includes("429"), "실패 사유 원문이 보존되어야 한다");
  assert(message.includes("trendCollect"), "비치명적 실패 단계도 보여야 한다");
  assert(message.includes("collect"), "치명적 실패 단계가 보여야 한다");
  console.log("✅ 메시지에 실패 단계/사유 포함 확인");

  // 2) 단계 상태가 기호로 구분되어야 한다.
  const summary = formatStageSummary(STAGE_LOG);
  assert(summary.includes("❌ collect"), "실패 단계는 ❌로 표시되어야 한다");
  assert(summary.includes("✅ seed"), "성공 단계는 ✅로 표시되어야 한다");
  assert(summary.includes("⏭️ rank"), "건너뛴 단계는 ⏭️로 표시되어야 한다");
  assert(formatStageSummary([]).includes("단계 기록 없음"), "빈 stageLog도 처리해야 한다");
  console.log("✅ 단계별 상태 기호 구분 확인");

  // 3) 발송이 실패해도 예외가 밖으로 새면 안 된다 - 원래 파이프라인 오류를 가리기 때문.
  const failed = await notifyPipelineFailure("테스트", STAGE_LOG, {
    send: async () => {
      throw new Error("Telegram 401 Unauthorized");
    },
  });
  assert(failed.sent === false, "발송 실패 시 sent=false여야 한다");
  assert(failed.error?.includes("401"), `발송 실패 사유가 보존되어야 한다 (실제: ${failed.error})`);
  console.log("✅ 발송 실패 -> 예외 없이 error로 격리");

  // 4) 정상 경로: 주입한 send가 정확히 1번 호출되어야 한다.
  let sentText: string | null = null;
  const ok = await notifyPipelineFailure("테스트", STAGE_LOG, {
    send: async (text) => {
      sentText = text;
    },
  });
  assert(ok.sent === true, "정상 경로에서는 sent=true여야 한다");
  assert(sentText !== null, "send가 호출되어야 한다");
  console.log("✅ 정상 경로 발송 확인");

  if (!shouldActuallySend) {
    console.log("\n▶ 실제로 보낼 메시지 미리보기\n");
    console.log(message);
    console.log("\n✅ 실패 알림 테스트 완료 (실제 발송 없음)");
    return;
  }

  const real = await notifyPipelineFailure(
    "[테스트] 실패 알림 경로 검증용입니다. 실제 장애가 아닙니다.",
    STAGE_LOG
  );
  assert(real.sent, `실제 발송에 실패했습니다: ${real.error}`);
  console.log("\n✅ 실제 Telegram 발송 완료 - 채팅방에서 확인하세요");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
