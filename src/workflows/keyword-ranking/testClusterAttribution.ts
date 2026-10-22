// 헤드라인 소스 우선순위(KEYWORD-HEADLINE-FRESHNESS-2026-10.md ②) 테스트.
// resolveClusterAttribution은 순수 함수다 - 네트워크·DB 접근이 없다.
// 픽스처는 run 182(2026-10-21) [2] "11월 결혼 취소 케데헌 이재" 사례다.

import {
  headlineSourceGrade,
  parseHeadlineSourcePriority,
  resolveClusterAttribution,
} from "./clusterAttribution.js";
import type { KeywordCandidate } from "../../types/keywordDiscovery.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

function makeCandidate(
  keyword: string,
  source: string,
  options: { publishedAt?: string | null; relevance?: number; query?: string; category?: string } = {}
): KeywordCandidate {
  return {
    keyword,
    category: options.category ?? "entertainment",
    source,
    trendScore: 0,
    sourceUrl: null,
    publishedAt: options.publishedAt ?? null,
    metadata: {
      query: options.query ?? "이재 샘킴 결혼",
      relevanceScore: options.relevance ?? 1,
    },
  };
}

// run 182 재현: 루머성 블로그 제목이 relevanceScore가 가장 높았고, 정상 기사가 같은 풀에 있었다.
function rumorCluster(): KeywordCandidate[] {
  return [
    makeCandidate("11월 결혼 취소 케데헌 이재", "naver_blog", {
      publishedAt: "2026-10-20T01:00:00.000Z",
      relevance: 0.95,
    }),
    makeCandidate("이재 샘 킴과 부부 됐다", "naver_news", {
      publishedAt: "2026-10-21T02:00:00.000Z",
      relevance: 0.7,
    }),
    makeCandidate("가수 이재 결혼식 현장", "naver_news", {
      publishedAt: "2026-10-19T02:00:00.000Z",
      relevance: 0.6,
    }),
  ];
}

function testNewsBeatsRumorBlog(): void {
  const attribution = resolveClusterAttribution(rumorCluster(), {}, { headlineSourcePriority: true });

  assert(
    attribution.headline === "이재 샘 킴과 부부 됐다",
    `뉴스 제목이 채택돼야 합니다 (실제: ${attribution.headline})`
  );
  assert(attribution.seedQuery === "이재 샘킴 결혼", "대표 seedQuery는 그대로여야 합니다");
  console.log("✅ 뉴스 1건이라도 있으면 블로그 루머 제목이 keyword가 되지 않는다");
}

function testSwitchOffKeepsLegacyOrder(): void {
  const attribution = resolveClusterAttribution(rumorCluster(), {}, { headlineSourcePriority: false });

  assert(
    attribution.headline === "11월 결혼 취소 케데헌 이재",
    `스위치 off면 기존 동작(relevance 최고)이어야 합니다 (실제: ${attribution.headline})`
  );
  console.log("✅ HEADLINE_SOURCE_PRIORITY=false -> 기존 정렬 복귀(롤백 경로)");
}

function testDatedBlogBeatsUndatedWeb(): void {
  const items = [
    makeCandidate("넷플릭스 See What's Next Korea 2021", "naver_web", { relevance: 0.99 }),
    makeCandidate("넷플릭스 공개 예정 라인업 정리", "naver_blog", {
      publishedAt: "2026-10-20T05:00:00.000Z",
      relevance: 0.5,
    }),
  ];
  const attribution = resolveClusterAttribution(items, {}, { headlineSourcePriority: true });

  assert(
    attribution.headline === "넷플릭스 공개 예정 라인업 정리",
    `날짜 있는 블로그가 무날짜 웹문서를 이겨야 합니다 (실제: ${attribution.headline})`
  );
  console.log("✅ run 182 [5]: 날짜 없는 2021년 웹문서는 등급 최하위로 밀린다");
}

