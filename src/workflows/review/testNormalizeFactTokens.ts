// normalizeFactTokens 테스트. 외부 호출 없이 순수 함수만 검증한다.
//
// 핵심 검증 대상은 "같은 사실의 다른 표기가 같은 값으로 정규화되는가"다. 이게 깨지면 팩트 검사가
// 멀쩡한 원고를 전부 걸어 쓸모없어진다(SPRINT_3_DESIGN.md 4-1절).
//
// 실제 원고에서 나온 표기를 회귀 케이스로 쓴다: 경복궁 별빛야행(예매 기간·6만 원),
// 아이폰18(300만원대), 재혼 황후(27억 뷰).

import { buildFactCorpus, extractFactTokens } from "./normalizeFactTokens.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

function normalizedOf(text: string): string[] {
  return extractFactTokens(text).map((t) => t.normalized);
}

function main(): void {
  console.log("▶ normalizeFactTokens 테스트 시작\n");

  // 1) 핵심 회귀: 근거의 "2026. 9. 2."와 본문의 "9월 2일"이 같은 값으로 맞물려야 한다.
  const sourceCorpus = buildFactCorpus(["행사 기간 2026. 9. 2.(수) ~ 10. 24.(토)"]);
  const bodyTokens = normalizedOf("9월 2일부터 10월 24일까지 진행됩니다.");
  assert(bodyTokens.includes("09-02"), `본문 "9월 2일"이 09-02로 정규화돼야 한다 (실제: ${bodyTokens})`);
  assert(sourceCorpus.has("09-02"), `근거 "2026. 9. 2."도 09-02를 포함해야 한다 (실제: ${[...sourceCorpus]})`);
  assert(sourceCorpus.has("2026-09-02"), "연도가 있는 근거는 전체 형태도 남겨야 한다");
  assert(bodyTokens.every((t) => sourceCorpus.has(t)), "본문 날짜가 전부 근거에서 확인돼야 한다");
  console.log("✅ 연도 있는 근거 표기 <-> 연도 없는 본문 표기가 맞물림");

  // 2) 다양한 날짜 표기가 같은 값으로 모인다.
  for (const text of ["2026. 9. 2.", "2026년 9월 2일", "2026-09-02", "2026/9/2"]) {
    assert(normalizedOf(text).includes("2026-09-02"), `"${text}" -> 2026-09-02 실패 (실제: ${normalizedOf(text)})`);
  }
  console.log("✅ 날짜 4종 표기(마침표/한글/하이픈/슬래시) 동일 정규화");

  // 3) 슬래시 축약("8/14")도 날짜로 읽는다 - 조사 요약에서 자주 나오는 형태다.
  assert(normalizedOf("응모기간 8/14~8/20").includes("08-14"), "8/14를 08-14로 읽어야 한다");
  console.log("✅ 슬래시 축약 날짜 인식");

  // 3-1) 회귀: 기간 표기에서 뒤쪽 날짜의 연도가 생략된 경우("2026. 9. 2.(수) ~ 10. 24.(토)").
  // 이 패턴이 없으면 근거에 분명히 있는 종료일이 미검출로 걸린다 - 구현 중 실제로 발생했다.
  const range = normalizedOf("2026. 9. 2.(수) ~ 10. 24.(토)");
  assert(range.includes("09-02"), `기간 시작일 인식 실패 (실제: ${range})`);
  assert(range.includes("10-24"), `연도 생략된 종료일 인식 실패 (실제: ${range})`);
  console.log("✅ 연도 생략된 마침표 표기 종료일 인식(공공 페이지 기간 표기 회귀)");

  // 3-2) 위 패턴이 월/일 범위를 벗어난 숫자를 날짜로 오인하지 않아야 한다.
  const notDate = normalizedOf("항목 13. 45. 참고");
  assert(!notDate.includes("13-45"), `월/일 범위를 벗어난 값은 날짜가 아니다 (실제: ${notDate})`);
  console.log("✅ 월/일 범위 밖 숫자는 날짜로 읽지 않음");

  // 4) 금액: "60,000원"과 "6만 원"이 같은 값이어야 한다(경복궁 실제 표기).
  const money1 = normalizedOf("1매 60,000원");
  const money2 = normalizedOf("1인 6만 원");
  assert(money1.includes("money:60000"), `60,000원 -> money:60000 실패 (실제: ${money1})`);
  assert(money2.includes("money:60000"), `6만 원 -> money:60000 실패 (실제: ${money2})`);
  console.log("✅ 금액: 쉼표 표기와 한글 만 단위가 동일 정규화");

  // 5) "300만원대" 같은 근사 표기도 숫자를 읽는다(아이폰18 원고 실제 표기).
  assert(normalizedOf("2026년 300만원대 전망").includes("money:3000000"), "300만원대 -> money:3000000 실패");
  console.log("✅ 근사 접미사가 붙은 금액도 인식");

  // 6) 단위가 붙은 수치는 잡고, 값과 단위를 함께 구분한다.
  const counts = normalizedOf("회차당 38명, 1일 76명, 약 110분 진행");
  assert(counts.includes("num:38:명"), `38명 인식 실패 (실제: ${counts})`);
  assert(counts.includes("num:76:명"), "76명 인식 실패");
  assert(counts.includes("num:110:분"), "110분 인식 실패");
  console.log("✅ 단위 붙은 수치 인식(값+단위 구분)");

  // 7) 억 단위(재혼 황후 "27억 뷰")도 푼다. 단, "뷰"는 우리 단위 목록에 없으므로 수치로는
  //    안 잡힌다 - 목록에 없는 단위를 억지로 넓히면 오탐이 늘기 때문이다. 여기서는 금액 단위가
  //    아닌 큰 수가 잘못 금액으로 잡히지 않는지만 확인한다.
  assert(!normalizedOf("누적 27억 뷰").some((t) => t.startsWith("money:")), "뷰 수치를 금액으로 오인하면 안 된다");
  console.log("✅ 단위 목록에 없는 수치를 금액으로 오인하지 않음");

  // 8) 오탐 방지: 두 자리 미만 수치("1인", "2개")는 검사 대상이 아니다.
  const small = normalizedOf("1인 2개씩 3회");
  assert(small.length === 0, `한 자리 수치는 토큰이 되면 안 된다 (실제: ${small})`);
  console.log("✅ 한 자리 수치는 제외(오탐 방지)");

  // 9) 오탐 방지: 단위 없는 맨숫자는 잡지 않는다.
  const bare = normalizedOf("조회수가 크게 늘었고 순위도 올랐다 1234");
  assert(bare.length === 0, `단위 없는 맨숫자는 토큰이 되면 안 된다 (실제: ${bare})`);
  console.log("✅ 단위 없는 맨숫자는 제외(오탐 방지)");

  // 9-1) 회귀(2026-08-28 실측): 퍼센트 인코딩 URL에서 가짜 백분율이 뽑히면 안 된다.
  // "%ED%98%BC" 안에는 "98%"라는 문자열이 들어 있어 실제로 백분율로 잡혔고, 재혼 황후 원고의
  // 미검출 토큰 12개 중 10개가 전부 이런 URL 조각이었다.
  const withUrl = normalizedOf(
    "- [재혼 황후](https://blog.naver.com/x/%EC%9E%AC%ED%98%BC%ED%99%A9%ED%9B%84)"
  );
  assert(
    !withUrl.some((t) => t.includes("%")),
    `URL 인코딩에서 백분율을 뽑으면 안 된다 (실제: ${withUrl})`
  );
  const bareUrl = normalizedOf("출처 https://example.com/%ED%98%BC 참고");
  assert(bareUrl.length === 0, `맨 URL에서도 토큰이 나오면 안 된다 (실제: ${bareUrl})`);
  console.log("✅ URL(퍼센트 인코딩 포함)에서 가짜 토큰을 뽑지 않음");

  // 9-2) 회귀(2026-08-28 실측): 숫자 없이 쉼표만 있어도 금액으로 잡히던 버그(", 원" -> money:0).
  const commaOnly = normalizedOf("비용이 들었습니다, 원고는 다음과 같습니다");
  assert(
    !commaOnly.some((t) => t.startsWith("money:")),
    `숫자 없는 "원"을 금액으로 잡으면 안 된다 (실제: ${commaOnly})`
  );
  console.log("✅ 숫자 없는 쉼표+원을 금액으로 오인하지 않음");

  // 9-3) 마크다운 링크의 표시 텍스트에 있는 사실은 살아남아야 한다(URL만 지우지 텍스트는 아니다).
  const linkText = normalizedOf("- [9월 2일 개막 안내](https://example.com/a)");
  assert(linkText.includes("09-02"), `링크 표시 텍스트의 날짜는 남아야 한다 (실제: ${linkText})`);
  console.log("✅ 링크 표시 텍스트의 사실은 보존");

  // 10) 같은 값이 여러 번 나와도 토큰은 한 번만 남는다.
  const repeated = normalizedOf("9월 2일에 시작해 9월 2일부터 예매가 열린다");
  assert(repeated.filter((t) => t === "09-02").length === 1, "중복 값은 한 번만 남아야 한다");
  console.log("✅ 중복 토큰 제거");

  // 11) 빈 입력/null 근거에도 죽지 않는다.
  assert(extractFactTokens("").length === 0, "빈 문자열은 빈 배열이어야 한다");
  assert(buildFactCorpus([null, undefined, ""]).size === 0, "빈 근거 목록은 빈 집합이어야 한다");
  console.log("✅ 빈 입력 안전 처리");

  // 12) 실제 미검출 사례: 근거에 없는 금액이 본문에 있으면 corpus에 없어야 한다(팩트 검사의 근거).
  const corpus = buildFactCorpus(["가격은 1매 60,000원입니다."]);
  const invented = normalizedOf("특별석은 12만 원입니다.");
  assert(invented.includes("money:120000"), "본문 금액이 토큰으로 잡혀야 한다");
  assert(!corpus.has("money:120000"), "근거에 없는 금액은 corpus에 없어야 한다(= 검사에서 걸린다)");
  console.log("✅ 근거에 없는 값은 corpus 미포함(팩트 검사가 성립함)");

  console.log("\n✅ normalizeFactTokens 테스트 완료");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
