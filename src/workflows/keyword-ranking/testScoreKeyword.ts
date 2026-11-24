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
// 2026-11-25 추가: 엔터 하루 창 프로필(buildDailyWindowScoringProfile) 불변식. 기본 곡선의 불변식은
// 그대로 두고(프로필 없이 채점하는 다른 트랙은 바뀌지 않았다), 프로필 쪽에 의도된 새 불변식을 건다:
// - 창(24h) 안은 시각과 무관하게 freshness 만점 - 18시 run에서 오전 9시 기사와 17시 기사가 같다.
//   (기본 곡선의 "방금 > 14시간 전 > 24시간 전" 단조 감소는 프로필에서는 **의도적으로** 깨진다.)
// - "발행일 없음 < 창 안"과 "발행일 없음 <= 창 끝+1h"는 유지 - run #14 역전(상시 문서가 Top 10 오염)이
//   하루 창에서도 재발하지 않는다.
// - 하루 기사 수가 많은 묶음이 이긴다(newsVelocity cap 15 -> 30).
//
// 외부 호출/DB 접근 없이 순수 함수만 검증한다.

import {
  buildDailyWindowScoringProfile,
  DAILY_WINDOW_SCORING_CONFIG,
  FRESHNESS_CONFIG,
  KEYWORD_SCORE_WEIGHTS,
  NEWS_VELOCITY_CONFIG,
} from "../../config/keywordScoring.js";
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

  testDailyWindowProfile();
}

// ---------- 하루 창 프로필 (2026-11-25, 엔터 전용) ----------

const DAILY = buildDailyWindowScoringProfile(24);

function dailyScore(overrides: Partial<KeywordScoreInput>) {
  return scoreKeyword(makeInput(overrides), { profile: DAILY });
}

