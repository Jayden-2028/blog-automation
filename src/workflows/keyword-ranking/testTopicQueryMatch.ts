// 주제어 기반 주제 동일성 판정 테스트.
// 사례는 전부 run #100(2026-09-30 entertainment) 로그에서 실제로 나온 주제어다 - 이 판정을 만든
// 이유가 그 로그의 오판이므로, 같은 입력으로 검증한다.

import { isSameTopicQuery, buildTopicQueryCore } from "./topicQueryMatch.js";
import { TOPIC_GROUPING_CONFIG } from "../../config/keywordScoring.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

function ok(message: string): void {
  console.log(`  ✅ ${message}`);
}

const EXCLUDED = new Set(
  [...TOPIC_GROUPING_CONFIG.genericTokens, ...TOPIC_GROUPING_CONFIG.categoryTerms].map((t) =>
    t.toLowerCase()
  )
);

function same(a: string, b: string): boolean | null {
  return isSameTopicQuery(a, b, EXCLUDED);
}

function testRealDuplicates(): void {
  console.log("▶ 실측 중복 판정(run #100)");

  // 이 두 건이 각각 53점을 받고 따로 남았다. 주제어가 글자까지 같다.
  assert(same("추무빈 열애 공개", "추무빈 열애 공개") === true, "완전히 같은 주제어는 같은 주제");
  ok("주제어 완전 일치");

  // 같은 이슈의 다른 표현. {추무빈, 열애} ⊂ {추무빈, 여자친구, 열애}
  assert(same("추무빈 열애 공개", "추무빈 여자친구 열애") === true, "부분집합이면 같은 주제");
  ok("부분집합(더 구체적인 주제어)");

  // 범용 수식어(결말/정보)를 걷어내면 둘 다 {옵세션}만 남는다.
  assert(same("영화 옵세션 결말", "영화 옵세션 정보") === true, "수식어만 다른 같은 작품");
  ok("범용 수식어를 걷어낸 뒤 일치");

  console.log("✅ 실측 중복 판정 통과\n");
}

function testRealNonDuplicates(): void {
  console.log("▶ 실측 비중복 판정(오폭 방지)");

  // 교집합은 {열애}뿐이다. 교집합 1개만 요구했다면 서로 다른 커플이 묶였을 자리.
  assert(
    same("추무빈 열애 공개", "브래드 피트 여자친구 열애") === false,
    "공유 토큰이 있어도 부분집합이 아니면 다른 주제여야 한다"
  );
  ok("`열애` 하나를 공유하는 서로 다른 커플은 구분됨");

  assert(same("배성재 김다영 임신", "추무빈 열애 공개") === false, "겹치는 토큰이 없으면 다른 주제");
  assert(
    same("금낭묘록 티빙 호빙경", "네이버플러스 멤버십 티빙 연동") === false,
    "플랫폼 이름(티빙)은 분류어라 판정 근거가 되면 안 된다"
  );
  ok("분류어 공유만으로는 묶이지 않음");

  // topicGrouping이 이 두 건을 `vs` 하나로 묶었다(주제병합 preview 실측).
  assert(same("들쥐 결말 원작 차이", "설현 수지 담배꽁초 논란") === false, "서로 다른 이슈");
  ok("df 판정이 오병합했던 쌍이 구분됨");

  console.log("✅ 실측 비중복 판정 통과\n");
}

function testUnjudgeable(): void {
  console.log("▶ 판정 불가 처리");

  // null은 "다르다"가 아니라 "모르겠다"다 - 호출자가 기존 규칙으로 넘긴다.
  assert(same("추무빈 열애 공개", "") === null, "주제어가 없으면 null");
  assert(isSameTopicQuery("추무빈 열애 공개", null, EXCLUDED) === null, "null 주제어는 null");
  assert(isSameTopicQuery(undefined, undefined, EXCLUDED) === null, "둘 다 없으면 null");

  // 전부 걷어내지면 빈 집합이 된다. 빈 집합끼리는 서로 부분집합이라 true가 나오는데, 그러면
  // 범용어로만 이뤄진 주제어들이 전부 한 덩어리가 된다 - null로 막아야 한다.
  assert(same("결말 후기 정리", "출연진 촬영지 정보") === null, "핵심 토큰이 안 남으면 null");
  ok("주제어 없음·핵심 토큰 0개는 전부 null(기존 규칙으로 위임)");

  assert(buildTopicQueryCore("영화 옵세션 결말", EXCLUDED)?.has("옵세션") === true, "핵심 토큰 추출");
  assert(buildTopicQueryCore("결말 후기", EXCLUDED) === null, "핵심 토큰이 없으면 null");
  ok("buildTopicQueryCore 동작 확인");

  console.log("✅ 판정 불가 처리 통과\n");
}

function main(): void {
  console.log("▶ 주제어 판정 테스트 시작\n");
  testRealDuplicates();
  testRealNonDuplicates();
  testUnjudgeable();
  console.log("✅ 전체 통과");
}

main();
