// 사회 이슈 데일리 리포트의 섹션 분류(RESTRUCTURE-PLAN-2026-10.md §3.2). 사건사고 / 정책 / 경제 / 커뮤니티 화제
// 순으로 키워드 목록을 묶는다. category(집필 스킬 선택용)와 별개의 **표시용** 분류라 틀려도 원고가 잘못
// 만들어지지 않는다 - 그래서 어휘 규칙만으로 가볍게 판정한다.
//
// 우선순위: 사건사고 > 정책 > 경제 > 커뮤니티 > 생활. 사건사고가 맨 앞인 이유는 keywordCategoryRules의
// incident와 같다 - 사건 어휘가 있으면 다른 어휘가 섞여 있어도 사건이다.
import { SOCIAL_ECONOMY_TERMS, SOCIAL_POLICY_TERMS } from "./keywordCategoryRules.js";
import type { KeywordSectionConfig, NotificationKeywordItem } from "../types/keywordNotification.js";

export type SocialSection = "incident" | "policy" | "economy" | "community" | "life";

export const SOCIAL_SECTIONS: readonly { key: SocialSection; title: string }[] = [
  { key: "incident", title: "🚨 사건·사고" },
  { key: "policy", title: "🏛 정책·국회" },
  { key: "economy", title: "💰 경제·부동산" },
  { key: "community", title: "📡 커뮤니티 화제" },
  { key: "life", title: "🏠 생활·기타" },
];

function includesAny(text: string, terms: readonly string[]): boolean {
  return terms.some((term) => text.includes(term));
}

export function classifySocialSection(
  item: Pick<NotificationKeywordItem, "keyword" | "headline" | "category">,
  context: { isCommunity: boolean }
): SocialSection {
  if (item.category === "incident") return "incident";

  // 키워드는 앞에서 잘린 축약일 수 있어 제목과 함께 본다(formatNotificationMessage.expiryRiskWarning과 같은 이유).
  const haystack = `${item.keyword} ${item.headline ?? ""}`.toLowerCase();
  if (includesAny(haystack, SOCIAL_POLICY_TERMS)) return "policy";
  if (includesAny(haystack, SOCIAL_ECONOMY_TERMS)) return "economy";

  if (context.isCommunity || item.category === "community") return "community";
  return "life";
}

/**
 * 사회 리포트에 섞여 들어온 **엔터 키워드** 판정(2026-10-05 사용자 요청: 트롯 키친·암살자들·이수영 아들·안판석
 * 감독 유작). category는 키워드 어휘만으로 정해져서 사람 이름·프로그램명뿐인 키워드("암살자들")는 엔터로
 * 못 잡고 living/community로 떨어진다. 그래서 **제목(headline)까지** 보고 엔터 어휘로 거른다.
 *
 * 사건사고(incident)는 거르지 않는다 - 연예인이 얽힌 실제 사건(음주운전·폭행)은 사회 이슈이고, 엔터 알림은
 * incident를 받지 않는다. 짧고 흔한 말("방송", "출연", "감독")은 일부러 뺐다: 금융감독원·방송통신위원회 같은
 * 사회 뉴스를 잘못 지운다. "배우"는 "배우자"와 구분한다.
 */
const ENTERTAINMENT_TERMS: readonly string[] = [
  "영화", "드라마", "예능", "가수", "아이돌", "트롯", "트로트", "디너쇼", "콘서트", "팬미팅", "뮤지컬",
  "라디오", "시청률", "박스오피스", "개그맨", "코미디언", "연예인", "연예계", "소속사", "앨범", "컴백",
  "유작", "넷플릭스", "티빙", "웨이브", "쿠팡플레이", "예고편", "출연진", "개봉", "OST", "팬덤",
];
const ENTERTAINMENT_PATTERNS: readonly RegExp[] = [/배우(?!자)/, /영화감독|드라마 ?감독|감독님/];

export function isEntertainmentLeak(item: Pick<NotificationKeywordItem, "keyword" | "headline" | "category">): boolean {
  if (item.category === "incident") return false;
  const text = `${item.keyword} ${item.headline ?? ""}`;
  return ENTERTAINMENT_TERMS.some((term) => text.includes(term)) || ENTERTAINMENT_PATTERNS.some((re) => re.test(text));
}

export const SOCIAL_REPORT_SECTION_CONFIG: KeywordSectionConfig = {
  sectionOf: (item, context) => classifySocialSection(item, context),
  sections: SOCIAL_SECTIONS,
};

/** "📰 데일리 사회 이슈 리포트 — 10/4(토)". now는 테스트 주입용. */
export function formatSocialReportHeader(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "numeric",
    day: "numeric",
    weekday: "short",
  }).formatToParts(now);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  return `📰 <b>데일리 사회 이슈 리포트 — ${get("month")}/${get("day")}(${get("weekday")})</b>`;
}
