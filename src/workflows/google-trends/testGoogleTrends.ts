// 구글 트렌드 RSS 파서 + candidate 매핑 + 수집 배선 테스트.
// 외부 호출/DB 접근 없이 fixture와 주입된 함수만 사용한다.
//
// 두 가지를 고정한다.
//
// 1) **이상한 응답에도 죽지 않는다.** 외부 피드는 언제든 구조가 바뀌거나 오류 페이지를 준다.
//    그때 daily job이 죽는 것이 가장 큰 위험이므로, 깨진 입력은 예외가 아니라 0건이어야 한다.
// 2) **첫 실측 데이터(2026-08-29 KR TOP 10)의 분류 결과.** 그 10건에서 category 분류의 실제 한계가
//    드러났다 - 9건이 키워드 어휘에 안 걸려 전부 living으로 떨어졌고, 그중 유재석/오연수/엄태웅은
//    명백한 연예 뉴스였다. 뉴스 출처 신호를 넣어 해결했으므로 그 데이터를 회귀 케이스로 박아둔다.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { parseGoogleTrendsRss, parseApproxTraffic, decodeXmlEntities } from "../../services/search/providers/googleTrends/parseGoogleTrendsRss.js";
import { fetchGoogleTrends } from "../../services/search/providers/googleTrends/GoogleTrendsProvider.js";
import {
  mapGoogleTrendsItemsToInserts,
  resolveGoogleTrendsCategory,
  isUsableTrendKeyword,
  GOOGLE_TRENDS_SOURCE,
} from "./mapGoogleTrendsCandidates.js";
import type { GoogleTrendsItem } from "../../services/search/providers/googleTrends/parseGoogleTrendsRss.js";
import { runGoogleTrendsCollection } from "./runGoogleTrendsCollection.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(
  here,
  "../../services/search/providers/googleTrends/fixtures/trendingRss.sample.xml"
);
const SAMPLE_XML = readFileSync(FIXTURE_PATH, "utf-8");
const COLLECTED_AT = "2026-08-29T09:00:00.000Z";

function testParser(): void {
  const items = parseGoogleTrendsRss(SAMPLE_XML);

  // 4번째 항목은 title이 공백뿐이라 버려져야 한다.
  assert(items.length === 3, `유효 항목 3건이어야 한다 (실제 ${items.length}건)`);
  assert(items[0].keyword === "들쥐", `1위가 "들쥐"여야 한다 (실제 "${items[0].keyword}")`);
  assert(items[0].approxTrafficValue === 50000, `검색량 파싱 실패 (실제 ${items[0].approxTrafficValue})`);
  assert(items[0].newsItems.length === 2, `뉴스 항목 2건이어야 한다 (실제 ${items[0].newsItems.length})`);
  assert(
    items[0].newsItems[0].title === "넷플릭스 <들쥐> 공개 첫날 국내 1위",
    `XML 엔티티가 안 풀렸다: "${items[0].newsItems[0].title}"`
  );
  assert(
    items[0].newsItems[1].title === "'들쥐' 출연진 & 원작 정보 총정리",
    `&apos;/&amp; 복원 실패: "${items[0].newsItems[1].title}"`
  );
  console.log("  ✅ 정상 피드 파싱 (엔티티 복원 + 빈 title 항목 제외)");

  // 필드가 통째로 없는 항목도 살아남아야 한다(3번째).
  const sparse = items[2];
  assert(sparse.keyword === "아기 수족구", "필드가 없는 항목도 keyword는 살아야 한다");
  assert(sparse.approxTrafficValue === undefined, "없는 검색량은 undefined여야 한다");
  assert(sparse.newsItems.length === 0, "없는 뉴스 항목은 빈 배열이어야 한다");
  console.log("  ✅ 선택 필드 누락 항목도 유지됨");

  // 피드가 완전히 깨져도 예외를 던지지 않는다.
  for (const broken of ["", "not xml at all", "<html><body>429 Too Many Requests</body></html>", "<rss><channel></channel></rss>"]) {
    const result = parseGoogleTrendsRss(broken);
    assert(Array.isArray(result) && result.length === 0, `깨진 입력은 빈 배열이어야 한다: ${broken.slice(0, 20)}`);
  }
  console.log("  ✅ 깨진 응답(빈 문자열/HTML 오류 페이지/빈 채널)에도 예외 없이 0건");

  assert(parseApproxTraffic("2,000,000+") === 2000000, "검색량 자릿수 파싱 실패");
  assert(parseApproxTraffic(undefined) === undefined, "검색량 없음은 undefined");
  assert(parseApproxTraffic("N/A") === undefined, "숫자 없는 문자열은 undefined");
  assert(decodeXmlEntities("&amp;lt;") === "&lt;", "&amp;를 먼저 풀면 이중 디코딩된다");
  console.log("  ✅ 검색량 파싱 / 엔티티 이중 디코딩 방지");
}

