// 영어본 재승인 알림(개편3 §4.3-3). 한글 원고 승인 → 영어본 생성 → **영어본 + 한글 대역 요약**을 Telegraph로 보여 주고
// 다시 한 번 승인받는다. 버튼 콜백은 한글 원고 검수와 같은 `review:<action>:<jobId>`를 그대로 쓴다 -
// TelegramBot.handleArticleReviewCallback이 job.metadata.ksceneStage로 "한글 승인"과 "영어본 승인"을 가른다.

import { buildArticleReviewCallbackData } from "../../notifications/articleReviewCallbackData.js";
import { escapeTelegramHtml, splitIntoChunks, TELEGRAM_MESSAGE_CHAR_LIMIT } from "../../notifications/TelegramNotifier.js";
import type { TelegramInlineKeyboardButton, TelegramOutgoingMessage } from "../../notifications/TelegramNotifier.js";
import { notifierForJob } from "../../notifications/notifierForJob.js";
import type { ArticleJobRow } from "../../types/database.js";

/** Telegraph 페이지 본문: 영어 본문 + 한글 대역 요약(문단별 요지). 영어본이 먼저고 요약이 뒤다. */
export function buildEnglishReviewMarkdown(englishBody: string, koSummary: readonly string[]): string {
  return [
    englishBody.trim(),
    "",
    "---",
    "",
    "**한글 대역 요약 (문단별 요지)**",
    "",
    ...koSummary.map((line) => `- ${line}`),
  ].join("\n");
}

export type EnglishReviewNotice = {
  job: Pick<ArticleJobRow, "id" | "keyword" | "metadata">;
  englishTitle: string;
  koreanTitle: string | null;
  telegraphUrl: string | null;
  koSummary: readonly string[];
  /** 수정 요청을 반영한 재번역이면 true. */
  isRevision: boolean;
  /** Telegraph 실패 시 본문 폴백용. */
  englishBody: string;
};

export function buildEnglishReviewButtons(jobId: string): TelegramInlineKeyboardButton[] {
  return [
    { text: "✅ 영어본 승인", callback_data: buildArticleReviewCallbackData("confirm", jobId) },
    { text: "✏️ 수정 필요", callback_data: buildArticleReviewCallbackData("edit", jobId) },
    { text: "🗑 반려", callback_data: buildArticleReviewCallbackData("discard", jobId) },
  ];
}

export function buildEnglishReviewMessages(notice: EnglishReviewNotice): TelegramOutgoingMessage[] {
  const lines = [
    notice.isRevision ? "🌏 <b>영어본 수정 반영됨 — 다시 확인해주세요</b>" : "🌏 <b>영어본 준비됨 — 재승인이 필요합니다</b>",
    "",
    `<b>${escapeTelegramHtml(notice.englishTitle)}</b>`,
    notice.koreanTitle ? `한글: ${escapeTelegramHtml(notice.koreanTitle)}` : null,
    `한글 대역 요약 ${notice.koSummary.length}줄 포함 · 승인하면 이미지 준비 후 발행 버튼이 열립니다`,
  ].filter((line): line is string => line !== null);

  if (!notice.telegraphUrl) lines.push("", "(Telegraph 발행 실패 - 아래에 영어 본문과 한글 요약을 대신 보냅니다)");

  const buttons: TelegramInlineKeyboardButton[][] = [];
  if (notice.telegraphUrl) buttons.push([{ text: "📄 영어본 보기", url: notice.telegraphUrl }]);

  if (notice.telegraphUrl) {
    buttons.push(buildEnglishReviewButtons(notice.job.id));
    return [{ text: lines.join("\n"), replyMarkup: { inline_keyboard: buttons } }];
  }

  const dump = splitIntoChunks(escapeTelegramHtml(buildEnglishReviewMarkdown(notice.englishBody, notice.koSummary)), TELEGRAM_MESSAGE_CHAR_LIMIT).map(
    (text) => ({ text })
  );
  return [
    { text: lines.join("\n") },
    ...dump,
    { text: "위 영어본을 확인하셨다면 아래에서 결정해주세요.", replyMarkup: { inline_keyboard: [buildEnglishReviewButtons(notice.job.id)] } },
  ];
}

export function buildTranslationFailedMessage(job: Pick<ArticleJobRow, "id" | "keyword">, reason: string): TelegramOutgoingMessage {
  return {
    text:
      `⚠️ <b>영어본 생성 실패</b>\n${escapeTelegramHtml(job.keyword)}\n\n` +
      `${escapeTelegramHtml(reason.slice(0, 600))}\n\n` +
      `한글 원고는 승인된 상태로 남아 있습니다. 아래 버튼으로 다시 시도하세요.`,
    replyMarkup: {
      inline_keyboard: [[{ text: "🔁 영어본 다시 만들기", callback_data: buildArticleReviewCallbackData("confirm", job.id) }]],
    },
  };
}

export async function notifyEnglishReview(notice: EnglishReviewNotice): Promise<void> {
  await notifierForJob(notice.job).sendMessages(buildEnglishReviewMessages(notice));
}

export async function notifyTranslationFailed(job: Pick<ArticleJobRow, "id" | "keyword" | "metadata">, reason: string): Promise<void> {
  await notifierForJob(job).sendMessages([buildTranslationFailedMessage(job, reason)]);
}
