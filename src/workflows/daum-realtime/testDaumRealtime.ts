// 다음 실시간 트렌드 파서 + candidate 매핑 + 수집 배선 테스트.
// 외부 호출/DB 접근 없이 fixture와 주입된 함수만 사용한다.
//
// 두 가지를 고정한다.
//
// 1) **페이지 구조가 바뀌어도 죽지 않는다.** 다음이 위젯 마커나 JSON 구조를 바꾸면 예외가 아니라
//    0건이어야 한다(구글 트렌드 RSS 파서와 같은 원칙).
// 2) **2026-09-08 실측 데이터**(다음 홈 실제 응답에서 그대로 추출한 구조)로 회귀 케이스를 박아둔다.

import {
  parseDaumRealtimePage,
} from "../../services/search/providers/daumRealtime/parseDaumRealtimePage.js";
import { fetchDaumRealtime } from "../../services/search/providers/daumRealtime/DaumRealtimeProvider.js";
import {
  mapDaumRealtimeItemsToInserts,
  resolveDaumRealtimeCategory,
  resolveDaumRealtimeMovement,
  DAUM_REALTIME_SOURCE,
} from "./mapDaumRealtimeCandidates.js";
import { isUsableTrendKeyword } from "../../config/trendSources.js";
import { runDaumRealtimeCollection } from "./runDaumRealtimeCollection.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const COLLECTED_AT = "2026-09-08T00:08:38.471+09:00";

// 2026-09-08 실측(다음 홈 실제 응답 구조를 그대로 축약). 앞뒤에 페이지의 다른 컴포넌트 JSON이
// 더 있다는 걸 보여주기 위해 marker 앞뒤에 잡음을 섞어둔다 - 실제 페이지도 이 노드 하나만 딱
// 떨어져 있지 않다.
const SAMPLE_HTML = `
<html><body><script>window.__STATE__={"nodes":[{"name":"딴 컴포넌트","code":1,"contents":{"data":{"unrelated":true}}},
{"name":"실시간 트렌드 - 상단","code":4860,"nodeKey":"","uiType":"REALTIME_TREND_TOP","nodeType":"SLOT",
"attributes":{"serviceTitle":"실시간 트렌드"},"children":[],
"contents":{"data":{"updatedAt":"2026-09-07T23:58:50.800+09:00","keywords":[
{"keyword":"한은서 윤종훈 결혼","rank":1,"displayRank":1,"status":"0","tiara":{"eventCustomProps":{"data_type":"Expansion_Q"}}},
{"keyword":"한미일 프리덤에지","rank":3,"displayRank":2,"status":"-1","tiara":{"eventCustomProps":{"data_type":"News"}}},
{"keyword":"주민등록 사실조사","rank":20,"displayRank":3,"status":"new","tiara":{"eventCustomProps":{"data_type":"Query"}}},
{"keyword":"아기 수족구 초기증상","rank":25,"displayRank":4,"status":"5","tiara":{"eventCustomProps":{"data_type":"Query"}}},
{"keyword":"션","rank":30,"displayRank":5,"status":"0"}
]}}}]}</script></body></html>
`;

function testParser(): void {
  const { items, updatedAt } = parseDaumRealtimePage(SAMPLE_HTML);

  assert(items.length === 5, `유효 항목 5건이어야 한다 (실제 ${items.length}건)`);
  assert(items[0].keyword === "한은서 윤종훈 결혼", `1위 키워드 파싱 실패 (실제 "${items[0].keyword}")`);
  assert(items[0].displayRank === 1 && items[0].rank === 1, "displayRank/rank 파싱 실패");
  assert(items[0].dataType === "Expansion_Q", "dataType 파싱 실패");
  assert(updatedAt === "2026-09-07T23:58:50.800+09:00", `updatedAt 파싱 실패 (실제 ${updatedAt})`);
  console.log("  ✅ 정상 페이지 파싱 (다른 컴포넌트 JSON에 안 걸리고 마커 뒤 데이터만 추출)");

  // status 없는 항목도 살아야 한다(안전 기본값 "0").
  const noStatus = items[4];
  assert(noStatus.keyword === "션" && noStatus.status === "0", "status 없는 항목은 0으로 안전 처리돼야 한다");
  console.log("  ✅ 선택 필드(status/dataType) 누락 항목도 유지됨");

  // 페이지 구조가 바뀌거나 깨져도 예외 없이 0건.
  for (const broken of [
    "",
    "<html>완전히 다른 페이지</html>",
    '<script>{"uiType":"REALTIME_TREND_TOP","contents":{"data":BROKEN_JSON}}</script>',
    '<script>{"uiType":"REALTIME_TREND_TOP","contents":{"data":{"keywords":[}}}</script>',
  ]) {
    const result = parseDaumRealtimePage(broken);
    assert(Array.isArray(result.items) && result.items.length === 0, `깨진 입력은 빈 배열이어야 한다: ${broken.slice(0, 30)}`);
  }
  console.log("  ✅ 마커 없음/불완전한 JSON에도 예외 없이 0건");
}

