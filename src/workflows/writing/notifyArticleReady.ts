// runArticleJob() 성공 결과를 Telegram으로 알린다.
//
// 의학 주제와 일반 주제의 알림이 다른 이유(SPRINT_2_DESIGN.md 5-2절): 의학 주제는 사람이 출처를
// 직접 눌러 확인해야 다음 단계로 넘어갈 수 있다(article_jobs.metadata.requiresMedicalReview).
// 그래서 근거 등급 요약과 출처 URL 전체 목록, [✅ 확인함]/[✏️ 수정 필요]/[🗑 폐기] 버튼을 함께 보낸다 -
// 교차확인을 요청하면서 확인할 대상을 안 주면 형식적인 승인이 된다.
//
// 일반 주제는 아직 승인 버튼을 달지 않는다. 발행 승인 흐름(모든 원고 공통)은 Sprint 3의 검수
// 게이트가 담당하고, 지금은 "초안이 준비됐다"는 사실만 알린다.

import { buildArticleReviewCallbackData } from "../../notifications/articleReviewCallbackData.js";
import { TelegramNotifier } from "../../notifications/TelegramNotifier.js";
import { escapeTelegramHtml } from "../../notifications/TelegramNotifier.js";
import type { TelegramInlineKeyboardButton, TelegramOutgoingMessage } from "../../notifications/TelegramNotifier.js";
import type { RunArticleJobResult } from "./runArticleJob.js";

/** 의학 교차확인 메시지에 나열할 최대 출처 수. 너무 길면 확인 부담이 커져 형식적인 승인으로 이어진다. */
const MAX_LISTED_SOURCES = 10;

const AUTHORITY_TAG: Record<string, string> = {
  official: "공공",
  medical: "의료",
  news: "뉴스",
  community: "커뮤니티",
};

export type RunArticleJobSuccess = Extract<RunArticleJobResult, { status: "success" }>;

function buildSourceCountSummary(result: RunArticleJobSuccess): string {
  const counts = { official: 0, medical: 0, news: 0, community: 0 };
  for (const source of result.sources) {
    if (source.authority) counts[source.authority]++;
  }
  return `공공 ${counts.official}건 · 의료 ${counts.medical}건 · 뉴스 ${counts.news}건 · 커뮤니티 ${counts.community}건`;
}

function buildMedicalMessage(result: RunArticleJobSuccess): TelegramOutgoingMessage {
  const { job, article } = result;

  const lines = [
    "⚕️ <b>의학 주제 — 직접 확인이 필요합니다</b>",
    "",
    `<b>${escapeTelegramHtml(article.title ?? job.keyword)}</b>`,
    `키워드: ${escapeTelegramHtml(job.keyword)}`,
    "",
    `이 원고의 근거 등급: ${buildSourceCountSummary(result)}`,
    "아래 출처를 직접 확인하신 뒤 버튼을 눌러주세요.",
    "",
  ];

  const listedSources = result.sources.slice(0, MAX_LISTED_SOURCES);
  listedSources.forEach((source, index) => {
    const tag = source.authority ? AUTHORITY_TAG[source.authority] : "미분류";
    const title = source.title ? escapeTelegramHtml(source.title) : "(제목 없음)";
    lines.push(`${index + 1}. [${tag}] ${title}`);
    if (source.url) lines.push(`   ${source.url}`);
  });
  if (result.sources.length > MAX_LISTED_SOURCES) {
    lines.push(`… 외 ${result.sources.length - MAX_LISTED_SOURCES}건`);
  }

  const buttons: TelegramInlineKeyboardButton[] = [
    { text: "✅ 확인함", callback_data: buildArticleReviewCallbackData("confirm", job.id) },
    { text: "✏️ 수정 필요", callback_data: buildArticleReviewCallbackData("edit", job.id) },
    { text: "🗑 폐기", callback_data: buildArticleReviewCallbackData("discard", job.id) },
  ];

  return { text: lines.join("\n"), replyMarkup: { inline_keyboard: [buttons] } };
}

function buildNormalMessage(result: RunArticleJobSuccess): TelegramOutgoingMessage {
  const { job, article } = result;

  const lines = [
    "📝 <b>원고 초안 준비됨</b>",
    "",
    `<b>${escapeTelegramHtml(article.title ?? job.keyword)}</b>`,
    `키워드: ${escapeTelegramHtml(job.keyword)} · category: ${escapeTelegramHtml(job.category ?? "N/A")}`,
    `근거: ${buildSourceCountSummary(result)}`,
    "",
    `소요 시간: 조사 ${Math.round(result.durationMs.research / 1000)}초 · 작성 ${Math.round(result.durationMs.writing / 1000)}초`,
  ];

  return { text: lines.join("\n") };
}

/** 실제 발송한다. 발송 실패는 예외를 던진다 - 원고 생성은 끝났는데 알림만 조용히 실패하면 안 된다. */
export async function notifyArticleReady(result: RunArticleJobSuccess): Promise<void> {
  const message = result.requiresMedicalReview ? buildMedicalMessage(result) : buildNormalMessage(result);
  await TelegramNotifier.fromEnv().sendMessages([message]);
}