function testDailyWindowProfile(): void {
  console.log("\n▶ 하루 창 프로필 불변식");

  const weightSum = Object.values(KEYWORD_SCORE_WEIGHTS).reduce((sum, value) => sum + value, 0);
  assert(weightSum === 100, `가중치 합은 100 그대로여야 한다 (실제 ${weightSum})`);
  assert(NEWS_VELOCITY_CONFIG.countNormalizationCap === 15, "기본 곡선 newsVelocity cap 15는 그대로(다른 트랙 불변)");
  assert(FRESHNESS_CONFIG.halfLifeHours === 12, "기본 곡선 반감기 12h는 그대로(다른 트랙 불변)");
  console.log("✅ 가중치 합 100 · 기본 곡선 값 불변");

  // 18:00 run 기준: 17:30(0.5h) / 오전 9시(9h) / 자정 직후(17.5h) / 어제 18:30(23.5h) 기사.
  const at = (hours: number) => dailyScore({ hasTimestampData: true, latestPublishedAt: hoursAgo(hours) }).freshness;
  const evening = at(0.5);
  const morning = at(9);
  const midnight = at(17.5);
  const windowEdge = at(23.5);
  console.log(`  하루 창 freshness: 0.5h ${evening} · 9h ${morning} · 17.5h ${midnight} · 23.5h ${windowEdge}`);
  assert(
    evening === KEYWORD_SCORE_WEIGHTS.freshness && morning === evening && midnight === evening && windowEdge === evening,
    "창 안은 시각과 무관하게 만점 - 오전 기사가 18시 기사에 지면 안 된다"
  );
  // 같은 두 기사를 기본 곡선으로 채점하면 오전 기사가 진다 - 바뀐 이유를 숫자로 남긴다.
  const legacyEvening = freshnessOf({ hasTimestampData: true, latestPublishedAt: hoursAgo(0.5) });
  const legacyMorning = freshnessOf({ hasTimestampData: true, latestPublishedAt: hoursAgo(9) });
  assert(legacyMorning < legacyEvening, "기본 곡선에서는 오전 기사가 진다(이번 변경의 이유)");
  console.log(`✅ 오전 9시 기사 = 18시 기사 (${morning} = ${evening}; 기본 곡선은 ${legacyMorning} < ${legacyEvening})`);

  // 창 밖은 감쇠: 창 끝부터 반감기, 창 끝 + maxHoursAfterWindow에서 0.
  const after = (h: number) => at(24 + h);
  const maxAfter = DAILY_WINDOW_SCORING_CONFIG.freshnessMaxHoursAfterWindow;
  assert(after(1) < evening, "창 밖은 만점보다 낮다");
  assert(after(1) > after(12) && after(12) > after(36), "창 밖은 오래될수록 낮다");
  assert(after(12) === Math.round(KEYWORD_SCORE_WEIGHTS.freshness / 2), "창 끝 + 반감기 = 절반");
  assert(after(maxAfter) === 0 && after(maxAfter + 10) === 0, "창 끝 + 48h(=72h)부터 0점");
  console.log(`✅ 창 밖 감쇠: +1h ${after(1)} · +12h ${after(12)} · +36h ${after(36)} · +${maxAfter}h 0`);

  // run #14 역전 불변식(날짜 없음이 이기면 안 된다)은 하루 창에서도 유지.
  const noDate = dailyScore({ hasTimestampData: false, latestPublishedAt: null }).freshness;
  assert(noDate > 0 && noDate < evening, `발행일 없음(${noDate})은 0보다 크고 창 안(${evening})보다 낮다`);
  assert(noDate <= after(1), `발행일 없음(${noDate}) <= 창 끝+1h(${after(1)})`);
  console.log(`✅ 0 < 발행일 없음(${noDate}) < 창 안(${evening}), <= 창 끝+1h(${after(1)})`);

  // 하루 기사 많은 묶음이 이긴다(같은 batch percentile). 기본 cap 15에서는 둘 다 포화돼 동점이었다.
  const velocity = (newsCount: number, profile: boolean) => {
    const input = makeInput({
      newsCount,
      newsCountPercentile: 0.9,
      hasTimestampData: true,
      latestPublishedAt: hoursAgo(2),
      sources: ["naver_news"],
    });
    return (profile ? scoreKeyword(input, { profile: DAILY }) : scoreKeyword(input)).newsVelocity;
  };
  assert(velocity(28, true) > velocity(15, true), "하루 28건 묶음 > 15건 묶음");
  assert(velocity(15, true) > velocity(5, true), "15건 > 5건");
  assert(velocity(28, false) === velocity(15, false), "기본 cap 15에서는 15건 이상이 동점(변별 없음)");
  assert(velocity(60, true) === velocity(30, true), "cap(30) 이상은 절대 신호가 포화된다");
  console.log(
    `✅ newsVelocity: 28건 ${velocity(28, true)} > 15건 ${velocity(15, true)} > 5건 ${velocity(5, true)} ` +
      `(기본 cap에선 28건 = 15건 = ${velocity(15, false)})`
  );

  // 종합: 아침에 터져 하루 종일 다뤄진 사안(오전 9시 첫 보도~16시, 기사 25건) vs
  // 18시 직전 잡기사(17:50, 1건). 나머지 항목은 같게 둔다.
  const bigMorning = makeInput({
    newsCount: 25,
    newsCountPercentile: 0.95,
    hasTimestampData: true,
    earliestPublishedAt: hoursAgo(9),
    latestPublishedAt: hoursAgo(2),
    sources: ["naver_news"],
  });
  const lastMinute = makeInput({
    newsCount: 1,
    newsCountPercentile: 0.3,
    hasTimestampData: true,
    earliestPublishedAt: hoursAgo(10 / 60),
    latestPublishedAt: hoursAgo(10 / 60),
    sources: ["naver_news"],
  });
  const bigDaily = scoreKeyword(bigMorning, { profile: DAILY }).total;
  const lastDaily = scoreKeyword(lastMinute, { profile: DAILY }).total;
  assert(bigDaily > lastDaily, `하루 큰 사안(${bigDaily})이 18시 직전 1건(${lastDaily})을 이긴다`);
  // freshness 차이가 없어졌으므로 격차는 newsVelocity에서만 온다.
  assert(
    scoreKeyword(bigMorning, { profile: DAILY }).freshness === scoreKeyword(lastMinute, { profile: DAILY }).freshness,
    "두 사안의 freshness는 같다"
  );
  console.log(`✅ 하루 큰 사안 ${bigDaily}점 > 18시 직전 1건 ${lastDaily}점`);

  // 프로필은 freshness·newsVelocity만 바꾼다.
  const rich = makeInput({
    newsCount: 7,
    blogCount: 6,
    webCount: 3,
    newsCountPercentile: 0.7,
    contentCountPercentile: 0.6,
    hasTimestampData: true,
    latestPublishedAt: hoursAgo(5),
    sources: ["naver_news", "naver_blog", "naver_web"],
    headline: "현혹 공개일 확정 출연진",
    trendDeltaPercent: 12,
    trendShortTermChangePercent: 20,
  });
  const base = scoreKeyword(rich);
  const daily = scoreKeyword(rich, { profile: DAILY });
  for (const key of ["trendMomentum", "contentDemand", "crossSourceSignal", "clickPotential"] as const) {
    assert(base[key] === daily[key], `${key}는 프로필과 무관해야 한다 (${base[key]} vs ${daily[key]})`);
  }
  console.log("✅ 프로필은 freshness·newsVelocity만 바꾼다(나머지 네 항목 동일)");

  console.log("\n✅ 하루 창 프로필 불변식 테스트 완료");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
