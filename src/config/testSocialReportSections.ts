// 사회 데일리 리포트 섹션 분류 + 경제/정책 어휘 보강 + 섹션 모드 알림 포맷 테스트.
import { classifyKeywordCategory } from "./keywordCategoryRules.js";
import {
  classifySocialSection,
  formatSocialReportHeader,
  isEntertainmentLeak,
  isOutrageSignal,
  socialItemBadge,
  SOCIAL_REPORT_SECTION_CONFIG,
} from "./socialReportSections.js";
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
// 2026-11-01: `life`를 접고 나머지는 전부 화제·발견으로 간다.
assert(sec("태풍 북상", "living") === "community", "나머지는 화제·발견");
// 정치 섹션 신설. 정책·경제 어휘보다 먼저다.
assert(sec("국민의힘 원내대표 발언", "living") === "politics", "정당 어휘는 정치");
assert(sec("국민연금 성과급 300억", "living", false) === "economy", "정치 어휘가 없으면 경제");
assert(sec("국정감사 국민연금 성과급 지적", "living") === "politics", "정치 어휘가 있으면 정치가 이긴다");
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

assert(chunks[0].text.includes("데일리 사회 이슈 리포트") && chunks[0].text.includes("10/5"), `헤더 문구 (${chunks[0].text.split("\n")[0]})`);
const titles = chunks.filter((c) => c.ranks.length === 0 && c !== chunks[0]).map((c) => c.text);
assert(titles.length === 4, `섹션 제목은 항목이 있는 4개만 (실제 ${titles.length}: ${titles.join(" | ")})`);
assert(!titles.some((t) => t.includes("정치")), "항목 없는 정치 섹션은 제목도 내지 않는다");
const order = chunks.slice(1).map((c) => (c.ranks.length ? `#${c.ranks[0]}` : c.text.replace(/<[^>]+>/g, "").split(" ")[1]));
// 사건(2) -> 정책(3) -> 경제(1) -> 화제(4)
assert(
  JSON.stringify(order.filter((x) => x.startsWith("#"))) === JSON.stringify(["#2", "#3", "#1", "#4"]),
  `섹션 순서(사건→정책→경제→화제)로 항목이 묶여야 한다 (실제 ${order.join(",")})`
);
// 섹션 설정이 없으면 기존처럼 평평한 목록이다.
const flat = formatNotificationMessage(payload, {});
assert(flat.length === 1 + payload.items.length && flat.slice(1).every((c) => c.ranks.length === 1), "sections 생략 시 기존 포맷 그대로");
console.log("✅ 섹션 모드 포맷 - 제목은 버튼 없음, 빈 섹션 생략, 순서 고정, 생략 시 기존 동작");

// 4) 엔터 제외: 2026-10-05 실제 리포트에 섞였던 4건은 걸러지고, 사회 이슈·연예인 얽힌 사건은 남는다
const leak = (keyword: string, headline: string | null, category: string | null = "living") =>
  isEntertainmentLeak({ keyword, headline, category });
assert(leak("트롯 키친", "'트롯 키친' 김용빈·안성훈, 특별한 무대로 디너쇼 마무리"), "트롯 키친");
assert(leak("암살자들", "유해진 자택 앞 시위 논란 영화 암살자들 흥행 뒤에 숨은 서늘한 풍경", "community"), "암살자들(영화)");
assert(leak("이수영 아들", "이수영 아들 급성 백혈병 | 라디오 중단 이유"), "이수영 아들(가수·라디오)");
assert(leak("안판석 감독 유작", "\"감독님 그리워\"…배우 김소현, 故 안판석 감독 유작 '연애박사'에 전한..."), "안판석 감독 유작");
assert(!leak("금융감독원 보이스피싱 대책", "금융감독원 발표"), "금융감독원은 엔터가 아니다");
assert(!leak("배우자 출산휴가 확대", null), "배우자는 배우가 아니다");
assert(!leak("방송통신위원회 과징금", "방통위 제재"), "방송통신위원회는 엔터가 아니다");
assert(!leak("가수 음주운전 적발", "가수 음주운전", "incident"), "연예인이 얽힌 사건(incident)은 사회 이슈로 남긴다");
console.log("✅ isEntertainmentLeak - 실제 섞였던 4건 제외, 사회 뉴스·사건은 유지");

// 5) 공분 신호 뱃지(2026-11-01). 실측 상위 글의 모양을 잡고, 평범한 안내 글에는 안 붙는다.
const outrage = (keyword: string, headline: string | null = null) => isOutrageSignal({ keyword, headline });
assert(outrage("박윤규 정보통신산업진흥원장 근무일 375일 중 326일 출장 국감 지적"), "실측 2위: 출장·지적");
assert(outrage("오가닉포에버 박평순 대표 폭행 논란"), "실측 1위: 폭행·논란");
assert(outrage("육아휴직자에 불이익 준 국가기관?"), "실측: 불이익");
assert(outrage("순창장류축제 박혜원 공연 중단 김민석 의전 논란"), "실측: 의전·논란");
assert(!outrage("아동수당 언제 받을까? 9세 미만으로 확대"), "지원금 안내는 공분형이 아니다");
assert(!outrage("국내 최초 번식 쌍둥이 레서판다 마루·마롱"), "동물 소식은 공분형이 아니다");
assert(socialItemBadge({ keyword: "채소가게 온누리상품권 결제 의혹", headline: null }) === "🔥", "공분형엔 🔥");
assert(socialItemBadge({ keyword: "레서판다 쌍둥이 공개", headline: null }) === null, "그 외엔 뱃지 없음");

// 뱃지가 실제 메시지에 붙는지
const badged = formatNotificationMessage(payload, { itemBadge: () => "🔥" });
assert(badged[1].text.includes("🔥"), "itemBadge가 항목 제목에 붙어야 한다");
const unbadged = formatNotificationMessage(payload, {});
assert(!unbadged[1].text.includes("🔥"), "itemBadge가 없으면 안 붙는다");
console.log("✅ 공분 신호 🔥 - 실측 상위 글 적중, 안내·동물 글은 제외, 메시지에 반영");

console.log("\n✅ testSocialReportSections 전체 통과");
