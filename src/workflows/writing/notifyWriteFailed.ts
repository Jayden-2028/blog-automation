// 원고 작성 실패를 텔레그램으로 알린다. 개발 용어(verdict, draft 파일, 경로) 대신 짧은 한글로
// "어떤 키워드가 / 왜 실패했는지"만 보여주고(2026-10-02 사용자 요청), 재시도는 버튼으로 한다.
// 원문 오류는 콘솔 로그와 job.metadata.lastError에 그대로 남는다.

import { buildResearchDecisionCallbackData } from "../../notifications/researchDecisionCallbackData.js";
import { escapeTelegramHtml, TelegramNotifier } from "../../notifications/TelegramNotifier.js";
import type { TelegramOutgoingMessage } from "../../notifications/TelegramNotifier.js";

export type WriteFailureDescription = {
  /** 비개발자가 읽는 한 줄 사유. */
  reason: string;
  /** false면 다시 시도해도 같은 결과라 재시도 버튼을 붙이지 않는다. */
  retryable: boolean;
};

/** 실패 원문(개발자용)을 쉬운 한글 사유로 바꾼다. 순서가 우선순위다 - blocked가 draft 파일 문구를 함께 담는다. */
export function describeWriteFailure(error: string): WriteFailureDescription {
  if (/blocked/i.test(error)) {
    return { reason: "자료가 부족해서 글을 쓰지 않았어요. 자료조사를 보강해야 다시 쓸 수 있어요.", retryable: false };
  }
  if (/안에 끝나지 않|timeout|timed out|시간 초과/i.test(error)) {
    return { reason: "글 작성이 너무 오래 걸려 중단됐어요.", retryable: true };
  }
  if (/한도|limit|rate|quota/i.test(error)) {
    return { reason: "AI 사용 한도에 걸린 것 같아요. 잠시 뒤에 다시 시도해 주세요.", retryable: true };
  }
  if (/종료 코드|빈 출력|실행 실패/.test(error)) {
    return { reason: "글쓰기 AI가 응답하지 않았어요.", retryable: true };
  }
  if (/^\[research\]|자료조사/.test(error)) {
    return { reason: "자료조사 단계에서 문제가 생겼어요.", retryable: true };
  }
  if (/draft 파일을 만들지/.test(error)) {
    return { reason: "원고가 만들어지지 않았어요.", retryable: true };
  }
  return { reason: "알 수 없는 문제가 생겼어요. 잠시 뒤에 다시 시도해 주세요.", retryable: true };
}

export function buildWriteFailedMessage(job: { id: string; keyword: string }, error: string): TelegramOutgoingMessage {
  const { reason, retryable } = describeWriteFailure(error);
  const text = ["❌ <b>원고 작성 실패</b>", "", `키워드: <b>${escapeTelegramHtml(job.keyword)}</b>`, `사유: ${escapeTelegramHtml(reason)}`].join("\n");
  return retryable
    ? { text, replyMarkup: { inline_keyboard: [[{ text: "🔄 다시 시도", callback_data: buildResearchDecisionCallbackData("retry", job.id) }]] } }
    : { text };
}

export async function notifyWriteFailed(job: { id: string; keyword: string }, error: string): Promise<void> {
  await TelegramNotifier.fromEnv().sendMessages([buildWriteFailedMessage(job, error)]);
}