function testMapping(): void {
  const items = parseGoogleTrendsRss(SAMPLE_XML);
  const { rows, droppedCount } = mapGoogleTrendsItemsToInserts(items, { collectedAt: COLLECTED_AT });

  assert(rows.length === 3 && droppedCount === 0, `3건 매핑 (실제 ${rows.length}, dropped ${droppedCount})`);
  assert(rows[0].source === GOOGLE_TRENDS_SOURCE, "source가 google_trends여야 한다");
  assert(rows[0].rank === 1 && rows[1].rank === 2, "피드 순서가 rank가 돼야 한다");
  assert(rows[0].trend_date === "2026-08-29", `trend_date 산출 오류 (실제 ${rows[0].trend_date})`);
  assert(rows[0].movement_type === "flat", "순위 변화 정보가 없으므로 flat이어야 한다(new가 아니다)");
  assert(rows[0].rank_change === null, "rank_change는 null이어야 한다");
  console.log("  ✅ 기본 필드 매핑 (source/rank/trend_date/movement_type)");

  // 어휘 분류가 실제로 걸리는지. "근로장려금"은 living, "수족구"는 parenting이어야 한다.
  assert(rows[1].topic_normalized === "living", `근로장려금 -> living (실제 ${rows[1].topic_normalized})`);
  assert(rows[2].topic_normalized === "parenting", `아기 수족구 -> parenting (실제 ${rows[2].topic_normalized})`);
  console.log("  ✅ 키워드 어휘 기반 category 분류 (topic이 없는 소스라 이것에 전적으로 의존)");

  // 순위가 높고 검색량이 많을수록 점수가 높아야 한다.
  assert(
    rows[0].candidate_score! > rows[1].candidate_score!,
    `1위 점수가 2위보다 높아야 한다 (${rows[0].candidate_score} vs ${rows[1].candidate_score})`
  );
  assert(rows[2].candidate_score! >= 0, "검색량 없는 항목도 점수가 계산돼야 한다");
  console.log("  ✅ candidate_score 순서 (rank + 검색량)");

  // 같은 키워드가 두 번 오면 upsert 배치 conflict가 나므로 미리 버려야 한다.
  const duplicated = mapGoogleTrendsItemsToInserts([items[0], items[0], items[1]], {
    collectedAt: COLLECTED_AT,
  });
  assert(
    duplicated.rows.length === 2 && duplicated.droppedCount === 1,
    `중복 키워드 dedupe 실패 (rows ${duplicated.rows.length}, dropped ${duplicated.droppedCount})`
  );
  const conflictKeys = duplicated.rows.map(
    (r) => `${r.keyword_normalized}|${r.topic_normalized}|${r.trend_date}|${r.source}`
  );
  assert(new Set(conflictKeys).size === conflictKeys.length, "배치 안에 conflict key가 겹치면 안 된다");
  console.log("  ✅ 배치 내 conflict key 중복 제거 (21000 예방)");
}

