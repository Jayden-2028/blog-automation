import { isPoliticalKeyword, isSportsKeyword, shouldExcludeCandidate } from "./keywordExclusionRules.js";

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

  assert(isSportsKeyword("20년 만에 한기주 넘었다 키움 하현승 계약금 16억") === true, "구단·야구 기사는 스포츠로 판정돼야 한다");
  assert(isSportsKeyword("손흥민 시즌 첫 골") === true, "축구 선수는 스포츠로 판정돼야 한다");
  assert(shouldExcludeCandidate("LG 트윈스 우승 퍼레이드", "entertainment") === true, "스포츠는 카테고리와 무관하게 제외돼야 한다");
  assert(isSportsKeyword("최강야구 새 시즌 출연진") === false, "야구 예능 제목은 통과해야 한다");
  assert(isSportsKeyword("키움증권 신규 서비스") === false, "키움증권은 스포츠가 아니다");
  assert(isSportsKeyword("한지민 이준혁 재회 SBS 특별출연") === false, "연예 키워드는 통과해야 한다");
  console.log("✅ 스포츠 키워드 제외, 예능·증권사는 통과");

  assert(
    shouldExcludeCandidate("투타겸업 하현승의 가치? 역대 최고 계약금 16억", "entertainment", "키움 하현승 계약금") === true,
    "제목에 어휘가 없어도 시드 검색어가 스포츠면 제외돼야 한다"
  );
  assert(shouldExcludeCandidate("한지민 이준혁 재회", "entertainment", "한지민 이준혁") === false, "시드가 연예면 통과해야 한다");
  console.log("✅ 시드 검색어 기준 제외");

  console.log("\n✅ 전체 통과");
}

main();
