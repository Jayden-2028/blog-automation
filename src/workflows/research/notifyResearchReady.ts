// runResearchStage() 성공 결과를 Telegram으로 보내 "이대로 원고를 쓸까요?"를 묻는다.
//
// 왜 필요한가(2026-08-27, 사용자 피드백): 첫 실제 원고("2026 경복궁 별빛야행")는 프롬프트 규칙대로
// 정확했지만, 수집된 근거 안에 "예매가 이미 마감됐고 당첨자 발표까지 끝났다"는 정보가 있었는데도
// 3분(185초) 분량의 LLM 비용을 쓴 뒤에야 그 사실을 알게 됐다. 검색량이 오른 이유도 신규 관심이
// 아니라 기응모자들의 당첨 확인 트래픽으로 추정된다 - 검색 신호만으로는 이런 "이미 끝난 이벤트"를
// 가려낼 수 없다.
//
// 그래서 조사(research)와 작성(writing) 사이에 사람이 값싸게(조사만 2초, LLM 비용 0) 판단할 수
// 있는 지점을 둔다. buildFactCard(원고 프롬프트용, 출처당 최대 3,000자)를 그대로 보내면 읽기
// 부담이 커서, 여기서는 출처당 제목+등급+짧은 발췌만 보이는 압축 미리보기를 따로 만든다.

import { escapeTelegramHtml, splitIntoChunks, TELEGRAM_MESSAGE_CHAR_LIMIT, TelegramNotifier } from "../../notifications/TelegramNotifier.js";
import type { TelegramOutgoingMessage } from "../../notifications/TelegramNotifier.js";
import type { ArticleJobRow, SourceAuthorityLevel, SourceRow } from "../../types/database.js";

/** 미리보기에 보일 출처당 발췌 길이. 판단에 필요한 만큼만 - 전문은 작성 단계에서 팩트 카드로 쓴다. */
const EXCERPT_LENGTH = 150;

const AUTHORITY_TAG: Record<SourceAuthorityLevel, string> = {
  official: "공공",
  medical: "의료",
  news: "뉴스",
  community: "커뮤니티",
};

export function buildResearchPreviewMessages(job: ArticleJobRow, sources: SourceRow[]): TelegramOutgoingMessage[] {
  const counts = { official: 0, medical: 0, news: 0, community: 0 };
  for (const source of sources) {
    if (source.authority) counts[source.authority]++;
  }

  const header = [
    "🔍 <b>자료조사 완료 — 원고를 쓸까요?</b>",
    "",
    `<b>${escapeTelegramHtml(job.keyword)}</b>`,
    `category: ${escapeTelegramHtml(job.category ?? "N/A")} · ${job.total_score ?? "?"}점`,
    "",
    `근거 ${sources.length}건 — 공공 ${counts.official} · 의료 ${counts.medical} · 뉴스 ${counts.news} · 커뮤니티 ${counts.community}`,
    "",
    "아래 출처를 훑어보고 이 키워드가 원고로 쓸 가치가 있는지 판단해주세요.",
    "특히 마감일·행사 기간처럼 이미 지난 정보가 있는지 확인해주세요.",
    "",
    "진행하려면: npm run job:write -- " + job.id,
    "중단하려면: npm run job:reject -- " + job.id,
  ].join("\n");

  const sourceLines = sources.map((source, index) => {
    const tag = source.authority ? AUTHORITY_TAG[source.authority] : "미분류";
    const title = source.title ? escapeTelegramHtml(source.title) : "(제목 없음)";
    const excerpt = source.content ? escapeTelegramHtml(source.content.slice(0, EXCERPT_LENGTH).trim()) : "";
    const lines = [`${index + 1}. [${tag}] ${title}`];
    if (excerpt) lines.push(`   ${excerpt}${source.content && source.content.length > EXCERPT_LENGTH ? "…" : ""}`);
    if (source.url) lines.push(`   ${source.url}`);
    return lines.join("\n");
  });

  // 헤더와 출처 목록을 합쳐 4000자 단위로 자연스럽게 나눈다 - 출처가 많아도 메시지 발송이 실패하지 않는다.
  const full = [header, ...sourceLines].join("\n\n");
  return splitIntoChunks(full, TELEGRAM_MESSAGE_CHAR_LIMIT).map((text) => ({ text }));
}

export async function notifyResearchReady(job: ArticleJobRow, sources: SourceRow[]): Promise<void> {
  const messages = buildResearchPreviewMessages(job, sources);
  await TelegramNotifier.fromEnv().sendMessages(messages);
}
