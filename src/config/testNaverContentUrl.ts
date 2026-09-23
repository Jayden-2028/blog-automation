// 네이버 본문 주소 변환 테스트. 실행: npm run test:naver-content-url
//
// 지켜야 할 것: ① 블로그 글 주소만 모바일로 바꾼다 ② 그 외 주소는 손대지 않는다
// ③ 카페는 로그인이 필요하다고 알려준다
import { needsLoginToRead, toFetchableUrl } from "./naverContentUrl.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

console.log("▶ 네이버 본문 주소 변환 테스트 시작\n");

// 1) 블로그 글 - 실측에서 원본은 2.8KB 껍데기, 모바일은 88KB 본문이었다.
{
  assert(
    toFetchableUrl("https://blog.naver.com/edgeau7569/224420542599") ===
      "https://m.blog.naver.com/edgeau7569/224420542599",
    "블로그 글은 모바일 주소로 바꾼다"
  );
  assert(
    toFetchableUrl("http://www.blog.naver.com/abc_123/1") === "https://m.blog.naver.com/abc_123/1",
    "www·http도 처리한다"
  );
  assert(
    toFetchableUrl("https://blog.naver.com/edgeau7569/224420542599?from=search") ===
      "https://m.blog.naver.com/edgeau7569/224420542599",
    "쿼리는 떼고 본문 주소만 만든다"
  );
  console.log("✅ 블로그 글 -> 모바일 주소");
}

// 2) PostView 형태도 모바일로 통일한다.
{
  assert(
    toFetchableUrl("https://blog.naver.com/PostView.naver?blogId=abc&logNo=42&redirect=Dlog") ===
      "https://m.blog.naver.com/abc/42",
    "PostView도 모바일로"
  );
  assert(
    toFetchableUrl("https://blog.naver.com/PostView.naver?foo=1") ===
      "https://blog.naver.com/PostView.naver?foo=1",
    "blogId·logNo가 없으면 그대로 둔다"
  );
  console.log("✅ PostView -> 모바일 주소");
}

// 3) 그 외 주소는 한 글자도 안 바꾼다. 이 함수가 남의 주소를 망치면 안 된다.
{
  for (const url of [
    "https://www.etoday.co.kr/news/view/2629056",
    "https://m.blog.naver.com/abc/1",
    "https://blog.naver.com/edgeau7569",
    "https://cafe.naver.com/x/1",
    "https://example.com/blog.naver.com/a/1",
    "not-a-url",
  ]) {
    assert(toFetchableUrl(url) === url, `건드리면 안 된다: ${url}`);
  }
  console.log("✅ 그 외 주소는 그대로");
}

// 4) 카페는 로그인 벽이다(실측: 원본 로그인 페이지, 모바일 JS 전용, API 500).
{
  assert(needsLoginToRead("https://cafe.naver.com/cafemakecafebest/87351"), "카페는 로그인 필요");
  assert(needsLoginToRead("https://m.cafe.naver.com/x/1"), "모바일 카페도 마찬가지");
  assert(!needsLoginToRead("https://m.blog.naver.com/a/1"), "블로그는 로그인 불필요");
  console.log("✅ 카페는 로그인 필요로 표시");
}

console.log("\n🎉 네이버 본문 주소 변환 테스트 통과");