async function testProviderInjection(): Promise<void> {
  const result = await fetchGoogleTrends({ fetchRss: async () => SAMPLE_XML });
  assert(result.items.length === 3, "주입된 RSS로 파싱돼야 한다");
  assert(result.requestUrl.includes("geo=KR"), `기본 geo가 KR이어야 한다 (${result.requestUrl})`);

  const jp = await fetchGoogleTrends({ geo: "JP", fetchRss: async () => SAMPLE_XML });
  assert(jp.requestUrl.includes("geo=JP"), "geo 옵션이 URL에 반영돼야 한다");
  console.log("  ✅ provider fetch 주입 / geo 파라미터");
}

async function testCollection(): Promise<void> {
  const disabled = await runGoogleTrendsCollection({ enabled: false });
  assert(disabled.status === "skipped" && disabled.reason === "disabled", "disabled면 skipped여야 한다");
  console.log("  ✅ disabled -> skipped (조회 없음)");

  const dry = await runGoogleTrendsCollection({
    enabled: true,
    dryRun: true,
    fetchTrends: async () => ({
      items: parseGoogleTrendsRss(SAMPLE_XML),
      requestUrl: "injected",
      collectedAt: COLLECTED_AT,
    }),
  });
  assert(dry.status === "success", `dry-run 성공해야 한다 (${dry.error ?? ""})`);
  assert(dry.fetchedCount === 3, `3건 조회 (실제 ${dry.fetchedCount})`);
  assert(dry.upsertedCount === 0 && dry.expiredCount === 0, "dry-run은 DB에 쓰지 않는다");
  assert(dry.trendDate === "2026-08-29", `trendDate 오류 (${dry.trendDate})`);
  console.log("  ✅ dry-run: 조회/매핑만, DB 쓰기 없음");

  // 가장 중요한 계약: 어떤 실패에도 throw하지 않는다.
  const failed = await runGoogleTrendsCollection({
    enabled: true,
    dryRun: true,
    fetchTrends: async () => {
      throw new Error("forced network failure");
    },
  });
  assert(failed.status === "failed", "실패는 status로 알려야 한다");
  assert(failed.error === "forced network failure", `오류 메시지 보존 실패 (${failed.error})`);
  console.log("  ✅ 수집 실패해도 throw하지 않고 status='failed' 반환");

  // Supabase 스타일 오류(Error 인스턴스가 아님)도 원인이 보존돼야 한다.
  const pgFailed = await runGoogleTrendsCollection({
    enabled: true,
    dryRun: true,
    fetchTrends: async () => {
      throw { message: "duplicate key", code: "23505", details: "already exists" };
    },
  });
  assert(
    pgFailed.error?.includes("duplicate key") && pgFailed.error.includes("23505"),
    `PostgrestError 직렬화 실패 (${pgFailed.error})`
  );
  console.log("  ✅ PostgrestError형 객체도 [object Object]가 되지 않음");
}

// 2026-08-29 맥에서 실제로 수집된 구글 트렌드 KR TOP 10(뉴스 출처만 발췌).
// 가상 예시가 아니라 첫 실측 데이터다 - category 분류가 회귀하면 여기서 잡힌다.
const REAL_TOP10: { keyword: string; outlets: string[]; expected: string }[] = [
  { keyword: "2026년 태풍", outlets: ["이코노미톡뉴스", "연합뉴스TV"], expected: "living" },
  { keyword: "게임스컴", outlets: ["Daum", "뉴시스"], expected: "living" },
  // 인명 3건: 키워드 어휘로는 못 잡고 스포츠지 출처로만 잡힌다. 이 테스트의 핵심이다.
  { keyword: "오연수", outlets: ["Chosunbiz", "스포츠조선"], expected: "entertainment" },
  { keyword: "용종", outlets: ["헬스조선", "하이닥"], expected: "living" },
  { keyword: "유재석", outlets: ["Daum", "스포츠동아"], expected: "entertainment" },
  { keyword: "엄태웅", outlets: ["Daum", "스포츠동아"], expected: "entertainment" },
  { keyword: "자폭", outlets: ["연합뉴스", "YTN 사이언스"], expected: "living" },
  // 종합지(조선일보)는 연예부터 정치까지 다 쓰므로 신호가 아니다 -> living 유지.
  { keyword: "션", outlets: ["조선일보", "국민일보"], expected: "living" },
  { keyword: "창신메모리테크놀로지", outlets: ["Daum", "Chosunbiz"], expected: "living" },
  { keyword: "포스코노동조합", outlets: ["Daum", "서울경제"], expected: "living" },
];

