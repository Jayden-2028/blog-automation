// runResearchStage() 성공 결과를 Telegram으로 보내 "이대로 원고를 쓸까요?"를 묻는다.
//
// 왜 필요한가(2026-08-27, 사용자 피드백): 첫 실제 원고("2026 경복궁 별빛야행")는 프롬프트 규칙대로
// 정확했지만, 수집된 근거 안에 "예매가 이미 마감됐고 당첨자 발표까지 끝났다"는 정보가 있었는데도
// 3분(185초) 분량의 LLM 비용을 쓴 뒤에야 그 사실을 알게 됐다. 그래서 조사(research)와 작성(writing)
// 사이에 사람이 값싸게 판단할 수 있는 지점을 둔다.
//
// 2026-09-01: 요약은 researcher 에이전트가 이미 research/[키워드].md §1에 써 두므로 그걸 그대로
// 옮긴다(summarizeResearchFile). 파일을 못 읽으면 sources 원문 발췌 나열로 폴백한다.
// verdict가 blocked면 [✍️ 원고 작성] 버튼을 빼고 [🗑 중단]만 남긴다.

import { readFile } from "node:fs/promises";

import { escapeTelegramHtml, splitIntoChunks, TELEGRAM_MESSAGE_CHAR_LIMIT, TelegramNotifier } from "../../notifications/TelegramNotifier.js";
import type { TelegramInlineKeyboardButton, TelegramOutgoingMessage } from "../../notifications/TelegramNotifier.js";
import { buildResearchDecisionCallbackData } from "../../notifications/researchDecisionCallbackData.js";
import { summarizeResearchFile } from "./summarizeResearchForReview.js";
import type { ResearchSummary } from "./summarizeResearchForReview.js";
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

function buildFooterLines(job: ArticleJobRow): string[] {
  const raw = (job.metadata as Record<string, unknown> | null)?.titleSuggestions;
  const titles = Array.isArray(raw) ? raw.filter((t): t is string => typeof t === "string") : [];
  if (titles.length === 0) return [];
  return ["", "✍️ <b>추천 제목</b>", ...titles.map((title, index) => `${index + 1}. ${escapeTelegramHtml(title)}`)];
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
 * 미리보기 메시지를 만든다. summary가 있으면 research 파일 요약을 본문으로 쓰고, 없으면(파일 읽기
 * 실패) 출처 나열로 폴백한다. summary.verdict === "blocked"면 원고 작성 버튼을 빼고 중단만 남긴다.
 */
export function buildResearchPreviewMessages(
  job: ArticleJobRow,
  sources: SourceRow[],
  summary: ResearchSummary | null
): TelegramOutgoingMessage[] {
  const header = buildHeaderLines(job, sources);
  const footer = buildFooterLines(job);

  const body: string[] = summary
    ? ["", escapeTelegramHtml(summary.text)]
    : [
        "",
        "⚠️ 조사 요약 파일을 읽지 못했습니다 - 아래 원문 발췌를 참고해주세요.",
        "",
        ...buildFallbackSourceLines(sources).flatMap((line) => [line, ""]),
      ];

  const full = [...header, ...body, ...footer].join("\n");
  const chunks = splitIntoChunks(full, TELEGRAM_MESSAGE_CHAR_LIMIT);
  const messages: TelegramOutgoingMessage[] = chunks.map((text) => ({ text }));

  const buttons: TelegramInlineKeyboardButton[] =
    summary?.verdict === "blocked"
      ? [{ text: "🗑 중단", callback_data: buildResearchDecisionCallbackData("reject", job.id) }]
      : [
          { text: "✍️ 원고 작성", callback_data: buildResearchDecisionCallbackData("write", job.id) },
          { text: "🗑 중단", callback_data: buildResearchDecisionCallbackData("reject", job.id) },
        ];
  const last = messages[messages.length - 1];
  if (last) last.replyMarkup = { inline_keyboard: [buttons] };

  return messages;
}

/**
 * research 파일을 요약하고 Telegram으로 발송한다. researchFilePath를 못 읽으면 sources 발췌로 폴백.
 */
export async function notifyResearchReady(
  job: ArticleJobRow,
  researchFilePath: string,
  sources: SourceRow[]
): Promise<void> {
  let summary: ResearchSummary | null = null;
  try {
    const text = await readFile(researchFilePath, "utf8");
    summary = summarizeResearchFile(text);
  } catch (error) {
    console.error("⚠️ 조사 요약 파일 읽기 실패 (원문 발췌로 폴백) -", error instanceof Error ? error.message : error);
  }

  const messages = buildResearchPreviewMessages(job, sources, summary);
  await TelegramNotifier.fromEnv().sendMessages(messages);
}