function testMapping(): void {
  const { items } = parseDaumRealtimePage(SAMPLE_HTML);
  const { rows, droppedCount, droppedKeywords } = mapDaumRealtimeItemsToInserts(items, {
    collectedAt: COLLECTED_AT,
  });

  // "션"은 1글자라 버려져야 한다.
  assert(droppedCount === 1 && droppedKeywords[0] === "션", `1글자 키워드만 버려야 한다 (실제 ${droppedKeywords.join(",")})`);
  assert(rows.length === 4, `4건 매핑 (실제 ${rows.length}건)`);
  assert(rows[0].source === DAUM_REALTIME_SOURCE, "source가 daum_realtime이어야 한다");
  assert(rows[0].rank === 1, "rank는 displayRank를 써야 한다");
  assert(rows[0].trend_date === "2026-09-08", `trend_date 산출 오류 (실제 ${rows[0].trend_date})`);
  console.log("  ✅ 기본 필드 매핑 (source/rank/trend_date), 1글자 키워드 제외");

  // status -> movement_type.
  assert(rows[0].movement_type === "flat", '"0" -> flat이어야 한다');
  assert(rows[1].movement_type === "down", '"-1" -> down이어야 한다');
  assert(rows[2].movement_type === "new", '"new" -> new여야 한다');
  assert(rows[3].movement_type === "up", '"5" -> up이어야 한다');
  assert(rows.every((r) => r.rank_change === null), "rank_change는 항상 null이어야 한다");
  console.log("  ✅ status -> movement_type 변환 (flat/down/new/up)");

  // 키워드 어휘 분류: "아기 수족구 초기증상"은 parenting, 나머지는 living 폴백.
  const baby = rows.find((r) => r.keyword.includes("수족구"));
  assert(baby?.topic_normalized === "parenting", `아기 수족구 -> parenting (실제 ${baby?.topic_normalized})`);
  const registration = rows.find((r) => r.keyword === "주민등록 사실조사");
  assert(registration?.topic_normalized === "living", `키워드 어휘 미매칭은 living 폴백 (실제 ${registration?.topic_normalized})`);
  console.log("  ✅ 키워드 어휘 기반 category 분류 (미매칭은 living 폴백)");

  // displayRank가 높을수록(1에 가까울수록) 점수가 높아야 한다.
  assert(
    rows[0].candidate_score! > rows[1].candidate_score! && rows[1].candidate_score! > rows[3].candidate_score!,
    "순위가 낮을수록 점수도 낮아야 한다"
  );
  console.log("  ✅ candidate_score가 displayRank 순서를 따른다");

  // 중복 키워드 dedupe.
  const duplicated = mapDaumRealtimeItemsToInserts([items[0], items[0], items[1]], {
    collectedAt: COLLECTED_AT,
  });
  assert(
    duplicated.rows.length === 2 && duplicated.droppedCount === 1,
    `중복 키워드 dedupe 실패 (rows ${duplicated.rows.length}, dropped ${duplicated.droppedCount})`
  );
  console.log("  ✅ 배치 내 중복 키워드 제거 (21000 예방)");

  assert(resolveDaumRealtimeMovement("0") === "flat", "0 -> flat");
  assert(resolveDaumRealtimeMovement("new") === "new", "new -> new");
  assert(resolveDaumRealtimeMovement("abc") === "flat", "해석 불가 값은 flat 안전 처리");
  assert(resolveDaumRealtimeCategory("아이돌 컴백") === "entertainment", "연예 어휘 분류 확인");
}

async function testProviderInjection(): Promise<void> {
  const result = await fetchDaumRealtime({ fetchHtml: async () => SAMPLE_HTML });
  assert(result.items.length === 5, "주입된 HTML로 파싱돼야 한다");
  assert(result.requestUrl === "https://www.daum.net/", "요청 URL이 다음 홈이어야 한다");
  assert(result.updatedAt === "2026-09-07T23:58:50.800+09:00", "updatedAt이 전달돼야 한다");
  console.log("  ✅ provider fetch 주입");
}

async function testCollection(): Promise<void> {
  const disabled = await runDaumRealtimeCollection({ enabled: false });
  assert(disabled.status === "skipped" && disabled.reason === "disabled", "disabled면 skipped여야 한다");
  console.log("  ✅ disabled -> skipped (조회 없음)");

  const dry = await runDaumRealtimeCollection({
    enabled: true,
    dryRun: true,
    fetchTrends: async () => ({
      items: parseDaumRealtimePage(SAMPLE_HTML).items,
      updatedAt: "2026-09-07T23:58:50.800+09:00",
      requestUrl: "injected",
      collectedAt: COLLECTED_AT,
    }),
  });
  assert(dry.status === "success", `dry-run 성공해야 한다 (${dry.error ?? ""})`);
  assert(dry.fetchedCount === 5, `5건 조회 (실제 ${dry.fetchedCount})`);
  assert(dry.droppedCount === 1, `1글자 키워드 1건 제외 (실제 ${dry.droppedCount})`);
  assert(dry.upsertedCount === 0 && dry.expiredCount === 0, "dry-run은 DB에 쓰지 않는다");
  assert(dry.trendDate === "2026-09-08", `trendDate 오류 (${dry.trendDate})`);
  console.log("  ✅ dry-run: 조회/매핑만, DB 쓰기 없음");

  const failed = await runDaumRealtimeCollection({
    enabled: true,
    dryRun: true,
    fetchTrends: async () => {
      throw new Error("forced network failure");
    },
  });
  assert(failed.status === "failed", "실패는 status로 알려야 한다");
  assert(failed.error === "forced network failure", `오류 메시지 보존 실패 (${failed.error})`);
  console.log("  ✅ 수집 실패해도 throw하지 않고 status='failed' 반환");
}

function testMinLengthGuard(): void {
  assert(!isUsableTrendKeyword("션"), "1글자 키워드는 버려야 한다");
  assert(isUsableTrendKeyword("주민등록 사실조사"), "정상 키워드는 통과해야 한다");
}

async function main(): Promise<void> {
  console.log("▶ 다음 실시간 트렌드 수집 테스트 시작\n");
  testParser();
  testMapping();
  testMinLengthGuard();
  await testProviderInjection();
  await testCollection();
  console.log("\n✅ 전체 통과");
}

await main();
