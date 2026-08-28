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
// 승인 버튼은 모든 원고 공통이다(SPRINT_3_DESIGN.md 8절, 2026-08-28): 이전에는 확인/수정/폐기가
// 의학 주제 교차확인 전용이었고 confirm이 job.status를 바꾸지 않았다("발행 승인은 이후 검수
// 단계에서 이어집니다"). 그 검수 단계가 이제 여기다 - confirm이 articles/article_jobs를
// approved로 전이시킨다. 의학 주제는 여기에 한 겹을 더한다: 승인 시 requiresMedicalReview도
// 함께 내린다(TelegramBot.handleArticleReviewCallback 참고).

import { buildArticleReviewCallbackData } from "../../notifications/articleReviewCallbackData.js";
import {
  escapeTelegramHtml,
  splitIntoChunks,
  TELEGRAM_MESSAGE_CHAR_LIMIT,
  TelegramNotifier,
} from "../../notifications/TelegramNotifier.js";
import type { TelegramInlineKeyboardButton, TelegramOutgoingMessage } from "../../notifications/TelegramNotifier.js";
import { formatReviewLines } from "../review/runArticleReview.js";
import type { ArticleRow } from "../../types/database.js";
import type { RunWritingStageResult } from "./runArticleJob.js";

// runWritingStage 결과를 받는다(runArticleJob 전체가 아니다) - job:write는 이제 runWritingStage를
// 직접 호출한다(조사 단계는 job:research로 분리됐고, 이미 저장된 근거가 있으면 재사용한다).
export type RunArticleJobSuccess = Extract<RunWritingStageResult, { status: "success" }>;

export function buildHeaderMessage(result: RunArticleJobSuccess): TelegramOutgoingMessage {
  const { job, article } = result;

  const lines = result.requiresMedicalReview
    ? ["⚕️ <b>의학 주제 — 원고와 출처를 직접 확인해주세요</b>"]
    : ["📝 <b>원고 초안 준비됨</b>"];

  // 2026-08-28 사용자 피드백으로 제목/카테고리만 남겼다: 키워드는 제목과 거의 겹치고, 근거
  // 건수와 작성 소요 시간은 이 시점에 사람이 내릴 결정(승인/수정/반려)에 쓰이지 않는다.
  // 근거 구성은 job.metadata.sourceCounts에 그대로 남아 있고, 조사 단계 알림에서 이미 봤다.
  lines.push(
    "",
    `<b>${escapeTelegramHtml(article.title ?? job.keyword)}</b>`,
    `category: ${escapeTelegramHtml(job.category ?? "N/A")}`
  );

  // 검수 결과(SPRINT_3_DESIGN.md 6절) - 차단하지 않고 참고로만 보여준다. escapeTelegramHtml을
  // 거는 이유는 검수 메시지 안에 근거 원문 발췌("특별석은 12만 원입니다" 등)가 그대로 들어가
  // "<"/">"/"&"가 섞일 수 있기 때문이다.
  lines.push("", ...formatReviewLines(result.review).map((line) => escapeTelegramHtml(line)));

  if (!result.telegraphUrl) {
    lines.push("", "(Telegraph 발행 실패 - 아래에 본문 전문을 대신 보냅니다)");
  } else {
    lines.push("", "아래 버튼으로 원고 전문을 열어본 뒤 결정해주세요.");
  }

  // 결정 버튼은 telegraphUrl이 있을 때만 헤더에 함께 붙인다. telegraphUrl이 없으면 아래
  // notifyArticleReady()가 본문 dump 뒤에 buildReviewDecisionMessage()로 별도 발송한다 -
  // 여기서도 붙이면 같은 결정 버튼이 메시지 두 곳(헤더 + 폴백 결정 메시지)에 중복된다.
  const buttons: TelegramInlineKeyboardButton[][] = [];
  if (result.telegraphUrl) {
    buttons.push([{ text: "📄 원고 보기", url: result.telegraphUrl }]);
    buttons.push(buildReviewDecisionButtons(job.id));
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
    { text: "✅ 승인", callback_data: buildArticleReviewCallbackData("confirm", jobId) },
    { text: "✏️ 수정 필요", callback_data: buildArticleReviewCallbackData("edit", jobId) },
    { text: "🗑 반려", callback_data: buildArticleReviewCallbackData("discard", jobId) },
  ];
}

/** Telegraph 폴백 경로에서만 쓴다 - 본문을 dump한 뒤에는 결정 버튼을 별도 메시지로 붙여야 한다. */
export function buildReviewDecisionMessage(jobId: string): TelegramOutgoingMessage {
  return {
    text: "위 원고를 확인하셨다면 아래에서 결정해주세요.",
    replyMarkup: { inline_keyboard: [buildReviewDecisionButtons(jobId)] },
  };
}

/** 실제 발송한다. 발송 실패는 예외를 던진다 - 원고 생성은 끝났는데 알림만 조용히 실패하면 안 된다. */
export async function notifyArticleReady(result: RunArticleJobSuccess): Promise<void> {
  const header = buildHeaderMessage(result);

  // Telegraph가 성공했으면 header 하나로 끝난다(원고 보기 버튼 + 결정 버튼이 이미 붙어 있다).
  // 실패했을 때만 본문 dump + 별도 결정 메시지로 폴백한다. 승인 버튼은 이제 모든 원고 공통이라
  // requiresMedicalReview 여부와 무관하게 항상 결정 메시지를 보낸다.
  const messages: TelegramOutgoingMessage[] = result.telegraphUrl
    ? [header]
    : [header, ...buildArticleBodyMessages(result.article), buildReviewDecisionMessage(result.job.id)];

  await TelegramNotifier.fromEnv().sendMessages(messages);
}
