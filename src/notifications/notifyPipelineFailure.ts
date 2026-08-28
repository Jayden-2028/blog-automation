// 파이프라인 실패를 Telegram으로 알린다.
//
// 왜 별도 모듈인가: 원래 jobs/dailyKeywordJob.ts 안에 있었는데, 그 파일은 import되는 순간
// 스케줄러가 job을 실행하는 진입점이라 테스트에서 import할 수 없었다. 그 결과 "실패했을 때 알림이
// 실제로 가는지"를 검증할 방법이 없었다 - 매일 무인으로 도는 시스템에서 알림 경로가 미검증인 것은
// 알림이 없는 것과 크게 다르지 않으므로 분리했다.
//
// 설계 원칙: 이 함수는 절대 예외를 밖으로 던지지 않는다. 알림 발송 실패가 원래 파이프라인 오류를
// 가려서는 안 되고, Telegram 자격증명이 없는 환경에서도 job이 같은 방식으로 끝나야 하기 때문이다.

import { TelegramNotifier } from "./TelegramNotifier.js";
import type { DailyKeywordStageLogEntry } from "../workflows/dailyKeywordWorkflow.js";

export type NotifyPipelineFailureOptions = {
  /** true면 실제로 보내지 않고 만들어진 메시지만 반환한다. */
  dryRun?: boolean;
  /** 테스트에서 발송 함수를 주입하는 지점. 생략하면 TelegramNotifier.fromEnv(). */
  send?: (text: string) => Promise<void>;
};

export type NotifyPipelineFailureResult = {
  sent: boolean;
  /** 실제로 보낸(혹은 dryRun이면 보낼 예정인) 메시지 본문. */
  message: string;
  /** 발송에 실패했을 때의 사유. 이 함수는 예외를 던지지 않으므로 여기로만 알린다. */
  error?: string;
};

/** stageLog를 사람이 읽을 수 있는 요약으로 만든다. */
export function formatStageSummary(stageLog: DailyKeywordStageLogEntry[]): string {
  if (stageLog.length === 0) return "  (단계 기록 없음)";

  return stageLog
    .map((entry) => {
      const mark = entry.status === "success" ? "✅" : entry.status === "failed" ? "❌" : "⏭️";
      const detail = entry.error ? ` - ${entry.error}` : "";
      return `  ${mark} ${entry.stage}: ${entry.status}${detail}`;
    })
    .join("\n");
}

export function buildPipelineFailureMessage(
  reason: string,
  stageLog: DailyKeywordStageLogEntry[]
): string {
  const now = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
  return (
    `🚨 <b>블로그 자동화 파이프라인 실패</b>\n` +
    `${now}\n\n` +
    `${reason}\n\n` +
    `<b>단계별 결과</b>\n${formatStageSummary(stageLog)}`
  );
}

/**
 * 실패 알림을 발송한다. 발송 자체가 실패해도 예외를 던지지 않고 result.error로만 알린다.
 */
export async function notifyPipelineFailure(
  reason: string,
  stageLog: DailyKeywordStageLogEntry[],
  options: NotifyPipelineFailureOptions = {}
): Promise<NotifyPipelineFailureResult> {
  const message = buildPipelineFailureMessage(reason, stageLog);

  if (options.dryRun) {
    return { sent: false, message };
  }

  try {
    const send = options.send ?? ((text: string) => TelegramNotifier.fromEnv().send(text));
    await send(message);
    console.log("ℹ️ 실패 알림을 Telegram으로 발송했습니다.");
    return { sent: true, message };
  } catch (error) {
    const reasonText = error instanceof Error ? error.message : String(error);
    console.error("⚠️ 실패 알림 발송에 실패했습니다 -", reasonText);
    return { sent: false, message, error: reasonText };
  }
}
