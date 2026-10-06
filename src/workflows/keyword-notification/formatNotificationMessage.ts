// KeywordNotificationPayload -> Telegram으로 보낼 메시지 배열(HTML parse_mode) 변환.
//
// 항목당 메시지 하나로 나눈다(요약 헤더 1개 + 항목 N개). Telegram은 인라인 키보드를 메시지
// 단위로만 붙일 수 있어서, 항목 바로 아래에 Go/Pass 버튼을 두려면 항목마다 메시지가 따로 가야
// 한다. 전에는 전체를 한 메시지에 담고 하단에 1~10 숫자 버튼을 달았는데, 폰에서 항목이 한 화면에
// 안 들어와 "3번이 뭐였지" 하며 스크롤로 대조해야 했다.

import { escapeTelegramHtml, TELEGRAM_MESSAGE_CHAR_LIMIT } from "../../notifications/TelegramNotifier.js";
import type {
  KeywordNotificationPayload,
  KeywordSectionConfig,
  NotificationKeywordItem,
} from "../../types/keywordNotification.js";

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

/**
 * 유효기간 위험 신호(2026-10-01). **이미 마감된 일을 소개하는 글**을 쓰게 되는 사고가 실제로 두 번
 * 있었다 - "양주 서울우유 견학"은 원고를 쓴 뒤에 예약이 매진인 것을 알았고, 불꽃놀이 건은 예매가
 * 이미 끝난 뒤였다. 둘 다 키워드 점수는 높았다. 6-factor의 freshness는 "이슈가 얼마나 최근인가"를
 * 재지, "지금도 참여할 수 있는가"는 재지 않기 때문이다. 화제성과 실행가능성은 다른 축이다.
 *
 * **차단하지 않는다**(thinSourceWarning과 같은 철학). 예약이 열려 있는 축제·전시는 좋은 키워드이고,
 * 마감 여부는 예약 페이지를 직접 봐야 알 수 있는데 이 파이프라인에는 그 정보가 없다. 사람이 Go/Pass를
 * 누르는 자리에서 "확인하고 누르라"고 알려 주는 것이 지금 할 수 있는 가장 정확한 일이다.
 *
 * 두 단계로 나눈다:
 *   1) 제목·키워드에 이미 종료를 뜻하는 말이 있으면 강한 경고(마감/매진/종료/완판/취소).
 *   2) 예약·접수형 키워드면 확인 요청(예매/신청/접수/모집/견학/응모/선착순...).
 * 1)이 있으면 2)는 붙이지 않는다 - 같은 줄을 두 번 쓰지 않는다.
 */

/** 이미 끝났음을 뜻하는 말. 제목에 이게 있으면 그 이슈는 더 이상 실행 가능하지 않을 가능성이 높다. */
export const EXPIRED_TERMS = [
  "마감", "매진", "종료", "완판", "품절", "취소", "중단", "철회", "무산", "폐지",
] as string[];

/**
 * 마감이 있는 일임을 뜻하는 말. 이 말이 있으면 "지금도 되는가"를 사람이 확인해야 한다.
 * 목록을 넓게 잡는 쪽을 택했다 - 한 줄 더 보는 비용보다 마감된 건으로 원고를 쓰는 비용이 훨씬 크다.
 */
export const DEADLINE_TERMS = [
  "예매", "예약", "신청", "접수", "모집", "응모", "선착순", "견학", "입장권", "티켓",
  "사전판매", "얼리버드", "한정판매", "공모", "지원금 신청", "마감일", "추첨",
] as string[];

function includesAny(haystack: string, terms: readonly string[]): string | null {
  for (const term of terms) {
    if (haystack.includes(term)) return term;
  }
  return null;
}

export function expiryRiskWarning(item: {
  keyword: string;
  headline?: string | null;
}): string | null {
  // 제목과 키워드를 함께 본다. canonical keyword는 앞에서 잘린 축약이라 "…예매 종료"의 뒷부분이
  // 이미 사라진 경우가 있다(selectDiverseTopN 주석과 같은 이유).
  const haystack = `${item.keyword} ${item.headline ?? ""}`;

  const expired = includesAny(haystack, EXPIRED_TERMS);
  if (expired) {
    return `⚠️ 제목에 '${expired}' — 이미 끝난 건일 수 있습니다. 원고 전에 확인하세요`;
  }

  const deadline = includesAny(haystack, DEADLINE_TERMS);
  if (deadline) {
    return `⚠️ '${deadline}' 건 — 지금도 가능한지(마감·매진) 확인 후 진행하세요`;
  }

  return null;
}

