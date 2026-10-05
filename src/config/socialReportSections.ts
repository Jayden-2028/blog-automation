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
