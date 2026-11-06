// reviseArticleWithFeedback() 성공 결과를 Telegram으로 알린다(notifyArticleReady.ts와 같은
// 패턴 - 결정 버튼(승인/수정 필요/반려)을 재사용해, 재작성본도 최초 작성본과 동일한 검수를 거친다).

import { escapeTelegramHtml } from "../../notifications/TelegramNotifier.js";
import { notifierForJob } from "../../notifications/notifierForJob.js";
import { trackOfJob } from "../../notifications/telegramTracks.js";
import type { TelegramOutgoingMessage } from "../../notifications/TelegramNotifier.js";
import { buildArticleBodyMessages, buildReviewDecisionButtons, buildReviewDecisionMessage } from "./notifyArticleReady.js";
import type { ArticleJobRow, ArticleRow } from "../../types/database.js";

export function buildRevisedHeaderMessage(
  job: ArticleJobRow,
  article: ArticleRow,
  feedback: string,
  telegraphUrl: string | null,
  /** 보충 조사 결과 줄(2026-11-06). 못 찾은 항목이 여기서 사용자에게 보인다. */
  supplementNotes: readonly string[] = []
): TelegramOutgoingMessage {
  const lines = [
    "✏️ <b>수정된 초안 준비됨</b>",
    "",
    `<b>${escapeTelegramHtml(article.title ?? job.keyword)}</b>`,
    `category: ${escapeTelegramHtml(job.category ?? "N/A")}`,
    "",
    `반영한 수정 방향: ${escapeTelegramHtml(feedback)}`,
    ...(supplementNotes.length > 0 ? ["", ...supplementNotes.map((note) => escapeTelegramHtml(note))] : []),
  ];

  if (!telegraphUrl) {
    lines.push("", "(Telegraph 발행 실패 - 아래에 본문 전문을 대신 보냅니다)");
    return { text: lines.join("\n") };
  }

  return {
    text: lines.join("\n"),
    replyMarkup: {
      inline_keyboard: [[{ text: "📄 원고 보기", url: telegraphUrl }], buildReviewDecisionButtons(job.id, trackOfJob(job))],
    },
  };
}

export async function notifyRevisedArticleReady(
  job: ArticleJobRow,
  article: ArticleRow,
  feedback: string,
  telegraphUrl: string | null,
  supplementNotes: readonly string[] = []
): Promise<void> {
  const header = buildRevisedHeaderMessage(job, article, feedback, telegraphUrl, supplementNotes);

  const messages: TelegramOutgoingMessage[] = telegraphUrl
    ? [header]
    : [header, ...buildArticleBodyMessages(article), buildReviewDecisionMessage(job.id, trackOfJob(job))];

  await notifierForJob(job).sendMessages(messages);
}
