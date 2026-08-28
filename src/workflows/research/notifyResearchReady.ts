// runResearchStage() 성공 결과를 Telegram으로 보내 "이대로 원고를 쓸까요?"를 묻는다.
//
// 왜 필요한가(2026-08-27, 사용자 피드백): 첫 실제 원고("2026 경복궁 별빛야행")는 프롬프트 규칙대로
// 정확했지만, 수집된 근거 안에 "예매가 이미 마감됐고 당첨자 발표까지 끝났다"는 정보가 있었는데도
// 3분(185초) 분량의 LLM 비용을 쓴 뒤에야 그 사실을 알게 됐다. 그래서 조사(research)와 작성(writing)
// 사이에 사람이 값싸게 판단할 수 있는 지점을 둔다.
//
// 요약을 LLM에 맡기는 이유(2026-08-27, 두 번째 실측 피드백): 처음에는 출처별 제목+150자 발췌+URL을
// 그대로 나열했는데, 실제로 받아보니 여러 출처가 네비게이션 메뉴 텍스트로 시작해 있어 링크를
// 일일이 열어봐야 판단할 수 있었다 - "체크포인트에서 값싸게 판단한다"는 취지와 반대였다.
// summarizeResearchForReview()가 만든 요약(핵심 사실 + 마감 여부 경고)을 본문으로 쓰고, 원문 발췌
// 나열은 요약 생성이 실패했을 때만 폴백으로 보여준다.

import { escapeTelegramHtml, splitIntoChunks, TELEGRAM_MESSAGE_CHAR_LIMIT, TelegramNotifier } from "../../notifications/TelegramNotifier.js";
import type { TelegramInlineKeyboardButton, TelegramOutgoingMessage } from "../../notifications/TelegramNotifier.js";
import { buildResearchDecisionCallbackData } from "../../notifications/researchDecisionCallbackData.js";
import { summarizeResearchForReview } from "./summarizeResearchForReview.js";
import type { SummarizeResearchOptions, SummarizeResearchResult } from "./summarizeResearchForReview.js";
import type { ArticleJobRow, SourceAuthorityLevel, SourceRow } from "../../types/database.js";

/** 요약 실패 시 폴백으로 보여줄 출처당 발췌 길이. */
const FALLBACK_EXCERPT_LENGTH = 150;

const AUTHORITY_TAG: Record<SourceAuthorityLevel, string> = {
  official: "공공",
  medical: "의료",
  news: "뉴스",
  community: "커뮤니티",
};

function buildSourceCountLine(sources: SourceRow[]): string {
  const counts = { official: 0, medical: 0, news: 0, community: 0 };
  for (const source of sources) {
    if (source.authority) counts[source.authority]++;
  }
  return `근거 ${sources.length}건 — 공공 ${counts.official} · 의료 ${counts.medical} · 뉴스 ${counts.news} · 커뮤니티 ${counts.community}`;
}

function buildHeaderLines(job: ArticleJobRow, sources: SourceRow[]): string[] {
  return [
    "🔍 <b>자료조사 완료 — 원고를 쓸까요?</b>",
    "",
    `<b>${escapeTelegramHtml(job.keyword)}</b>`,
    `category: ${escapeTelegramHtml(job.category ?? "N/A")} · ${job.total_score ?? "?"}점`,
    "",
    buildSourceCountLine(sources),
  ];
}

// 2026-08-28: "진행하려면 npm run job:write -- <id>" 안내 두 줄을 뺐다. 버튼이 붙기 전에는
// 이게 유일한 진행 수단이라 필요했지만, 이제 같은 메시지에 [✍️ 원고 작성][🗑 중단] 버튼이
// 있어 명령어를 폰에서 옮겨 칠 이유가 없다 - jobId가 그대로 노출되는 긴 줄이라 메시지만 지저분해진다.
// 터미널로 직접 하려면 `npm run job:write`를 인자 없이 실행하면 대기 중인 job 목록이 나온다.
function buildFooterLines(_job: ArticleJobRow): string[] {
  return [];
}

