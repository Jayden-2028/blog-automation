// 네이버 블로그 주소를 **본문이 실제로 담긴 주소**로 바꾼다(2026-09-24 실측).
//
// 문제: `blog.naver.com/{id}/{logNo}`를 그대로 받으면 **2.8KB짜리 프레임 껍데기**가 온다.
// 본문은 iframe 안에 있어서, 내려받아 글자를 뽑아도 남는 게 없다. 리서처가 "도메인 fetch 차단"
// 이라고 적고 포기한 것이 사실은 이것이었다(2026-09-23 영등포 결혼박람회 - 후기 본문을 못 읽어
// 업체명·혜택이 통째로 빠졌다).
//
// 실측(같은 글, 같은 UA):
//
//   blog.naver.com/edgeau7569/224420542599        2,859B   프레임 껍데기 - 본문 없음
//   m.blog.naver.com/edgeau7569/224420542599     88,777B   본문 2,711자 ✅
//   blog.naver.com/PostView.naver?...           226,701B   본문 + UI 텍스트가 섞여 더 지저분
//
// 그래서 **모바일 주소**를 쓴다. 서버 렌더링이라 JS 없이 열리고, PostView보다 UI 잡음이 적다.
//
// 카페는 이 방법으로 안 된다(실측): 원본은 로그인 벽, `m.cafe.naver.com`은 JS 전용 SPA(160자),
// 내부 API는 500이다. 로그인 없이는 읽을 수 없다.

/** `blog.naver.com/{blogId}/{logNo}` 형태만 바꾼다. 나머지는 그대로 둔다. */
const NAVER_BLOG_POST = /^https?:\/\/(?:www\.)?blog\.naver\.com\/([A-Za-z0-9_-]+)\/(\d+)/i;
/** 이미 iframe 안쪽을 직접 가리키는 형태. 이것도 모바일로 통일한다. */
const NAVER_BLOG_POSTVIEW = /^https?:\/\/(?:www\.)?blog\.naver\.com\/PostView\.naver/i;

/**
 * 내려받기 좋은 주소로 바꾼다. 네이버 블로그가 아니면 **그대로 돌려준다**.
 *
 * 원본 주소는 바꾸지 않는다 - 출처 목록·캡션에는 사람이 여는 주소가 남아야 한다.
 * 이 함수는 **fetch 직전에만** 쓴다.
 */
export function toFetchableUrl(url: string): string {
  const post = url.match(NAVER_BLOG_POST);
  if (post) return `https://m.blog.naver.com/${post[1]}/${post[2]}`;

  if (NAVER_BLOG_POSTVIEW.test(url)) {
    try {
      const parsed = new URL(url);
      const blogId = parsed.searchParams.get("blogId");
      const logNo = parsed.searchParams.get("logNo");
      if (blogId && logNo) return `https://m.blog.naver.com/${blogId}/${logNo}`;
    } catch {
      // URL로 안 읽히면 그대로 둔다.
    }
  }

  return url;
}

/** 로그인 없이는 본문을 못 읽는 주소인가. 리서처가 헛수고하지 않게 미리 알려준다. */
export function needsLoginToRead(url: string): boolean {
  return /^https?:\/\/(?:m\.)?cafe\.naver\.com\//i.test(url);
}
