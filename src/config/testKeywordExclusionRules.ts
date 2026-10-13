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

  // ---- 2026-10-13 엔터 순도 보강(KEYWORD-ENT-PURITY-2026-10.md A-1·C) ----
  // run #148(10/13 18시 엔터) Top 10 실제 키워드 문자열 10건을 그대로 고정한다. 4위·8위만 차단되고
  // 나머지 8건은 통과해야 한다. **2위는 통과가 기대값이다** - 비엔터지만 원인 ③(전 분야 트렌드 소스가
  // 엔터 풀에 무필터 합류) 소관이고 어휘 차단으로는 못 거른다("러너"는 스포츠 목록에 없고, 사망은
  // 엔터 추모 기사와 구분되지 않는다 - 같은 run의 1위 김현이 별세는 정당한 엔터 키워드다).
  const RUN_148_TOP10: { rank: number; keyword: string; seed: string; blocked: boolean; why: string }[] = [
    { rank: 1, keyword: "액션배우 김현이 교통사고 사망 뒤늦게 알려진 비보·방송가", seed: "김현이", blocked: false, why: "정당한 엔터(추모)" },
    { rank: 2, keyword: "결승선 500m 앞두고 쓰러진 카이스트 女 러너 세상", seed: "유지원 러너", blocked: false, why: "비엔터지만 원인 ③ 소관 - 어휘로는 못 거른다" },
    { rank: 3, keyword: "이민기→NCT 지성 합류 크래시2 뜨거워진 대본 리딩 현장", seed: "대본 리딩", blocked: false, why: "정당한 엔터" },
    { rank: 4, keyword: "영업 취소돼도 개통? 휴대폰 성지 옆커폰 논란 국감서", seed: "논란", blocked: true, why: "'국감' - A-1로 차단" },
    { rank: 5, keyword: "김지원 또 해냈다 닥터X 시작 흥행한 이유", seed: "닥터x 원작", blocked: false, why: "정당한 엔터" },
    { rank: 6, keyword: "김용지 직접 공개한 웨딩드레스와 야외 결혼식 저는 이제", seed: "결혼", blocked: false, why: "정당한 엔터" },
    { rank: 7, keyword: "어벤져스 둠스데이 개봉 확정 일정과 출연진 정보", seed: "어벤져스:둠스데이 개봉 확정", blocked: false, why: "정당한 엔터" },
    { rank: 8, keyword: "김지용 임은정 인사 공개 비판 기강 무너뜨려 중수청", seed: "공개", blocked: true, why: "'중수청' - A-1로 차단" },
    { rank: 9, keyword: "닥터X 이어 100일의 거짓말 엔딩에도 故 김현이 누구?", seed: "닥터x 김현이", blocked: false, why: "정당한 엔터" },
    { rank: 10, keyword: "배우 박동빈 별세 5월 개업 앞둔 식당서 쓰러져", seed: "배우 김현이 별세", blocked: false, why: "정당한 엔터(추모)" },
  ];
  for (const row of RUN_148_TOP10) {
    const actual = shouldExcludeCandidate(row.keyword, "entertainment", row.seed);
    assert(
      actual === row.blocked,
      `run#148 #${row.rank}는 ${row.blocked ? "차단" : "통과"}돼야 한다(${row.why}): ${row.keyword}`
    );
  }
  console.log(`✅ run #148 Top 10 고정: 4위·8위 차단, 나머지 8건 통과(2위는 원인 ③ 소관으로 통과가 기대값)`);

  assert(isPoliticalKeyword("티빙 국감서 보안 관리 도마") === true, "'국감' 축약형이 차단돼야 한다");
  assert(isPoliticalKeyword("중수청 1호 감찰 지시") === true, "사정기관 고유어가 차단돼야 한다");
  assert(isPoliticalKeyword("공수처 수사 착수") === true, "공수처가 차단돼야 한다");
  assert(isPoliticalKeyword("법사위 전체회의 파행") === true, "법사위가 차단돼야 한다");
  assert(isPoliticalKeyword("장관 후보자 인사청문회 일정") === true, "인사청문회가 차단돼야 한다");
  console.log("✅ 신규 정치·사정기관 어휘 차단");

  // 일반어는 넣지 않았다는 보증. 연예인 사건 기사가 죽으면 엔터 트랙이 비는 쪽이 더 큰 손해다.
  assert(shouldExcludeCandidate("배우 검찰 조사 입장 밝혔다", "entertainment", "배우") === false, "'검찰' 단독은 엔터 정당 후보를 죽이면 안 된다");
  assert(isPoliticalKeyword("아이돌 음주운전 수사 송치") === false, "'수사'·'송치' 단독은 차단 대상이 아니다");
  assert(isPoliticalKeyword("소속사 재판 1심 판결") === false, "'재판' 단독은 차단 대상이 아니다");
  console.log("✅ 일반 수사·재판 어휘는 통과(엔터 정당 후보 보호)");

  // 사회 트랙 교차 확인(B절). POLITICAL_EXCLUSION_TERMS는 사회 트랙도 공유한다.
  // 최근 2주 사회 run 랭킹 230행 중 신규 어휘 적중은 3건이고 **전부 정치 기사**였다(근거는 보고서).
  assert(isPoliticalKeyword("정청래 법사위 방송 신드롬") === true, "사회 트랙 실측 적중 1: 정치인·상임위 - 현행 정치 배제 원칙상 제외가 맞다");
  assert(isPoliticalKeyword("행안장관 임은정 광주중수청장 1호 감찰 지시") === true, "사회 트랙 실측 적중 2: 사정기관 인사");
  assert(isPoliticalKeyword("과방위 이진숙 방통위 국감") === true, "사회 트랙 실측 적중 3: 국감");
  assert(isPoliticalKeyword("새마을금고 해킹 개인정보 유출 확인 방법") === false, "사회 트랙의 생활·사고 이슈는 통과해야 한다");
  assert(isPoliticalKeyword("인천 흉기난동 피해자 심정지") === false, "사회 트랙의 사건 이슈는 통과해야 한다");
  assert(isPoliticalKeyword("2026 청년내일저축계좌 조건 및 정부지원금 혜택") === false, "정책·지원금 생활정보는 통과해야 한다");
  console.log("✅ 사회 트랙 교차 확인: 정치 기사만 차단, 생활·사건·지원금 이슈는 통과");

  // ⚠️ `상임위` 추가의 알려진 부작용(사용자 결정 대기 - 보고서 5항목).
  // 2026-09-07 채널 개편 주석은 "국회는 청원·상임위 심사처럼 정책·사회 이슈에도 등장하므로 단독으로
  // 걸지 않는다"고 적어 두었다. `상임위`를 넣으면 그 예시 중 하나가 실제로 막힌다. 최근 2주 사회 트랙
  // 실측 적중은 0건이라 당장 손해는 없지만, 동작이 바뀐 사실을 테스트로 드러내 둔다.
  assert(isPoliticalKeyword("국회 국민동의청원 청원 회부") === false, "'국회' 단독은 여전히 통과한다(기존 철학 유지)");
  assert(isPoliticalKeyword("캣맘 새덕후 청원 상임위 회부") === true, "⚠️ '상임위'가 붙으면 이제 차단된다 - 2026-09-07 주석이 통과를 의도했던 사례");
  console.log("⚠️ '상임위' 추가로 '청원 상임위 회부'류가 차단된다(실측 적중 0건, 되돌리려면 어휘 1개 제거)");

  console.log("\n✅ 전체 통과");
}

main();
