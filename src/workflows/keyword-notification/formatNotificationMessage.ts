// KeywordNotificationPayload -> Telegram으로 보낼 메시지 배열(HTML parse_mode) 변환.
//
// 항목당 메시지 하나로 나눈다(요약 헤더 1개 + 항목 N개). Telegram은 인라인 키보드를 메시지
// 단위로만 붙일 수 있어서, 항목 바로 아래에 Go/Pass 버튼을 두려면 항목마다 메시지가 따로 가야
// 한다. 전에는 전체를 한 메시지에 담고 하단에 1~10 숫자 버튼을 달았는데, 폰에서 항목이 한 화면에
// 안 들어와 "3번이 뭐였지" 하며 스크롤로 대조해야 했다.

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

  return lines.join("\n");
}

export type NotificationMessageChunk = {
  text: string;
  /** 이 chunk에 실제로 실린 항목의 rank 목록(본문에 나온 순서). */
  ranks: number[];
};

export function formatNotificationMessage(payload: KeywordNotificationPayload): NotificationMessageChunk[] {
  const { run } = payload;

  // 헤더는 버튼이 없다(ranks: []). 발송 측이 이 값으로 reply_markup 생략을 판단한다.
  const header: NotificationMessageChunk = {
    text:
      `📊 <b>오늘의 키워드 랭킹 TOP ${payload.items.length}</b>\n` +
      `${formatDateHeader(run.startedAt)} · run #${run.id}\n` +
      `Seed ${run.activeSeedsCount}개 · 후보 ${run.candidatesCount}건 · 클러스터 ${run.clustersCount}개 · ` +
      `${run.categories.length}개 카테고리`,
    ranks: [],
  };

  // 항목 하나가 글자 수 제한을 넘는 일은 현실적으로 없지만(실측 200자 안팎), headline이 비정상적으로
  // 길 때 Telegram이 400을 돌려주며 그 항목만 통째로 사라지는 것을 막기 위해 잘라둔다.
  const items: NotificationMessageChunk[] = payload.items.map((item) => ({
    text: truncateForTelegram(formatItemBlock(item)),
    ranks: [item.rank],
  }));

  return [header, ...items];
}

function truncateForTelegram(text: string): string {
  if (text.length <= TELEGRAM_MESSAGE_CHAR_LIMIT) return text;
  return `${text.slice(0, TELEGRAM_MESSAGE_CHAR_LIMIT - 1)}…`;
}
