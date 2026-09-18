// KeywordNotificationPayload -> Telegram으로 보낼 메시지 배열(HTML parse_mode) 변환.
//
// 항목당 메시지 하나로 나눈다(요약 헤더 1개 + 항목 N개). Telegram은 인라인 키보드를 메시지
// 단위로만 붙일 수 있어서, 항목 바로 아래에 Go/Pass 버튼을 두려면 항목마다 메시지가 따로 가야
// 한다. 전에는 전체를 한 메시지에 담고 하단에 1~10 숫자 버튼을 달았는데, 폰에서 항목이 한 화면에
// 안 들어와 "3번이 뭐였지" 하며 스크롤로 대조해야 했다.

import { escapeTelegramHtml, TELEGRAM_MESSAGE_CHAR_LIMIT } from "../../notifications/TelegramNotifier.js";
import type { KeywordNotificationPayload, NotificationKeywordItem } from "../../types/keywordNotification.js";

function formatDateHeader(startedAt: string): string {
  const date = new Date(startedAt);
  return Number.isNaN(date.getTime())
    ? startedAt
    : date.toLocaleDateString("ko-KR", { year: "numeric", month: "long", day: "numeric" });
}

/**
 * 자료 부족 위험 신호(2026-09-18). **뉴스도 0건이고 여러 출처에 걸치지도 않은** 키워드는 사실상
 * 글 하나에서 나온 키워드다.
 *
 * 실측(넷플릭스 인형, job e445e064): 블로그 글 제목이 그대로 canonical keyword가 됐고
 * (newsVelocity 0 / crossSourceSignal 0), 자료조사가 한국어 자료를 못 찾아 영문 팬사이트만 긁었다.
 * 그 셋이 결말을 서로 다르게 서술해 `verdict: blocked`가 났고 writer가 원고 작성을 거부했다 -
 * 조사 15분을 쓰고 나서야 알았다.
 *
 * **차단하지 않는다.** 신선한 OTT 신작은 원래 뉴스가 없어 오히려 좋은 키워드일 수도 있다.
 * 고르기 전에 알 수 있게 표시만 한다.
 */
export function thinSourceWarning(
  breakdown: NotificationKeywordItem["scoreBreakdown"]
): string | null {
  if (!breakdown) return null;
  if (breakdown.newsVelocity > 0 || breakdown.crossSourceSignal > 0) return null;
  return "⚠️ 뉴스 0건 · 단일 출처 — 자료 부족으로 원고가 안 나올 수 있습니다";
}

/** 주제·시드쿼리·카테고리만 보여준다 - 원문(headline)과 항목별 배점표(scoreBreakdown)는 뺀다(2026-09-04 사용자 요청, 폰 화면에서 항목당 너무 길었다). */
function formatItemBlock(item: NotificationKeywordItem): string {
  const keyword = escapeTelegramHtml(item.keyword);

  const lines: string[] = [`<b>${item.rank}. ${keyword}</b>`];
  if (item.seedQuery) {
    lines.push(`   seedQuery: ${escapeTelegramHtml(item.seedQuery)} · category: ${escapeTelegramHtml(item.category ?? "N/A")}`);
  }
  // 20자 내외 요약(2026-09-15 사용자 요청, generateKeywordSummaries.ts) - 클릭 전에 무슨
  // 내용인지 바로 알 수 있게. 생성 실패 시(null)엔 이 줄을 통째로 뺀다.
  if (item.summary) {
    lines.push(`   ${escapeTelegramHtml(item.summary)}`);
  }
  const warning = thinSourceWarning(item.scoreBreakdown);
  if (warning) {
    lines.push(`   ${escapeTelegramHtml(warning)}`);
  }

  return lines.join("\n");
}

export type NotificationMessageChunk = {
  text: string;
  /** 이 chunk에 실제로 실린 항목의 rank 목록(본문에 나온 순서). */
  ranks: number[];
};

export type FormatNotificationMessageOptions = {
  /** 헤더 첫 줄. 생략하면 "📊 오늘의 키워드 랭킹 TOP N"(오전 기본). 오후 커뮤니티 run은 별도 문구를 넘긴다. */
  headerTitle?: string;
};

export function formatNotificationMessage(
  payload: KeywordNotificationPayload,
  options: FormatNotificationMessageOptions = {}
): NotificationMessageChunk[] {
  const { run } = payload;
  const headerTitle = options.headerTitle ?? `📊 <b>오늘의 키워드 랭킹 TOP ${payload.items.length}</b>`;

  // 헤더는 버튼이 없다(ranks: []). 발송 측이 이 값으로 reply_markup 생략을 판단한다.
  const header: NotificationMessageChunk = {
    text:
      `${headerTitle}\n` +
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
