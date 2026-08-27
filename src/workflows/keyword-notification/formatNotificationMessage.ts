// KeywordNotificationPayload -> Telegram으로 보낼 메시지 chunk 배열(HTML parse_mode) 변환.
// Telegram 메시지 글자 수 제한(TELEGRAM_MESSAGE_CHAR_LIMIT) 안에서, 키워드 항목 중간이 잘리지 않도록
// 항목 단위로 chunk를 나눈다.

import { escapeTelegramHtml, TELEGRAM_MESSAGE_CHAR_LIMIT } from "../../notifications/TelegramNotifier.js";
import type { KeywordNotificationPayload, NotificationKeywordItem } from "../../types/keywordNotification.js";

const TREND_DIRECTION_EMOJI: Record<string, string> = {
  accelerating: "🚀",
  rising: "📈",
  falling: "📉",
  flat: "➖",
  unknown: "❔",
};

function formatDateHeader(startedAt: string): string {
  const date = new Date(startedAt);
  return Number.isNaN(date.getTime())
    ? startedAt
    : date.toLocaleDateString("ko-KR", { year: "numeric", month: "long", day: "numeric" });
}

function formatItemBlock(item: NotificationKeywordItem): string {
  const keyword = escapeTelegramHtml(item.keyword);
  const headline = item.headline ? escapeTelegramHtml(item.headline) : null;
  const emoji = TREND_DIRECTION_EMOJI[item.trendDirection ?? "unknown"] ?? "❔";
  const breakdown = item.scoreBreakdown;

  const lines: string[] = [];
  lines.push(`<b>${item.rank}. ${keyword}</b> — ${item.totalScore}점 ${emoji}`);
  if (headline && headline !== keyword) {
    lines.push(`   원문: ${headline}`);
  }
  if (item.seedQuery) {
    lines.push(`   seedQuery: ${escapeTelegramHtml(item.seedQuery)} · category: ${escapeTelegramHtml(item.category ?? "N/A")}`);
  }
  if (breakdown) {
    lines.push(
      `   trend ${breakdown.trendMomentum} · news ${breakdown.newsVelocity} · content ${breakdown.contentDemand} · ` +
        `fresh ${breakdown.freshness} · cross ${breakdown.crossSourceSignal} · click ${breakdown.clickPotential}`
    );
  }
  // titleSuggestions는 아직 generateTitleSuggestions.ts의 규칙 기반 placeholder("[placeholder] ...")라
  // 실제로 쓸 만한 제목이 아니므로, 운영 Telegram 메시지에는 placeholder 대신 안내 문구 1줄만 노출한다.
  // 실제 LLM 제목 생성이 연결되면 이 줄을 다시 titleSuggestions 목록으로 교체한다.
  lines.push("   추천 제목: AI 제목 생성 연결 예정");

  return lines.join("\n");
}

export type NotificationMessageChunk = {
  text: string;
  /** 이 chunk에 실제로 실린 항목의 rank 목록(본문에 나온 순서). */
  ranks: number[];
};

export function formatNotificationMessage(payload: KeywordNotificationPayload): NotificationMessageChunk[] {
  const { run } = payload;
  const header =
    `📊 <b>오늘의 키워드 랭킹 TOP ${payload.items.length}</b>\n` +
    `${formatDateHeader(run.startedAt)} · run #${run.id}\n` +
    `Seed ${run.activeSeedsCount}개 · 후보 ${run.candidatesCount}건 · 클러스터 ${run.clustersCount}개 · ` +
    `${run.categories.length}개 카테고리`;

  const itemBlocks = payload.items.map((item) => ({ rank: item.rank, text: formatItemBlock(item) }));

  const chunks: NotificationMessageChunk[] = [];
  let current = header;
  let currentRanks: number[] = [];

  for (const block of itemBlocks) {
    const candidate = `${current}\n\n${block.text}`;
    if (candidate.length > TELEGRAM_MESSAGE_CHAR_LIMIT) {
      chunks.push({ text: current, ranks: currentRanks });
      current = block.text;
      currentRanks = [block.rank];
    } else {
      current = candidate;
      currentRanks.push(block.rank);
    }
  }
  chunks.push({ text: current, ranks: currentRanks });

  return chunks;
}
