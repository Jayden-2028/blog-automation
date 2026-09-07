import { isPoliticalKeyword, shouldExcludeCandidate } from "./keywordExclusionRules.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

function main(): void {
  console.log("▶ keywordExclusionRules 테스트 시작\n");

  assert(shouldExcludeCandidate("아기 이유식 거부", "parenting") === true, "육아 카테고리는 제외돼야 한다");
  assert(shouldExcludeCandidate("아무 키워드", "living") === false, "육아가 아니면 카테고리만으로는 제외되지 않는다");
  console.log("✅ 육아 카테고리 제외");

  assert(isPoliticalKeyword("국민의힘 원내대표 발언") === true, "정당 어휘는 정치로 판정돼야 한다");
  assert(isPoliticalKeyword("더불어민주당 대선 후보") === true, "정당+선거 어휘 판정");
  assert(isPoliticalKeyword("국회 국민동의청원 청원 회부") === false, "국회 단독은 정치로 판정하면 안 된다(청원·상임위 등 정책 이슈에도 등장)");
  console.log("✅ 정당·선거 어휘만 정치로 판정, '국회' 단독은 통과");

  assert(shouldExcludeCandidate("국민의힘 지지율 조사", "living") === true, "정치 키워드는 카테고리와 무관하게 제외돼야 한다");
  assert(shouldExcludeCandidate("캣맘 새덕후 청원 논쟁", "community") === false, "정당/선거 어휘가 없으면 통과해야 한다");
  console.log("✅ 정치 키워드는 카테고리와 무관하게 제외, 비정치 사회 이슈는 통과");

  console.log("\n✅ 전체 통과");
}

main();