function makeItem(keyword: string, outlets: string[]): GoogleTrendsItem {
  return {
    keyword,
    newsItems: outlets.map((source) => ({ title: `${keyword} 관련 기사`, source })),
  };
}

function testRealWorldCategories(): void {
  for (const { keyword, outlets, expected } of REAL_TOP10) {
    const actual = resolveGoogleTrendsCategory(makeItem(keyword, outlets));
    assert(actual === expected, `"${keyword}" -> ${expected} 이어야 한다 (실제 ${actual})`);
  }
  console.log("  ✅ 실측 TOP 10 category 분류 (인명 3건을 뉴스 출처로 정확히 잡음)");

  // 순서 불변식: 키워드 어휘가 뉴스 출처보다 먼저다. 그래야 육아 키워드가 스포츠지에 실려도 안 흔들린다.
  const babyOnSportsPaper = makeItem("아기 수족구 초기증상", ["스포츠조선", "OSEN"]);
  assert(
    resolveGoogleTrendsCategory(babyOnSportsPaper) === "parenting",
    "키워드 어휘(parenting)가 뉴스 출처(entertainment)를 이겨야 한다"
  );
  console.log("  ✅ 판정 순서 고정: 키워드 어휘 > 뉴스 출처 > living 폴백");

  // 1글자 키워드는 relevance 게이트를 무력화하므로 반드시 버려야 한다.
  assert(!isUsableTrendKeyword("션"), "1글자 키워드는 버려야 한다");
  assert(!isUsableTrendKeyword(" 김 "), "공백 제거 후 1글자도 버려야 한다");
  assert(isUsableTrendKeyword("유재석"), "정상 키워드는 통과해야 한다");
  assert(isUsableTrendKeyword("태풍"), "2글자는 통과해야 한다");

  const items = REAL_TOP10.map(({ keyword, outlets }) => makeItem(keyword, outlets));
  const { rows, droppedCount, droppedKeywords } = mapGoogleTrendsItemsToInserts(items, {
    collectedAt: COLLECTED_AT,
  });
  assert(droppedCount === 1 && droppedKeywords[0] === "션", `"션" 1건만 버려야 한다 (실제 ${droppedKeywords.join(",")})`);
  assert(rows.length === 9, `9건이 남아야 한다 (실제 ${rows.length}건)`);
  console.log('  ✅ 1글자 키워드("션") 제외 - relevance 게이트 무력화 방지');

  // rank는 버리기 전 피드 순위를 유지해야 한다("션"은 8위였으므로 그 뒤는 9, 10위 그대로).
  const posco = rows.find((r) => r.keyword === "포스코노동조합");
  assert(posco?.rank === 10, `버린 뒤에도 원래 순위를 유지해야 한다 (실제 ${posco?.rank})`);
  console.log("  ✅ 제외해도 원본 피드 순위(rank) 보존");
}

async function main(): Promise<void> {
  console.log("▶ 구글 트렌드 수집 테스트 시작\n");
  testParser();
  testMapping();
  testRealWorldCategories();
  await testProviderInjection();
  await testCollection();
  console.log("\n✅ 전체 통과");
}

await main();