/** 주제·시드쿼리·카테고리만 보여준다 - 원문(headline)과 항목별 배점표(scoreBreakdown)는 뺀다(2026-09-04 사용자 요청, 폰 화면에서 항목당 너무 길었다). */
function formatItemBlock(item: NotificationKeywordItem, isCommunity = false, evergreen = false): string {
  const keyword = escapeTelegramHtml(item.keyword);

  const lines: string[] = [`<b>${item.rank}. ${isCommunity ? "📡 " : ""}${keyword}</b>`];
  if (item.seedQuery) {
    lines.push(`   seedQuery: ${escapeTelegramHtml(item.seedQuery)} · category: ${escapeTelegramHtml(item.category ?? "N/A")}`);
  }
  // 20자 내외 요약(2026-09-15 사용자 요청, generateKeywordSummaries.ts) - 클릭 전에 무슨
  // 내용인지 바로 알 수 있게. 생성 실패 시(null)엔 이 줄을 통째로 뺀다.
  if (item.summary) {
    lines.push(`   ${escapeTelegramHtml(item.summary)}`);
  }
  // 에버그린(사용설명서) 주제는 뉴스 건수·마감 개념이 없어 두 경고를 붙이지 않는다.
  const warning = evergreen ? null : thinSourceWarning(item.scoreBreakdown);
  if (warning) {
    lines.push(`   ${escapeTelegramHtml(warning)}`);
  }

  const expiry = evergreen ? null : expiryRiskWarning(item);
  if (expiry) {
    lines.push(`   ${escapeTelegramHtml(expiry)}`);
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
  /** 커뮤니티 유래 seedQuery. 일치하는 항목 제목에 📡를 붙인다. */
  communityQueries?: readonly string[];
  /** 에버그린 주제 제안(사용설명서). 뉴스·마감 경고를 붙이지 않는다. */
  evergreen?: boolean;
  /** 섹션별로 묶기(사회 데일리 리포트). 생략하면 순위대로 평평하게. */
  sections?: KeywordSectionConfig;
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
  const communityQueries = new Set((options.communityQueries ?? []).map((q) => q.trim().toLowerCase()));
  const isCommunityItem = (item: NotificationKeywordItem): boolean =>
    communityQueries.has(item.keyword.trim().toLowerCase()) ||
    (item.seedQuery !== null && communityQueries.has(item.seedQuery.trim().toLowerCase()));
  const toChunk = (item: NotificationKeywordItem): NotificationMessageChunk => ({
    text: truncateForTelegram(formatItemBlock(item, isCommunityItem(item), options.evergreen ?? false)),
    ranks: [item.rank],
  });

  if (!options.sections) {
    return [header, ...payload.items.map(toChunk)];
  }

  // 섹션 모드: 섹션 제목(버튼 없음, ranks: []) 다음에 그 섹션 항목들. 항목이 없는 섹션은 제목도 내지 않는다.
  // 제목 메시지가 따로 가는 이유는 버튼이 메시지 단위라서다(위 파일 머리말) - 항목 메시지에 제목을 섞으면 섹션
  // 첫 항목만 제목이 붙어 나머지와 모양이 달라진다.
  const { sectionOf, sections } = options.sections;
  const grouped = new Map<string, NotificationKeywordItem[]>();
  for (const item of payload.items) {
    const key = sectionOf(item, { isCommunity: isCommunityItem(item) });
    grouped.set(key, [...(grouped.get(key) ?? []), item]);
  }

  const knownKeys = new Set(sections.map((section) => section.key));
  const ordered = [
    ...sections,
    ...[...grouped.keys()].filter((key) => !knownKeys.has(key)).map((key) => ({ key, title: key })),
  ];

  const chunks: NotificationMessageChunk[] = [header];
  for (const section of ordered) {
    const members = grouped.get(section.key);
    if (!members || members.length === 0) continue;
    chunks.push({ text: `<b>${section.title}</b> · ${members.length}건`, ranks: [] });
    chunks.push(...members.map(toChunk));
  }
  return chunks;
}

function truncateForTelegram(text: string): string {
  if (text.length <= TELEGRAM_MESSAGE_CHAR_LIMIT) return text;
  return `${text.slice(0, TELEGRAM_MESSAGE_CHAR_LIMIT - 1)}…`;
}
