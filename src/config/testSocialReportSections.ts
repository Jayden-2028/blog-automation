// 사회 데일리 리포트 섹션 분류 + 경제/정책 어휘 보강 + 섹션 모드 알림 포맷 테스트.
import { classifyKeywordCategory } from "./keywordCategoryRules.js";
import { classifySocialSection, formatSocialReportHeader, SOCIAL_REPORT_SECTION_CONFIG } from "./socialReportSections.js";
import { formatNotificationMessage } from "../workflows/keyword-notification/formatNotificationMessage.js";
import type { KeywordNotificationPayload, NotificationKeywordItem } from "../types/keywordNotification.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

// 1) 어휘 보강: 경제·정책 키워드가 living으로 분류돼 사회 리포트 대상이 된다. 기존 분류는 그대로다.
const cases: Array<[string, string | null]> = [
  ["기준금리 동결 전망", "living"],
  ["국회 본회의 법안 처리", "living"],
  ["부동산 대책 발표 임박", "living"],
  ["소비자물가 상승률", "living"],
  ["부산 오피스텔 추락사", "incident"], // incident가 항상 앞
  ["연예인 부동산 매입", "entertainment"], // 연예 규칙이 앞 - 경제 어휘가 섞여도 연예 뉴스
  ["아동수당 신청방법", "parenting"], // 기존 우선순위 유지
  ["근로장려금 지급일", "living"],
];
for (const [keyword, expected] of cases) {
  const actual = classifyKeywordCategory(keyword);
  assert(actual === expected, `"${keyword}" -> ${expected}여야 한다 (실제 ${actual})`);
}
console.log("✅ 경제·정책 어휘 -> living, 기존 분류 우선순위 유지");

// 2) 섹션 분류
const sec = (keyword: string, category: string | null, isCommunity = false) =>
  classifySocialSection({ keyword, headline: null, category }, { isCommunity });
assert(sec("부산 오피스텔 추락사", "incident") === "incident", "사건사고");
assert(sec("국회 법안 처리", "living") === "policy", "정책");
assert(sec("기준금리 동결", "living") === "economy", "경제");
assert(sec("누리꾼 갑론을박", "community") === "community", "커뮤니티 category");
assert(sec("어떤 화제 키워드", "living", true) === "community", "커뮤니티 유래(📡)면 커뮤니티");
assert(sec("태풍 북상", "living") === "life", "나머지는 생활·기타");
// 사건 category는 정책·경제 어휘가 섞여도 사건이다.
assert(sec("부동산 사기 피의자 구속", "incident") === "incident", "incident category가 항상 앞");
console.log("✅ classifySocialSection");

// 3) 섹션 모드 알림 포맷: 헤더 + (섹션 제목 + 항목들)*, 제목은 버튼 없음(ranks 비어 있음), 항목 없는 섹션은 생략
function item(rank: number, keyword: string, category: string): NotificationKeywordItem {
  return { rank, keyword, headline: null, seedQuery: null, category, totalScore: 50, scoreBreakdown: null, trendDirection: null, summary: null };
}
const payload: KeywordNotificationPayload = {
  run: { id: 7, startedAt: "2026-10-05T11:00:00Z", seedQueries: [], activeSeedsCount: 1, candidatesCount: 5, clustersCount: 4, categories: ["incident", "living"] },
  items: [item(1, "기준금리 동결", "living"), item(2, "추락사 사건", "incident"), item(3, "국회 법안 처리", "living"), item(4, "태풍 북상", "living")],
};
const chunks = formatNotificationMessage(payload, { headerTitle: formatSocialReportHeader(new Date("2026-10-05T11:00:00Z")), sections: SOCIAL_REPORT_SECTION_CONFIG });

assert(chunks[0].text.includes("데일리 사회 이슈 리포트") && chunks[0].text.includes("10/9"), `헤더 문구 (${chunks[0].text.split("\n")[0]})`);
const titles = chunks.filter((c) => c.ranks.length === 0 && c !== chunks[0]).map((c) => c.text);
assert(titles.length === 4, `섹션 제목은 항목이 있는 4개만 (실제 ${titles.length}: ${titles.join(" | ")})`);
assert(!titles.some((t) => t.includes("커뮤니티")), "항목 없는 커뮤니티 섹션은 제목도 내지 않는다");
const order = chunks.slice(1).map((c) => (c.ranks.length ? `#${c.ranks[0]}` : c.text.replace(/<[^>]+>/g, "").split(" ")[1]));
// 사건(2) -> 정책(3) -> 경제(1) -> 생활(4)
assert(
  JSON.stringify(order.filter((x) => x.startsWith("#"))) === JSON.stringify(["#2", "#3", "#1", "#4"]),
  `섹션 순서(사건→정책→경제→생활)로 항목이 묶여야 한다 (실제 ${order.join(",")})`
);
// 섹션 설정이 없으면 기존처럼 평평한 목록이다.
const flat = formatNotificationMessage(payload, {});
assert(flat.length === 1 + payload.items.length && flat.slice(1).every((c) => c.ranks.length === 1), "sections 생략 시 기존 포맷 그대로");
console.log("✅ 섹션 모드 포맷 - 제목은 버튼 없음, 빈 섹션 생략, 순서 고정, 생략 시 기존 동작");

console.log("\n✅ testSocialReportSections 전체 통과");