/** 요약 생성이 실패했을 때만 쓰는 폴백 - 출처별 제목+짧은 발췌+URL을 그대로 나열한다. */
function buildFallbackSourceLines(sources: SourceRow[]): string[] {
  return sources.map((source, index) => {
    const tag = source.authority ? AUTHORITY_TAG[source.authority] : "미분류";
    const title = source.title ? escapeTelegramHtml(source.title) : "(제목 없음)";
    const excerpt = source.content ? escapeTelegramHtml(source.content.slice(0, FALLBACK_EXCERPT_LENGTH).trim()) : "";
    const lines = [`${index + 1}. [${tag}] ${title}`];
    if (excerpt) lines.push(`   ${excerpt}${source.content && source.content.length > FALLBACK_EXCERPT_LENGTH ? "…" : ""}`);
    if (source.url) lines.push(`   ${source.url}`);
    return lines.join("\n");
  });
}

/**
 * 요약 결과를 반영해 미리보기 메시지를 만든다. summary가 성공이면 AI 요약을 본문으로 쓰고,
 * 실패했으면 출처 나열로 폴백한다(판단할 근거가 아예 없는 것보다는 낫다).
 */
export function buildResearchPreviewMessages(
  job: ArticleJobRow,
  sources: SourceRow[],
  summary: SummarizeResearchResult
): TelegramOutgoingMessage[] {
  const header = buildHeaderLines(job, sources);
  const footer = buildFooterLines(job);

  let body: string[];
  if (summary.ok) {
    body = ["", escapeTelegramHtml(summary.summary)];
  } else {
    body = [
      "",
      `⚠️ 요약 생성 실패(${escapeTelegramHtml(summary.error)}) - 아래 원문 발췌를 참고해주세요.`,
      "",
      ...buildFallbackSourceLines(sources).flatMap((line) => [line, ""]),
    ];
  }

  const full = [...header, ...body, ...footer].join("\n");
  const chunks = splitIntoChunks(full, TELEGRAM_MESSAGE_CHAR_LIMIT);
  const messages: TelegramOutgoingMessage[] = chunks.map((text) => ({ text }));

  // 버튼은 마지막 chunk에만 붙인다 - "진행하려면.../중단하려면..." 안내 텍스트가 항상 마지막
  // chunk에 있고(join 순서상), 버튼은 메시지당 하나씩만 붙는 Telegram의 제약 때문에 여러 메시지에
  // 나눠 붙일 수 없다. 텍스트 안내는 그대로 남겨둔다(폰 대신 터미널로 하고 싶을 때의 폴백).
  const buttons: TelegramInlineKeyboardButton[] = [
    { text: "✍️ 원고 작성", callback_data: buildResearchDecisionCallbackData("write", job.id) },
    { text: "🗑 중단", callback_data: buildResearchDecisionCallbackData("reject", job.id) },
  ];
  const last = messages[messages.length - 1];
  if (last) last.replyMarkup = { inline_keyboard: [buttons] };

  return messages;
}

/**
 * 근거를 요약하고 Telegram으로 발송까지 한다. job:research CLI가 이 함수 하나만 호출하면 된다.
 */
export async function notifyResearchReady(
  job: ArticleJobRow,
  sources: SourceRow[],
  options: SummarizeResearchOptions = {}
): Promise<void> {
  const summary = await summarizeResearchForReview(
    { job: { keyword: job.keyword, headline: job.headline, category: job.category }, sources },
    options
  );
  if (!summary.ok) {
    console.error("⚠️ 조사 요약 생성 실패 (원문 발췌로 폴백) -", summary.error);
  }

  const messages = buildResearchPreviewMessages(job, sources, summary);
  await TelegramNotifier.fromEnv().sendMessages(messages);
}
