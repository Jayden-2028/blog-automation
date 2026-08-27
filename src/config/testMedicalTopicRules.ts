// 의학 주제 판정 규칙 테스트.
// 외부 호출/DB 접근 없이 순수 함수만 검증한다.
//
// 이 규칙은 오탐(의학 아닌데 의학으로 분류)보다 미탐(의학인데 놓침)이 훨씬 비싸다 - 미탐이면
// 검증되지 않은 커뮤니티 근거로 쓴 의학 정보가 사람 교차확인 없이 그대로 나간다
// (SPRINT_2_DESIGN.md 5절). 그래서 이 테스트는 "놓치면 안 되는 것"에 더 무게를 둔다.

import { isMedicalTopic } from "./medicalTopicRules.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

function main(): void {
  console.log("▶ 의학 주제 판정 테스트 시작\n");

  // 1) 실제 article_jobs에 대기 중인 키워드(2026-08-27) - 놓치면 안 되는 케이스.
  const mustCatch = [
    "이유식 먹다 부르르 아기 셔더링어택 증상 원인 언제",
    "아기 다리떨림? 영아연축 VS 셔더링어택",
    "수족구 초기증상",
    "임신 극초기증상",
    "2026 근로장려금 지급일", // 대조군: 이건 아래 6)에서 false를 확인
  ];
  for (const kw of mustCatch.slice(0, -1)) {
    assert(isMedicalTopic(kw), `놓치면 안 되는 의학 키워드: "${kw}"`);
  }
  console.log("✅ 실제 대기 중인 의학 키워드 전부 포착");

  // 2) 증상/질환 어휘가 포함된 일반 케이스.
  const positives = [
    "신생아 황달 증상",
    "아이 열경련 대처법",
    "아기 아토피 진단 후기",
    "감기 해열제 복용법",
    "예방접종 부작용 사례",
    "축농증 자연치료",
  ];
  for (const kw of positives) {
    assert(isMedicalTopic(kw), `의학 키워드로 판정돼야 한다: "${kw}"`);
  }
  console.log(`✅ 증상/질환 어휘 ${positives.length}건 전부 포착`);

  // 3) 짧은 토큰의 오탐 방지 - "경기"는 "경기도"에 걸리면 안 된다(주석에 명시한 함정).
  const nonMedicalWithTrap = [
    "경기도 부동산 시세",
    "경기 침체 전망",
    "국가대표 축구 경기 일정",
  ];
  for (const kw of nonMedicalWithTrap) {
    assert(!isMedicalTopic(kw), `짧은 토큰 함정으로 오탐되면 안 된다: "${kw}"`);
  }
  console.log("✅ '경기' 등 짧은 토큰 오탐 방지 확인");

  // 4) 일반 육아/정책/연예 키워드는 의학이 아니다.
  const negatives = [
    "아동수당 신청방법",
    "2026 자녀장려금",
    "노스페이스 벤투스 키즈",
    "양준모 재혼 상대 양지원",
    "신병 시즌4 달라진 등장인물",
    "구글 타임라인 보는법",
  ];
  for (const kw of negatives) {
    assert(!isMedicalTopic(kw), `의학 키워드가 아니어야 한다: "${kw}"`);
  }
  console.log(`✅ 비의학 키워드 ${negatives.length}건 정확히 제외`);

  // 5) 빈 문자열/공백은 false.
  assert(!isMedicalTopic(""), "빈 문자열은 false여야 한다");
  assert(!isMedicalTopic("   "), "공백만 있는 문자열은 false여야 한다");
  console.log("✅ 빈 값 처리 정상");

  // 6) 정책 키워드가 의학 어휘와 우연히 겹치지 않는지 대조 확인.
  assert(!isMedicalTopic("2026 근로장려금 지급일"), "정책 키워드는 의학으로 분류되면 안 된다");
  console.log("✅ 정책 키워드 오분류 없음");

  console.log("\n✅ 의학 주제 판정 테스트 완료");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
