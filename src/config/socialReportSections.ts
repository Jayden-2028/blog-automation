// 사회 이슈 데일리 리포트의 섹션 분류. category(집필 스킬 선택용)와 별개의 **표시용** 분류라
// 틀려도 원고가 잘못 만들어지지 않는다 - 그래서 어휘 규칙만으로 가볍게 판정한다.
//
// **2026-11-01 개편.** 티스토리 독자를 4060 남성으로 잡고 정치를 받기로 하면서 섹션을 다시 짰다.
//   - `🏛 정책·국회` → `🏛 정치·국정` + `📋 정책·제도`로 가른다. 정치를 받으니 한 칸에 섞으면
//     정책 안내와 정치 공방이 한 덩어리가 된다.
//   - `🏠 생활·기타`를 접고 `📡 화제·발견`에 합친다. 발행본 실측에서 생활 혜택이 평균 조회수
//     0.64배로 하위였고, 티스토리 카테고리도 `화제와 발견` 한 칸으로 모았다.
//
// 우선순위: 사건사고 > 정치 > 정책 > 경제 > 화제. 사건사고가 맨 앞인 이유는 keywordCategoryRules의
// incident와 같다 - 사건 어휘가 있으면 다른 어휘가 섞여 있어도 사건이다. 정치가 정책·경제보다
// 앞인 이유는 "국민연금 성과급 국정감사"처럼 셋이 겹칠 때 독자가 보는 것이 정치 공방이기 때문이다.
import { SOCIAL_ECONOMY_TERMS, SOCIAL_POLICY_TERMS } from "./keywordCategoryRules.js";
import { POLITICAL_EXCLUSION_TERMS } from "./keywordExclusionRules.js";
import type { KeywordSectionConfig, NotificationKeywordItem } from "../types/keywordNotification.js";

export type SocialSection = "incident" | "politics" | "policy" | "economy" | "community";

export const SOCIAL_SECTIONS: readonly { key: SocialSection; title: string }[] = [
  { key: "incident", title: "🚨 사건·사고" },
  { key: "politics", title: "🏛 정치·국정" },
  { key: "policy", title: "📋 정책·제도" },
  { key: "economy", title: "💰 경제·부동산" },
  { key: "community", title: "📡 화제·발견" },
];

function includesAny(text: string, terms: readonly string[]): boolean {
  return terms.some((term) => text.includes(term.toLowerCase()));
}

export function classifySocialSection(
  item: Pick<NotificationKeywordItem, "keyword" | "headline" | "category">,
  context: { isCommunity: boolean }
): SocialSection {
  if (item.category === "incident") return "incident";

  // 키워드는 앞에서 잘린 축약일 수 있어 제목과 함께 본다(formatNotificationMessage.expiryRiskWarning과 같은 이유).
  const haystack = `${item.keyword} ${item.headline ?? ""}`.toLowerCase();
  if (includesAny(haystack, POLITICAL_EXCLUSION_TERMS)) return "politics";
  if (includesAny(haystack, SOCIAL_POLICY_TERMS)) return "policy";
  if (includesAny(haystack, SOCIAL_ECONOMY_TERMS)) return "economy";

  // 남는 것은 전부 화제·발견이다(옛 `life`는 2026-11-01에 접었다).
  void context;
  return "community";
}

/**
 * **공분 신호**(2026-11-01). 힘 가진 쪽 - 권력자·기관·기업 - 이 무엇을 잘못했는지 짚는 키워드인가.
 *
 * 근거: 발행본 103건(게시 7일 경과) 실측에서 이 모양의 글이 **평균 조회수 3.91배, 중앙값 3.0배**였다.
 * 가장 잘 된 카테고리(정치 1.46배)보다 2.7배 강하다. 상위 20건 중 11건이 이 모양이고 하위 20건 중
 * 4건이다. 상위 글이 전부 같다 - 대표 폭행(221) · 원장 326일 출장 국감(142) · 의전 논란(138) ·
 * 병원 압수수색(117) · 육아휴직 불이익(95) · 매장 난동 임원(57).
 *
 * **점수에는 넣지 않는다.** 6-factor scoring 변경은 승인 항목이고, 되돌리기도 어렵다. 알림에
 * 🔥만 붙여 사용자가 Go를 누를 때 참고하게 한다(2026-11-01 사용자 승인).
 */
const OUTRAGE_TERMS: readonly string[] = [
  "갑질", "특혜", "비위", "의혹", "논란", "지적", "해명", "사과", "부실", "난동", "폭행",
  "수의계약", "의전", "잔치", "불이익", "과잉", "압수수색", "봐주기", "바가지", "전관",
  "비판", "은폐", "축소", "방만", "유용", "횡령", "배임", "직권남용", "책임 회피",
];

export function isOutrageSignal(item: Pick<NotificationKeywordItem, "keyword" | "headline">): boolean {
  const text = `${item.keyword} ${item.headline ?? ""}`;
  return OUTRAGE_TERMS.some((term) => text.includes(term));
}

/** 알림 항목 제목에 붙일 뱃지. 지금은 공분 신호 하나뿐이다. */
export function socialItemBadge(item: Pick<NotificationKeywordItem, "keyword" | "headline">): string | null {
  return isOutrageSignal(item) ? "🔥" : null;
}

/**
 * 사회 리포트에 섞여 들어온 **엔터 키워드** 판정(2026-10-05 사용자 요청: 트롯 키친·암살자들·이수영 아들·안판석
 * 감독 유작). category는 키워드 어휘만으로 정해져서 사람 이름·프로그램명뿐인 키워드("암살자들")는 엔터로
 * 못 잡고 living/community로 떨어진다. 그래서 **제목(headline)까지** 보고 엔터 어휘로 거른다.
 *
 * 사건사고(incident)는 거르지 않는다 - 연예인이 얽힌 실제 사건(음주운전·폭행)은 사회 이슈이고, 엔터 알림은
 * incident를 받지 않는다. 짧고 흔한 말("방송", "출연", "감독")은 일부러 뺐다: 금융감독원·방송통신위원회 같은
 * 사회 뉴스를 잘못 지운다. "배우"는 "배우자"와 구분한다.
 *
 * **어휘로는 못 잡는 구멍이 있다**(2026-11-01): 강유미·한은서·김용건·이찬혁처럼 **사람 이름만** 있는
 * 키워드는 엔터 어휘가 하나도 없다. 그쪽은 `entertainmentPicksOfDay.ts`가 "오늘 엔터 run이 이미
 * 집어 갔는가"로 따로 잡는다. 이 함수는 그대로 두고 그쪽을 더한다.
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
