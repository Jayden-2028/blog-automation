// runArticleJob() 성공 결과를 Telegram으로 알린다.
//
// 원고 본문을 함께 보낸다(2026-08-27 실사용 확인 후 추가): 첫 실제 실행에서 사용자가 "원고를 어떻게
// 확인할 수 있어?"라고 물었다 - 처음 설계는 요약(제목/근거 건수/소요 시간)만 보내고 본문은 DB를
// 직접 조회해야 볼 수 있었다. Telegram이 원고를 읽고 판단하는 창구가 되도록 본문 전체를 보낸다.
//
// 의학 주제와 일반 주제의 알림이 다른 이유(SPRINT_2_DESIGN.md 5-2절): 의학 주제는 사람이 본문과
// 출처를 직접 읽고 확인해야 다음 단계로 넘어갈 수 있다(article_jobs.metadata.requiresMedicalReview).
// 본문 끝에는 프롬프트 규칙(buildArticlePrompt.ts §6)에 따라 "참고 자료" 섹션이 이미 출처 링크를
// 담고 있으므로, 알림에서 출처 목록을 따로 다시 만들지 않는다 - 본문을 그대로 보내는 것으로 충분하다.
// 대신 본문을 다 읽은 뒤 누를 수 있도록 [✅ 확인함]/[✏️ 수정 필요]/[🗑 폐기] 버튼을 마지막 메시지에
// 별도로 붙인다.
//
// 일반 주제는 아직 승인 버튼을 달지 않는다. 발행 승인 흐름(모든 원고 공통)은 Sprint 3의 검수
// 게이트가 담당하고, 지금은 원고를 읽을 수 있게 하는 것까지만 한다.

import { buildArticleReviewCallbackData } from "../../notifications/articleReviewCallbackData.js";
import {
  escapeTelegramHtml,
  splitIntoChunks,
  TELEGRAM_MESSAGE_CHAR_LIMIT,
  TelegramNotifier,
} from "../../notifications/TelegramNotifier.js";
import type { TelegramInlineKeyboardButton, TelegramOutgoingMessage } from "../../notifications/TelegramNotifier.js";
import type { ArticleRow } from "../../types/database.js";
import type { RunArticleJobResult } from "./runArticleJob.js";

export type RunArticleJobSuccess = Extract<RunArticleJobResult, { status: "success" }>;

export function buildSourceCountSummary(result: RunArticleJobSuccess): string {
  const counts = { official: 0, medical: 0, news: 0, community: 0 };
  for (const source of result.sources) {
    if (source.authority) counts[source.authority]++;
  }
  return `공공 ${counts.official}건 · 의료 ${counts.medical}건 · 뉴스 ${counts.news}건 · 커뮤니티 ${counts.community}건`;
}

export function buildHeaderMessage(result: RunArticleJobSuccess): TelegramOutgoingMessage {
  const { job, article } = result;

  const lines = result.requiresMedicalReview
    ? ["⚕️ <b>의학 주제 — 원고와 출처를 직접 확인해주세요</b>"]
    : ["📝 <b>원고 초안 준비됨</b>"];

  lines.push(
    "",
    `<b>${escapeTelegramHtml(article.title ?? job.keyword)}</b>`,
    `키워드: ${escapeTelegramHtml(job.keyword)} · category: ${escapeTelegramHtml(job.category ?? "N/A")}`,
    `근거: ${buildSourceCountSummary(result)}`,
    `소요 시간: 조사 ${Math.round(result.durationMs.research / 1000)}초 · 작성 ${Math.round(result.durationMs.writing / 1000)}초`
  );

  if (result.requiresMedicalReview) {
    lines.push("", "아래에 원고 전문을 보냅니다. 본문 끝 '참고 자료' 링크로 출처를 직접 확인해주세요.");
  }

  return { text: lines.join("\n") };
}

/**
 * 원고 본문을 Telegram 메시지로 나눈다. escapeTelegramHtml을 거치는 이유: TelegramNotifier가
 * parse_mode=HTML로 보내는데, 원고 본문에 "<"/">"/"&"가 그대로 들어 있으면(드물지만 있을 수 있다)
 * Telegram API가 400으로 거부해 발송 전체가 실패한다. 원고는 마크다운(##, **)으로 쓰이므로
 * HTML로 렌더링되지는 않지만(글자 그대로 보인다), 발송 실패보다는 읽을 수 있는 상태가 낫다.
 */
export function buildArticleBodyMessages(article: ArticleRow): TelegramOutgoingMessage[] {
  const escaped = escapeTelegramHtml(article.content ?? "(본문 없음)");
  return splitIntoChunks(escaped, TELEGRAM_MESSAGE_CHAR_LIMIT).map((text) => ({ text }));
}

export function buildMedicalDecisionMessage(jobId: string): TelegramOutgoingMessage {
  const buttons: TelegramInlineKeyboardButton[] = [
    { text: "✅ 확인함", callback_data: buildArticleReviewCallbackData("confirm", jobId) },
    { text: "✏️ 수정 필요", callback_data: buildArticleReviewCallbackData("edit", jobId) },
    { text: "🗑 폐기", callback_data: buildArticleReviewCallbackData("discard", jobId) },
  ];
  return {
    text: "위 원고와 출처를 확인하셨다면 아래에서 결정해주세요.",
    replyMarkup: { inline_keyboard: [buttons] },
  };
}

/** 실제 발송한다. 발송 실패는 예외를 던진다 - 원고 생성은 끝났는데 알림만 조용히 실패하면 안 된다. */
export async function notifyArticleReady(result: RunArticleJobSuccess): Promise<void> {
  const messages: TelegramOutgoingMessage[] = [
    buildHeaderMessage(result),
    ...buildArticleBodyMessages(result.article),
  ];

  if (result.requiresMedicalReview) {
    messages.push(buildMedicalDecisionMessage(result.job.id));
  }

  await TelegramNotifier.fromEnv().sendMessages(messages);
}
