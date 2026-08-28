// 키워드 단위 category 분류 규칙 테스트.
// 외부 호출/DB 접근 없이 순수 함수만 검증한다. 다른 테스트와 동일하게 별도 프레임워크 없이
// assert 헬퍼 + 콘솔 로그로 확인한다.
//
// 케이스는 전부 2026-08-26에 Creator Advisor에서 실제로 수집된 키워드다(가상 예시가 아니다).
// 특히 "육아·결혼" topic card 20건은 카드 하나에 육아/정부지원금/연예뉴스가 섞여 있던 실제
// 오분류 사례이므로, 이 규칙이 회귀하면 여기서 바로 잡힌다.

import { classifyKeywordCategory } from "./keywordCategoryRules.js";
import { resolveCreatorAdvisorCategory } from "../workflows/creator-advisor/mapCreatorAdvisorCandidates.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

/** [키워드, 원본 topic, 기대 category] */
const CASES: readonly (readonly [string, string, string])[] = [
  // --- "육아·결혼" card: topic 매핑만 쓰면 20건 전부 parenting이 되던 자리 ---
  // 인물 신변 이벤트는 "임신"이 들어 있어도 연예 뉴스다.
  ["양준모 재혼 상대 양지원, 임신 소식", "육아·결혼", "entertainment"],
  ["장동윤 김승윤 10월 결혼 발표", "육아·결혼", "entertainment"],
  ["장동윤♥김승윤 라디오 첫 동반출연", "육아·결혼", "entertainment"],
  // 정부 지원금 일반은 육아가 아니라 생활정보다.
  ["2026 근로장려금", "육아·결혼", "living"],
  ["근로장려금 금액 조회", "육아·결혼", "living"],
  ["근로장려금 지급일", "육아·결혼", "living"],
  ["유플멤버십", "육아·결혼", "living"],
  // 육아 대상 지원금과 육아 정보는 parenting으로 남아야 한다("신청"이 들어가도 living이 아니다).
  ["아동수당", "육아·결혼", "parenting"],
  ["2026 자녀장려금", "육아·결혼", "parenting"],
  ["임신 극초기증상", "육아·결혼", "parenting"],
  ["수족구 초기증상", "육아·결혼", "parenting"],
  ["아기 뒤집기 시기", "육아·결혼", "parenting"],
  ["착상혈", "육아·결혼", "parenting"],
  ["esl 수유자세", "육아·결혼", "parenting"],
  ["노스페이스 벤투스 키즈", "육아·결혼", "parenting"],

  // --- 다른 topic: 기존 분류가 깨지지 않는지 ---
  ["신병 시즌4, 달라진 등장인물", "드라마", "ott"],
  ["마블 영화 순서", "영화", "ott"],
  ["한소희·김연아, 달라진 근황 모습", "스타·연예인", "entertainment"],
  ["실업급여 조건, 자진퇴사 인정 3시간의 정체", "비즈니스·경제", "living"],

  // --- 확실한 신호가 없어 topic 매핑으로 폴백해야 하는 것들 ---
  ["전현무 제주도 즉흥여행 논란", "방송", "entertainment"],
  ["민음사 빵", "일상·생각", "living"],
  ["속초 가볼만한곳", "국내여행", "living"],
  ["구글 타임라인", "세계여행", "living"],
  ["성시경 양배추볶음, 다이어트 요리", "요리·레시피", "living"],
] as const;

function main(): void {
  console.log("▶ 키워드 category 분류 테스트 시작\n");

  let failures = 0;
  for (const [keyword, topic, expected] of CASES) {
    const actual = resolveCreatorAdvisorCategory(keyword, topic);
    if (actual !== expected) {
      failures++;
      console.log(`❌ ${actual.padEnd(14)} (기대 ${expected}) ${keyword}`);
    }
  }
  assert(failures === 0, `${failures}건이 기대와 다르게 분류되었습니다`);
  console.log(`✅ 실제 수집 키워드 ${CASES.length}건 전부 기대대로 분류됨`);

  // 확실한 신호가 없으면 null을 반환해 topic 매핑으로 폴백해야 한다 - 규칙이 과하게 매칭되면
  // topic이 가진 정보까지 덮어써 버리므로, "모르면 모른다"고 답하는 성질이 중요하다.
  assert(classifyKeywordCategory("민음사 빵") === null, "신호 없는 키워드는 null이어야 한다");
  assert(classifyKeywordCategory("") === null, "빈 문자열은 null이어야 한다");
  assert(classifyKeywordCategory("   ") === null, "공백만 있는 문자열은 null이어야 한다");
  console.log("✅ 신호 없는 키워드는 null 반환 -> topic 매핑으로 폴백");

  // 우선순위 회귀 방지: entertainment가 parenting보다, parenting이 living보다 앞서야 한다.
  assert(
    classifyKeywordCategory("재혼 임신 소식") === "entertainment",
    "인물 이벤트(재혼)가 육아 어휘(임신)보다 우선해야 한다"
  );
  assert(
    classifyKeywordCategory("아동수당 지급일") === "parenting",
    "육아 어휘(아동수당)가 지원금 어휘(지급일)보다 우선해야 한다"
  );
  console.log("✅ 규칙 우선순위 유지 (entertainment > ott > parenting > living)");

  console.log("\n✅ 키워드 category 분류 테스트 완료");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
