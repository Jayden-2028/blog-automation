// scoreKeyword()의 freshness 불변식 테스트.
//
// 왜 필요한가(2026-08-26 실측): FRESHNESS_CONFIG.neutralScoreRatio가 0.5였을 때
// "발행일 없음"(15 * 0.5 = 8점)이 "오늘 발행"(15 * 0.5^(14/12) = 7점)을 이겼다. 발행일이 없는 건
// 대부분 naver_web 결과(나무위키, 정부 랜딩페이지)로 상시 문서인데도, run #14에서 발행일 없는 3건이
// 전부 이 역전 덕에 Top 10에 올랐다.
//
// 이 테스트는 그 역전이 다시 생기지 않도록 부등식을 고정한다. neutralScoreRatio를 다시 올리거나
// halfLifeHours/maxAgeHours를 바꿔 부등식이 깨지면 여기서 잡힌다.
//
// 외부 호출/DB 접근 없이 순수 함수만 검증한다.

import { FRESHNESS_CONFIG, KEYWORD_SCORE_WEIGHTS } from "../../config/keywordScoring.js";
import { scoreKeyword } from "./scoreKeyword.js";
import type { KeywordScoreInput } from "../../types/keywordScoring.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const NOW = new Date("2026-08-26T14:00:00.000Z");

function hoursAgo(hours: number): string {
  return new Date(NOW.getTime() - hours * 60 * 60 * 1000).toISOString();
}

/** freshness만 비교하기 위해 다른 factor는 전부 0이 되도록 고정한 입력을 만든다. */
function makeInput(overrides: Partial<KeywordScoreInput>): KeywordScoreInput {
  return {
    keyword: "테스트",
    headline: "테스트",
    seedQuery: null,
    seedQuerySelectionNote: null,
    category: "living",
    sources: ["naver_blog"],
    relatedCount: 1,
    newsCount: 0,
    blogCount: 0,
    webCount: 0,
    earliestPublishedAt: null,
    latestPublishedAt: null,
    trendLatestRatio: null,
    trendPreviousRatio: null,
    trendShortAverage: null,
    trendPreviousAverage: null,
    trendSlope: null,
    trendDeltaPercent: null,
    trendShortTermChangePercent: null,
    trendDirection: "unknown",
    newsCountPercentile: 0,
    contentCountPercentile: 0,
    hasTimestampData: false,
    now: NOW,
    ...overrides,
  } as KeywordScoreInput;
}

function freshnessOf(overrides: Partial<KeywordScoreInput>): number {
  return scoreKeyword(makeInput(overrides)).freshness;
}

function main(): void {
  console.log("▶ scoreKeyword freshness 불변식 테스트 시작\n");

  const noDate = freshnessOf({ hasTimestampData: false, latestPublishedAt: null });
  const justNow = freshnessOf({ hasTimestampData: true, latestPublishedAt: hoursAgo(0) });
  const sameDay = freshnessOf({ hasTimestampData: true, latestPublishedAt: hoursAgo(14) });
  const oneDay = freshnessOf({ hasTimestampData: true, latestPublishedAt: hoursAgo(24) });
  const veryOld = freshnessOf({ hasTimestampData: true, latestPublishedAt: hoursAgo(100) });

  console.log(`  발행일 없음   ${noDate}점`);
  console.log(`  방금 발행     ${justNow}점`);
  console.log(`  14시간 전     ${sameDay}점`);
  console.log(`  24시간 전     ${oneDay}점`);
  console.log(`  100시간 전    ${veryOld}점`);

  // 핵심 불변식: "날짜 모름"은 당일 발행 글을 이기면 안 된다. 이게 run #14 오염의 직접 원인이었다.
  assert(
    noDate < sameDay,
    `발행일 없음(${noDate})은 당일 발행(${sameDay})보다 낮아야 한다 - ` +
      `neutralScoreRatio가 너무 높으면 상시 문서가 Top 10을 오염시킨다`
  );
  console.log(`\n✅ 발행일 없음(${noDate}) < 당일 발행(${sameDay})`);

  // 그렇다고 0이어서도 안 된다 - web 문서만으로 구성된 cluster를 "완전히 오래됨"과 동일 취급하면
  // 부당하게 불리해진다는 것이 원래 설계 의도다.
  assert(noDate > 0, `발행일 없음(${noDate})은 0보다 커야 한다 - web-only cluster를 0점으로 몰지 않는다`);
  assert(noDate <= oneDay, `발행일 없음(${noDate})은 24시간 전(${oneDay}) 이하여야 한다`);
  console.log(`✅ 0 < 발행일 없음(${noDate}) <= 24시간 전(${oneDay})`);

  // 감쇠가 단조 감소해야 한다.
  assert(justNow > sameDay && sameDay > oneDay, "오래될수록 점수가 낮아져야 한다");
  assert(justNow === KEYWORD_SCORE_WEIGHTS.freshness, `방금 발행은 만점(${KEYWORD_SCORE_WEIGHTS.freshness})이어야 한다`);
  console.log(`✅ 감쇠 단조 감소 + 방금 발행 만점(${justNow})`);

  // maxAgeHours를 넘으면 0.
  assert(veryOld === 0, `maxAgeHours(${FRESHNESS_CONFIG.maxAgeHours}h) 초과는 0점이어야 한다 (실제: ${veryOld})`);
  console.log(`✅ ${FRESHNESS_CONFIG.maxAgeHours}시간 초과 -> 0점`);

  // hasTimestampData=true인데 날짜가 null이면 0점(방어적 경로).
  assert(
    freshnessOf({ hasTimestampData: true, latestPublishedAt: null }) === 0,
    "타임스탬프가 있다고 표시됐지만 값이 null이면 0점이어야 한다"
  );
  console.log("✅ hasTimestampData=true + null 날짜 -> 0점");

  console.log("\n✅ scoreKeyword freshness 불변식 테스트 완료");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
