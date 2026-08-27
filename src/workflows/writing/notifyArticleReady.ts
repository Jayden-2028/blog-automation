// runWritingStage() 성공 결과를 Telegram으로 알린다.
//
// "원고 보기" 버튼으로 Telegraph 페이지를 연다(2026-08-27, 사용자 요청): 처음에는 원고 본문을
// Telegram 메시지로 그대로 dump했는데, parse_mode=HTML에서는 원고의 마크다운(##, **)이 서식으로
// 렌더링되지 않고 글자 그대로 보였다. 사용자가 "서식까지 반영된 화면"을 요청했고, runWritingStage가
// 이미 Telegraph에 발행해 URL을 만들어뒀으므로(services/telegraph/) 그 URL을 여는 버튼을 단다.
//
// ⚠️ Telegraph 페이지는 URL을 아는 누구나 볼 수 있는 공개 페이지다. 검수 전 원고가 노출된다는
// 트레이드오프를 사용자가 승인했다(2026-08-27).
//
// Telegraph 발행이 실패했을 때만 본문 dump로 폴백한다 - "더 잘 읽히게" 하는 기능이 실패했다고
// 원고를 아예 못 보게 되면 안 된다. escapeTelegramHtml을 거치는 이유는 원고 본문에 "<"/">"/"&"가
// 그대로 들어 있으면(드물지만 있을 수 있다) Telegram이 parse_mode=HTML에서 400으로 발송 전체를
// 거부하기 때문이다.
//
// 의학 주제와 일반 주제의 알림이 다른 이유(SPRINT_2_DESIGN.md 5-2절): 의학 주제는 사람이 본문과
// 출처를 직접 읽고 확인해야 다음 단계로 넘어갈 수 있다(article_jobs.metadata.requiresMedicalReview).
// "원고 보기" 버튼과 [✅ 확인함]/[✏️ 수정 필요]/[🗑 폐기] 결정 버튼을 같은 메시지에 두 줄로 둔다 -
// 원고를 열어본 뒤 같은 화면에서 바로 결정할 수 있어야 한다.
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
import type { RunWritingStageResult } from "./runArticleJob.js";

// runWritingStage 결과를 받는다(runArticleJob 전체가 아니다) - job:write는 이제 runWritingStage를
// 직접 호출한다(조사 단계는 job:research로 분리됐고, 이미 저장된 근거가 있으면 재사용한다).
export type RunArticleJobSuccess = Extract<RunWritingStageResult, { status: "success" }>;

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
    `작성 소요 시간: ${Math.round(result.durationMs / 1000)}초`
  );

  if (!result.telegraphUrl) {
    lines.push("", "(Telegraph 발행 실패 - 아래에 본문 전문을 대신 보냅니다)");
  } else if (result.requiresMedicalReview) {
    lines.push("", "아래 버튼으로 원고 전문을 열어 출처까지 직접 확인한 뒤 결정해주세요.");
  }

  // 결정 버튼은 telegraphUrl이 있을 때만 헤더에 함께 붙인다. telegraphUrl이 없으면 아래
  // notifyArticleReady()가 본문 dump 뒤에 buildMedicalDecisionMessage()로 별도 발송한다 -
  // 여기서도 붙이면 같은 결정 버튼이 메시지 두 곳(헤더 + 폴백 결정 메시지)에 중복된다.
  const buttons: TelegramInlineKeyboardButton[][] = [];
  if (result.telegraphUrl) {
    buttons.push([{ text: "📄 원고 보기", url: result.telegraphUrl }]);
    if (result.requiresMedicalReview) {
      buttons.push(buildReviewDecisionButtons(job.id));
    }
  }

  return buttons.length > 0 ? { text: lines.join("\n"), replyMarkup: { inline_keyboard: buttons } } : { text: lines.join("\n") };
}

/**
 * Telegraph 발행이 실패했을 때만 쓰는 폴백. 원고 본문을 Telegram 메시지로 그대로 나눠 보낸다.
 */
export function buildArticleBodyMessages(article: ArticleRow): TelegramOutgoingMessage[] {
  const escaped = escapeTelegramHtml(article.content ?? "(본문 없음)");
  return splitIntoChunks(escaped, TELEGRAM_MESSAGE_CHAR_LIMIT).map((text) => ({ text }));
}

function buildReviewDecisionButtons(jobId: string): TelegramInlineKeyboardButton[] {
  return [
    { text: "✅ 확인함", callback_data: buildArticleReviewCallbackData("confirm", jobId) },
    { text: "✏️ 수정 필요", callback_data: buildArticleReviewCallbackData("edit", jobId) },
    { text: "🗑 폐기", callback_data: buildArticleReviewCallbackData("discard", jobId) },
  ];
}

/** Telegraph 폴백 경로에서만 쓴다 - 본문을 dump한 뒤에는 결정 버튼을 별도 메시지로 붙여야 한다. */
export function buildMedicalDecisionMessage(jobId: string): TelegramOutgoingMessage {
  return {
    text: "위 원고와 출처를 확인하셨다면 아래에서 결정해주세요.",
    replyMarkup: { inline_keyboard: [buildReviewDecisionButtons(jobId)] },
  };
}

/** 실제 발송한다. 발송 실패는 예외를 던진다 - 원고 생성은 끝났는데 알림만 조용히 실패하면 안 된다. */
export async function notifyArticleReady(result: RunArticleJobSuccess): Promise<void> {
  const header = buildHeaderMessage(result);

  // Telegraph가 성공했으면 header 하나로 끝난다(원고 보기 버튼 + 필요 시 결정 버튼이 이미 붙어 있다).
  // 실패했을 때만 본문 dump + (의학이면) 별도 결정 메시지로 폴백한다.
  const messages: TelegramOutgoingMessage[] = result.telegraphUrl
    ? [header]
    : [
        header,
        ...buildArticleBodyMessages(result.article),
        ...(result.requiresMedicalReview ? [buildMedicalDecisionMessage(result.job.id)] : []),
      ];

  await TelegramNotifier.fromEnv().sendMessages(messages);
}
