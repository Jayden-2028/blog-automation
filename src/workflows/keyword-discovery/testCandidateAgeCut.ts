// 수집 입구 날짜 컷(KEYWORD-HEADLINE-FRESHNESS-2026-10.md ①) 순수 함수 테스트.
// 네트워크·DB 접근이 없다 - provider를 호출하지 않고 dropStaleRawKeywords만 본다.
// 픽스처는 run 182(2026-10-21 18시 엔터) 실측 사례다.

import {
  DEFAULT_CANDIDATE_MAX_AGE_DAYS,
  dropStaleRawKeywords,
  parseCandidateMaxAgeDays,
} from "./collectNaverCandidates.js";
import type { RawKeyword } from "../../types/keywordDiscovery.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const NOW = new Date("2026-10-21T09:00:00.000Z");

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

function makeRaw(overrides: Partial<RawKeyword> & { keyword: string; source: string }): RawKeyword {
  return {
    category: "entertainment",
    metadata: { query: "테스트 시드" },
    ...overrides,
  } as RawKeyword;
}

// run 182 실측 3건 + 경계값. 날짜는 수집 시점(NOW) 기준 상대값으로 만든다.
const FIXTURE: RawKeyword[] = [
  // [7] 이미 방영 중인 작품의 9/24 기사. 27일 전이라 버려져야 한다.
  makeRaw({ keyword: "나의 유죄인간 캐스팅 확정", source: "naver_news", publishedAt: daysAgo(27) }),
  // 8일 전 뉴스 - 경계 바로 밖.
  makeRaw({ keyword: "8일 전 뉴스", source: "naver_news", publishedAt: daysAgo(8) }),
  // 6일 전 뉴스 - 경계 안쪽, 남아야 한다.
  makeRaw({ keyword: "6일 전 뉴스", source: "naver_news", publishedAt: daysAgo(6) }),
  // 정확히 7일 전 - 상한 이하라 남는다("초과"만 버린다).
  makeRaw({ keyword: "7일 전 뉴스", source: "naver_news", publishedAt: daysAgo(7) }),
  // 낡은 블로그도 버린다.
  makeRaw({ keyword: "낡은 블로그 글", source: "naver_blog", publishedAt: daysAgo(400) }),
  // 최신 블로그는 남는다.
  makeRaw({ keyword: "어제 블로그 글", source: "naver_blog", publishedAt: daysAgo(1) }),
  // [5] 2021년 웹문서. 웹은 날짜가 없어 컷 대상이 아니다 - 격하는 ②가 맡는다.
  makeRaw({ keyword: "넷플릭스 See What's Next Korea 2021", source: "naver_web" }),
  // 날짜 파싱 실패 뉴스 - 버리지 않는다.
  makeRaw({ keyword: "날짜 깨진 뉴스", source: "naver_news", publishedAt: "어제" }),
  // publishedAt이 없는 뉴스 - 버리지 않는다.
  makeRaw({ keyword: "무날짜 뉴스", source: "naver_news" }),
  // 미래 날짜(시차·오기재) - 낡음이 아니다.
  makeRaw({ keyword: "미래 날짜 뉴스", source: "naver_news", publishedAt: daysAgo(-2) }),
];

function testDefaultCut(): void {
  const { kept, ageCut } = dropStaleRawKeywords(FIXTURE, {
    maxAgeDays: DEFAULT_CANDIDATE_MAX_AGE_DAYS,
    now: NOW,
  });
  const keywords = kept.map((item) => item.keyword);

  assert(ageCut.maxAgeDays === 7, `상한은 7일이어야 합니다 (실제: ${ageCut.maxAgeDays})`);
  assert(
    ageCut.droppedBySource.naver_news === 2,
    `뉴스 2건(27일·8일 전)이 걸러져야 합니다 (실제: ${ageCut.droppedBySource.naver_news})`
  );
  assert(
    ageCut.droppedBySource.naver_blog === 1,
    `블로그 1건(400일 전)이 걸러져야 합니다 (실제: ${ageCut.droppedBySource.naver_blog})`
  );

  assert(!keywords.includes("나의 유죄인간 캐스팅 확정"), "run 182 [7] 9/24 기사가 걸러져야 합니다");
  assert(!keywords.includes("8일 전 뉴스"), "8일 전 뉴스는 걸러져야 합니다");
  assert(!keywords.includes("낡은 블로그 글"), "400일 전 블로그는 걸러져야 합니다");

  assert(keywords.includes("6일 전 뉴스"), "6일 전 뉴스는 남아야 합니다");
  assert(keywords.includes("7일 전 뉴스"), '정확히 7일 전은 "초과"가 아니라 남아야 합니다');
  assert(keywords.includes("어제 블로그 글"), "어제 블로그는 남아야 합니다");
  assert(
    keywords.includes("넷플릭스 See What's Next Korea 2021"),
    "웹문서는 날짜가 없어 컷 대상이 아닙니다(격하는 헤드라인 소스 우선순위가 맡는다)"
  );
  assert(keywords.includes("날짜 깨진 뉴스"), "날짜 파싱 실패는 버리지 않습니다");
  assert(keywords.includes("무날짜 뉴스"), "publishedAt이 없으면 버리지 않습니다");
  assert(keywords.includes("미래 날짜 뉴스"), "미래 날짜는 낡음이 아닙니다");
  assert(kept.length === 7, `7건이 남아야 합니다 (실제: ${kept.length} - ${keywords.join(", ")})`);

  console.log("✅ 기본 7일 컷: 뉴스 2 + 블로그 1 제외, 무날짜·웹·경계값 유지");
}

function testCutDisabled(): void {
  for (const maxAgeDays of [0, -1]) {
    const { kept, ageCut } = dropStaleRawKeywords(FIXTURE, { maxAgeDays, now: NOW });
    assert(
      kept.length === FIXTURE.length,
      `maxAgeDays=${maxAgeDays}면 전부 남아야 합니다 (실제: ${kept.length})`
    );
    assert(
      ageCut.droppedBySource.naver_news === 0 && ageCut.droppedBySource.naver_blog === 0,
      `maxAgeDays=${maxAgeDays}면 droppedBySource가 0이어야 합니다`
    );
  }
  console.log("✅ 스위치 off(0·음수): 무변경(롤백 경로)");
}

function testEnvParsing(): void {
  assert(parseCandidateMaxAgeDays(undefined) === 7, "미설정은 기본 7일이어야 합니다");
  assert(parseCandidateMaxAgeDays("") === 7, "빈 값은 기본 7일이어야 합니다(워크플로가 빈 vars를 넘길 수 있다)");
  assert(parseCandidateMaxAgeDays("  ") === 7, "공백만 있는 값도 기본값이어야 합니다");
  assert(parseCandidateMaxAgeDays("abc") === 7, "숫자가 아니면 기본값으로 떨어져야 합니다");
  assert(parseCandidateMaxAgeDays("3") === 3, "숫자는 그대로 쓰여야 합니다");
  assert(parseCandidateMaxAgeDays("0") === 0, '"0"은 컷 비활성이어야 합니다');
  assert(parseCandidateMaxAgeDays("-1") === -1, "음수도 컷 비활성이어야 합니다");
  console.log("✅ NAVER_CANDIDATE_MAX_AGE_DAYS 해석");
}

function main(): void {
  console.log("▶ 수집 입구 날짜 컷 테스트 시작\n");
  testDefaultCut();
  testCutDisabled();
  testEnvParsing();
  console.log("\n✅ 전체 통과");
}

main();
