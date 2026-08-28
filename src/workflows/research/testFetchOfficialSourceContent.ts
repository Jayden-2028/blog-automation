// fetchOfficialSourceContent(공공 도메인 본문 추출/채택 판정) 테스트. 실제 네트워크 fetch는
// 하지 않는다 - extractReadableText/looksLikeProse/shouldReplaceSnippet은 순수 함수라 HTML 문자열만
// 넣어 검증한다. enrichOfficialSources는 fetch를 감싸므로 이 파일에서는 판정 함수만 다룬다.
//
// 2026-08-27 실측 회귀: "2026년 경복궁 별빛야행"(kh.or.kr) 페이지에서 실제로 추출됐던 네비게이션
// 텍스트를 그대로 케이스로 고정한다 - 이게 다시 "본문"으로 채택되면 안 된다.

import { extractReadableText, looksLikeProse, shouldReplaceSnippet } from "./fetchOfficialSourceContent.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

// 2026-08-27 실측: kh.or.kr에서 querySelector 없이 root.text를 그대로 썼을 때 나온 실제 텍스트.
const REAL_NAV_MENU_TEXT = `
경복궁


창덕궁


덕수궁


창경궁


종묘


수문장 교대의식


사회적 배려대상자 초청 프로그램




축전



궁`;

function main(): void {
  console.log("▶ fetchOfficialSourceContent 테스트 시작\n");

  // 1) 회귀 케이스: 실제로 수집됐던 네비게이션 메뉴 텍스트는 산문이 아니어야 한다.
  assert(!looksLikeProse(REAL_NAV_MENU_TEXT), "실측 네비게이션 텍스트가 산문으로 오판되면 안 된다(2026-08-27 회귀)");
  console.log("✅ 실측 네비게이션 메뉴 텍스트 -> 산문 아님으로 정확히 거부");

  // 2) 실제 기사/공지 본문 같은 긴 문장은 산문으로 인식돼야 한다.
  const prose =
    "경복궁 별빛야행은 경복궁 북측 권역을 전문 해설과 함께 걷는 야간 탐방 프로그램입니다. " +
    "조선 왕실의 생활과 경복궁에 얽힌 이야기를 들으며 궁궐 곳곳을 이동하고, 궁궐 부엌인 " +
    "외소주방에서 궁중 수라상을 현대적으로 재해석한 12첩 반상을 도슭 형태로 맛봅니다.";
  assert(looksLikeProse(prose), "실제 문장으로 구성된 본문은 산문으로 인식돼야 한다");
  console.log("✅ 실제 문장 본문 -> 산문으로 정확히 인식");

  // 3) 짧은 메뉴 항목 나열(각 줄이 40자 미만)은 산문이 아니다.
  const shortMenuItems = Array.from({ length: 30 }, (_, i) => `메뉴항목${i}`).join("\n");
  assert(!looksLikeProse(shortMenuItems), "짧은 항목이 아무리 많아도 산문이 아니어야 한다");
  console.log("✅ 짧은 메뉴 항목 다수 나열 -> 산문 아님");

  // 4) 긴 줄이 소수 섞여 있어도 전체에서 차지하는 비중이 낮으면 산문이 아니다(메뉴 사이에 낀
  //    안내 문구 한 줄 때문에 전체를 본문으로 오판하면 안 된다). 실제 캡처(REAL_NAV_MENU_TEXT)와
  //    같은 밀도가 되도록 충분한 양의 메뉴 항목을 넣는다 - 항목이 너무 적으면 긴 줄 하나의 비중이
  //    쉽게 15%를 넘어버려 이 케이스 자체가 성립하지 않는다.
  const bulkyMenu = Array.from({ length: 200 }, (_, i) => `메뉴항목-${i}`).join("\n");
  const menuWithOneLongLine =
    bulkyMenu + "\n이 페이지는 준비 중입니다. 빠른 시일 내에 서비스를 제공하겠습니다. 이용에 불편을 드려 죄송합니다.";
  assert(!looksLikeProse(menuWithOneLongLine), "긴 줄 하나만으로 전체를 산문으로 오판하면 안 된다");
  console.log("✅ 메뉴 사이 안내문 한 줄 -> 비중 미달로 산문 아님");

  // 5) 빈 문자열/공백은 산문이 아니다.
  assert(!looksLikeProse(""), "빈 문자열은 산문이 아니어야 한다");
  assert(!looksLikeProse("   \n   \n  "), "공백만 있으면 산문이 아니어야 한다");
  console.log("✅ 빈 값/공백 처리 정상");

  // 6) extractReadableText: nav/header/footer가 있고 main 안에 실제 본문이 있으면 main만 뽑는다.
  const htmlWithMain = `<html><body>
    <nav>경복궁 창덕궁 덕수궁 창경궁 종묘 수문장 교대의식</nav>
    <header>사이트 헤더 메뉴 링크 모음</header>
    <main><p>${prose}</p></main>
    <footer>저작권 안내 사업자 정보</footer>
  </body></html>`;
  const mainText = extractReadableText(htmlWithMain);
  assert(mainText.includes("궁중 수라상"), "main 태그 안의 실제 본문을 추출해야 한다");
  assert(!mainText.includes("수문장 교대의식"), "nav 안의 메뉴 텍스트가 섞이면 안 된다");
  console.log("✅ main 태그 우선 추출, nav/header/footer 제외");

  // 7) main이 없고 nav만 있는 페이지(회귀 재현): body 폴백도 산문이 아니므로 호출자가
  //    shouldReplaceSnippet에서 거부해야 한다.
  const htmlNavOnly = `<html><body><nav>경복궁 창덕궁 덕수궁 창경궁 종묘</nav></body></html>`;
  const navOnlyText = extractReadableText(htmlNavOnly);
  assert(!looksLikeProse(navOnlyText), "nav만 있는 페이지의 추출 결과는 산문이 아니어야 한다");
  console.log("✅ main 없이 nav만 있는 페이지 -> 산문 아님(회귀 재현 확인)");

  // 8) shouldReplaceSnippet: 산문이고 스니펫보다 길 때만 교체한다.
  assert(shouldReplaceSnippet(prose, "짧은 스니펫"), "산문 + 스니펫보다 김 -> 교체해야 한다");
  assert(!shouldReplaceSnippet(REAL_NAV_MENU_TEXT, "짧은 스니펫"), "메뉴 텍스트는 스니펫보다 길어도 교체하면 안 된다");
  assert(!shouldReplaceSnippet(prose, prose + " 더 긴 원래 스니펫"), "fetch 결과가 기존 스니펫보다 짧으면 교체하면 안 된다");
  assert(!shouldReplaceSnippet("", "스니펫"), "빈 결과는 교체하면 안 된다");
  console.log("✅ shouldReplaceSnippet: 산문 + 더 김 조건 모두 충족할 때만 교체");

  console.log("\n✅ fetchOfficialSourceContent 테스트 완료");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
