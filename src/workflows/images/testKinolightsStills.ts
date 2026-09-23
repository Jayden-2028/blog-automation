// 키노라이츠 공식 스틸 수집 테스트. 실행: npm run test:kinolights
//
// 지켜야 할 것: ① 미디어 섹션만 긁는다(추천작 스틸이 섞이면 안 된다)
// ② **틀린 작품이면 아무것도 안 준다** - 실측에서 `M 리부트`가 헬보이를 물어 왔다
// ③ 제목 후보는 긴 것부터 ④ 실패는 예외가 아니라 빈 배열
import { readFileSync } from "node:fs";
import {
  cleanKeyword,
  extractStills,
  readWorkTitle,
  searchKinolightsStills,
  titleMatchesKeyword,
  toMediaUrl,
  workTitleCandidates,
} from "./searchKinolightsStills.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

/** 실제 페이지 구조를 줄인 것. 미디어 섹션 2장 + 추천작 1장. */
const HTML = `<html><head>
<meta property="og:title" content="연애박사 · 미디어"/>
</head><body>
<button aria-label="스틸컷 1 전체 화면으로 보기"><img src="https://file-dit.kinolights.com/fit-in/1920x0/original/content_still_cut/202609/14/a4953719-9bf2-4220-a218-249cf7dc300b.jpeg"/></button>
<button aria-label="스틸컷 2 전체 화면으로 보기"><img src="https://file-dit.kinolights.com/fit-in/640x0/original/content_still_cut/202609/14/9c64919b-9741-42a2-b48e-7baa6f33ff8c.jpeg"/></button>
<button aria-label="비슷한 작품 보기"><img src="https://file-dit.kinolights.com/fit-in/96x0/original/content_still_cut/202502/10/64e9d036-fd3f-4df9-8ad6-b2fa9a36fb72.jpeg"/></button>
<img src="https://file.kinolights.com/original/content_poster/202609/15/689d6167-e37d-4ec9-91db-b7ec92e563e4.jpeg"/>
</body></html>`;

console.log("▶ 키노라이츠 스틸 테스트 시작\n");

// 1) 미디어 섹션만. 추천작·포스터는 안 들어간다.
{
  const stills = extractStills(HTML, "https://m.kinolights.com/season/152343/media");
  assert(stills.length === 2, `미디어 섹션 2장만 (받은 값: ${stills.length})`);
  assert(stills.every((s) => s.imageUrl.startsWith("https://file.kinolights.com/original/")), "원본 URL로 복원해야 한다");
  assert(!stills.some((s) => s.imageUrl.includes("64e9d036")), "추천작 스틸이 섞이면 안 된다");
  assert(!stills.some((s) => s.imageUrl.includes("content_poster")), "포스터는 스틸이 아니다");
  assert(stills[0].sourcePage.includes("152343"), "출처 페이지를 남겨야 한다");
  console.log("✅ 미디어 섹션만 추출 - 추천작·포스터 제외");
}

// 2) 제목 읽기 - 페이지마다 형식이 다르다.
{
  assert(readWorkTitle(HTML) === "연애박사", "media 페이지 형식");
  assert(
    readWorkTitle('<meta property="og:title" content="연애박사 다시보기 | 키노라이츠 #리뷰"/>') === "연애박사",
    "season 페이지 형식"
  );
  assert(readWorkTitle("<html></html>") === null, "없으면 null");
  console.log("✅ 작품 제목 읽기 - 두 형식 모두");
}

// 3) **틀린 작품 차단.** 실측: `티빙 오리지널 M 리부트`가 헬보이(스틸 20장)를 물어 왔다.
{
  assert(titleMatchesKeyword("연애박사", "연애박사 안판석 감독 유작 추영우 김소현"), "앞머리가 맞으면 통과");
  assert(!titleMatchesKeyword("헬보이", "티빙 오리지널 M 리부트"), "헬보이는 막아야 한다");
  assert(!titleMatchesKeyword("리부트", "티빙 오리지널 M 리부트"), "'리부트'는 'M 리부트'의 앞머리가 아니다");
  assert(!titleMatchesKeyword("시리즈M", "티빙 오리지널 M 리부트"), "시리즈M도 아니다");
  assert(titleMatchesKeyword("폭싹 속았수다", "폭싹 속았수다 결말"), "공백 차이는 무시");
  assert(!titleMatchesKeyword("M", "티빙 오리지널 M 리부트"), "한 글자 제목은 못 믿는다");
  console.log("✅ 틀린 작품 차단 - 헬보이 사고 재발 방지");
}

// 4) 제목 후보는 긴 것부터. 짧은 것부터 가면 한 글자가 엉뚱한 작품을 문다.
{
  const c = workTitleCandidates("티빙 오리지널 M 리부트");
  assert(c[0] === "티빙 오리지널 M 리부트", "원본 키워드가 먼저");
  assert(c.indexOf("M 리부트") < c.indexOf("M") || !c.includes("M"), "긴 후보가 먼저여야 한다");
  assert(cleanKeyword("넷플릭스 오리지널 아무거나") === "아무거나", "플랫폼·장르 수식을 걷어낸다");
  console.log("✅ 제목 후보 - 긴 것부터, 플랫폼 제거");
}

// 5) 실패는 예외가 아니라 빈 배열. 이미지 하나 때문에 원고가 막히면 안 된다.
{
  assert(toMediaUrl("https://example.com/x") === null, "키노라이츠가 아니면 null");
  assert(toMediaUrl("https://m.kinolights.com/season/1/reviews") === "https://m.kinolights.com/season/1/media", "media로 정규화");

  const none = await searchKinolightsStills("아무거나", { findWorkUrl: async () => null, fetchPage: async () => null });
  assert(none.length === 0, "작품을 못 찾으면 빈 배열");

  const failed = await searchKinolightsStills("아무거나", {
    findWorkUrl: async () => { throw new Error("네트워크"); },
    fetchPage: async () => HTML,
  });
  assert(failed.length === 0, "검색이 터져도 예외를 던지지 않는다");

  const wrongWork = await searchKinolightsStills("티빙 오리지널 M 리부트", {
    findWorkUrl: async () => "https://m.kinolights.com/season/69963",
    fetchPage: async () => HTML.replace("연애박사 · 미디어", "헬보이 · 미디어"),
  });
  assert(wrongWork.length === 0, "제목이 안 맞으면 스틸이 있어도 안 쓴다");
  console.log("✅ 실패·오매칭은 빈 배열(예외 없음)");
}

console.log("\n🎉 키노라이츠 스틸 테스트 통과");
