// 원고 작성 실패를 텔레그램으로 알린다. 개발 용어(verdict, draft 파일, 경로) 대신 짧은 한글로
// "어떤 키워드가 / 왜 실패했는지"만 보여주고(2026-10-02 사용자 요청), 재시도는 버튼으로 한다.
// 원문 오류는 콘솔 로그와 job.metadata.lastError에 그대로 남는다.

import { readFile } from "node:fs/promises";

import { researchFilePath } from "../../config/pipelinePaths.js";
import { buildResearchDecisionCallbackData } from "../../notifications/researchDecisionCallbackData.js";
import { escapeTelegramHtml, TelegramNotifier } from "../../notifications/TelegramNotifier.js";
import type { TelegramOutgoingMessage } from "../../notifications/TelegramNotifier.js";
import { parseResearchFile } from "../research/parseResearchFile.js";

export type WriteFailureDescription = {
  /** 비개발자가 읽는 한 줄 사유. */
  reason: string;
  /** false면 다시 시도해도 같은 결과라 재시도 버튼을 붙이지 않는다. */
  retryable: boolean;
};

/**
 * 자료조사 파일의 출처 건수로 "어떤 자료가 모자란지"를 말한다(researcher.md verdict 판정 기준과 같다:
 * 전체 5건 미만 / 공식·언론 없이 커뮤니티뿐 / 법률·금융·의료 주제는 공식 자료 2건 이상).
 * 조사 파일을 못 읽으면 null - 호출자가 일반 문구로 대신한다.
 */
export function describeShortage(researchText: string | null | undefined): string | null {
  if (!researchText || researchText.trim().length === 0) return null;
  const { official, medical, news, community } = parseResearchFile(researchText).sourceCounts;
  const total = official + medical + news + community;
  const authoritative = official + medical;
  if (total < 5) return `찾은 자료가 ${total}건뿐이에요.`;
  if (official + medical + news === 0) return "공식 자료나 언론 기사 없이 커뮤니티 글뿐이에요.";
  if (authoritative < 2) return `공식 자료(공공기관·법원 등)가 ${authoritative}건뿐이에요. 2건 이상 있어야 해요.`;
  return null;
}

/** 실패 원문(개발자용)을 쉬운 한글 사유로 바꾼다. 순서가 우선순위다 - blocked가 draft 파일 문구를 함께 담는다. */
export function describeWriteFailure(error: string, researchText?: string | null): WriteFailureDescription {
  if (/blocked/i.test(error)) {
    // 이유만 알린다 - "다시 쓰려면 ~해야 한다" 같은 안내는 덧붙이지 않는다(2026-10-02 사용자 요청).
    const shortage = describeShortage(researchText);
    return { reason: shortage ? `자료가 부족해서 글을 쓰지 않았어요. ${shortage}` : "자료가 부족해서 글을 쓰지 않았어요.", retryable: false };
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

export function buildWriteFailedMessage(
  job: { id: string; keyword: string },
  error: string,
  researchText?: string | null
): TelegramOutgoingMessage {
  const { reason, retryable } = describeWriteFailure(error, researchText);
  const text = ["❌ <b>원고 작성 실패</b>", "", `키워드: <b>${escapeTelegramHtml(job.keyword)}</b>`, `사유: ${escapeTelegramHtml(reason)}`].join("\n");
  return retryable
    ? { text, replyMarkup: { inline_keyboard: [[{ text: "🔄 다시 시도", callback_data: buildResearchDecisionCallbackData("retry", job.id) }]] } }
    : { text };
}

/** 조사 파일 내용: job.metadata에 저장된 것을 먼저 쓰고(클라우드 실행), 없으면 로컬 파일을 읽는다. */
async function loadResearchText(job: { keyword: string; metadata?: Record<string, unknown> | null }): Promise<string | null> {
  const saved = job.metadata?.researchFileContent;
  if (typeof saved === "string" && saved.trim().length > 0) return saved;
  return readFile(researchFilePath(job.keyword), "utf8").catch(() => null);
}

export async function notifyWriteFailed(
  job: { id: string; keyword: string; metadata?: Record<string, unknown> | null },
  error: string
): Promise<void> {
  const researchText = await loadResearchText(job);
  await TelegramNotifier.fromEnv().sendMessages([buildWriteFailedMessage(job, error, researchText)]);
}