function testSameGradeKeepsExistingOrder(): void {
  // 같은 등급(날짜 있는 뉴스)끼리는 기존 정렬 그대로: relevance -> 최신 -> 짧은 제목.
  const items = [
    makeCandidate("뉴스 관련도 낮음", "naver_news", {
      publishedAt: "2026-10-21T08:00:00.000Z",
      relevance: 0.4,
    }),
    makeCandidate("뉴스 관련도 높음", "naver_news", {
      publishedAt: "2026-10-18T08:00:00.000Z",
      relevance: 0.9,
    }),
  ];
  const attribution = resolveClusterAttribution(items, {}, { headlineSourcePriority: true });

  assert(
    attribution.headline === "뉴스 관련도 높음",
    `등급이 같으면 relevance가 이겨야 합니다 (실제: ${attribution.headline})`
  );

  const sameRelevance = [
    makeCandidate("오래된 뉴스", "naver_news", {
      publishedAt: "2026-10-16T08:00:00.000Z",
      relevance: 0.8,
    }),
    makeCandidate("최신 뉴스", "naver_news", {
      publishedAt: "2026-10-21T08:00:00.000Z",
      relevance: 0.8,
    }),
  ];
  assert(
    resolveClusterAttribution(sameRelevance, {}, { headlineSourcePriority: true }).headline ===
      "최신 뉴스",
    "등급·relevance가 같으면 최신이 이겨야 합니다"
  );
  console.log("✅ 등급 안에서는 기존 정렬(relevance -> 날짜 -> 길이) 불변");
}

function testMultiSeedSelectionUnchanged(): void {
  // 대표 seedQuery 선택(candidate 수 -> 평균 relevance -> priority)은 이번 변경 대상이 아니다.
  const items = [
    makeCandidate("A 시드 뉴스1", "naver_news", { query: "A 시드", publishedAt: "2026-10-21T01:00:00.000Z" }),
    makeCandidate("A 시드 뉴스2", "naver_news", { query: "A 시드", publishedAt: "2026-10-21T02:00:00.000Z" }),
    makeCandidate("B 시드 블로그", "naver_blog", { query: "B 시드", publishedAt: "2026-10-21T03:00:00.000Z" }),
  ];
  const attribution = resolveClusterAttribution(items, {}, { headlineSourcePriority: true });

  assert(attribution.seedQuery === "A 시드", `candidate가 많은 시드가 대표여야 합니다 (실제: ${attribution.seedQuery})`);
  assert(
    attribution.headline.startsWith("A 시드"),
    `headline은 대표 시드 그룹 안에서만 골라야 합니다 (실제: ${attribution.headline})`
  );
  assert(attribution.selectionNote !== null, "복수 시드면 선택 사유가 남아야 합니다");
  console.log("✅ 대표 seedQuery 선택 규칙은 비접촉");
}

function testGradeAndEnvParsing(): void {
  assert(
    headlineSourceGrade(makeCandidate("뉴스", "naver_news", { publishedAt: "2026-10-21T00:00:00.000Z" })) === 0,
    "날짜 있는 뉴스는 0등급"
  );
  assert(
    headlineSourceGrade(makeCandidate("블로그", "naver_blog", { publishedAt: "2026-10-21T00:00:00.000Z" })) === 1,
    "날짜 있는 블로그는 1등급"
  );
  assert(headlineSourceGrade(makeCandidate("웹", "naver_web")) === 2, "웹문서는 2등급");
  assert(
    headlineSourceGrade(makeCandidate("무날짜 뉴스", "naver_news")) === 2,
    "날짜 없는 뉴스는 2등급(판정 기준은 publishedAt 보유 + source다)"
  );
  assert(
    headlineSourceGrade(makeCandidate("깨진 날짜 뉴스", "naver_news", { publishedAt: "어제" })) === 2,
    "날짜 파싱 실패도 2등급"
  );

  assert(parseHeadlineSourcePriority(undefined) === true, "미설정은 켜짐");
  assert(parseHeadlineSourcePriority("") === true, "빈 값은 켜짐");
  assert(parseHeadlineSourcePriority("false") === false, '"false"면 꺼짐');
  assert(parseHeadlineSourcePriority("FALSE") === false, "대문자도 꺼짐");
  assert(parseHeadlineSourcePriority("0") === false, '"0"도 꺼짐');
  assert(parseHeadlineSourcePriority("true") === true, '"true"는 켜짐');
  console.log("✅ 등급 판정 + HEADLINE_SOURCE_PRIORITY 해석");
}

function main(): void {
  console.log("▶ 헤드라인 소스 우선순위 테스트 시작\n");
  testNewsBeatsRumorBlog();
  testSwitchOffKeepsLegacyOrder();
  testDatedBlogBeatsUndatedWeb();
  testSameGradeKeepsExistingOrder();
  testMultiSeedSelectionUnchanged();
  testGradeAndEnvParsing();
  console.log("\n✅ 전체 통과");
}

main();
