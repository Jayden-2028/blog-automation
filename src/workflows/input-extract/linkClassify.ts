// 종합 키워드 입력 툴 B부: 링크 종류 판정(순수). robots.txt가 막은 경로는 여기서 "읽지 않음"으로 분류한다.
//
// 실측(2026-10-19, 발주서): m.blog.naver.com 글 경로 허용 / n.news.naver.com `Disallow: /` / cafe·threads·instagram 본문 차단.

export type LinkKind =
  | { kind: "naver_blog"; blogId: string; logNo: string; mobileUrl: string }
  | { kind: "naver_news"; oid: string; aid: string }
  | { kind: "naver_cafe" }
  | { kind: "youtube"; videoId: string }
  | { kind: "tistory" }
  | { kind: "web" }
  | { kind: "blocked"; reason: string };

const PRIVATE_HOST_RE = /^(?:localhost|.*\.local|.*\.internal|\d{1,3}(?:\.\d{1,3}){3}|\[.*\])$/i;

export function classifyLink(rawUrl: string): LinkKind {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return { kind: "blocked", reason: "주소 형식이 올바르지 않습니다." };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { kind: "blocked", reason: "http(s) 주소가 아닙니다." };
  const host = u.hostname.toLowerCase();
  if (PRIVATE_HOST_RE.test(host)) return { kind: "blocked", reason: "내부 주소는 읽지 않습니다." };

  // 네이버 블로그: blog.naver.com/<id>/<logNo> · m.blog.naver.com/<id>/<logNo> · PostView.naver?blogId=&logNo=
  if (host === "blog.naver.com" || host === "m.blog.naver.com") {
    const path = /^\/([^/?#]+)\/(\d{6,})/.exec(u.pathname);
    const blogId = path?.[1] ?? u.searchParams.get("blogId");
    const logNo = path?.[2] ?? u.searchParams.get("logNo");
    if (blogId && logNo && /^\d{6,}$/.test(logNo) && !/^PostView/i.test(blogId)) {
      return { kind: "naver_blog", blogId, logNo, mobileUrl: `https://m.blog.naver.com/${blogId}/${logNo}` };
    }
    return { kind: "blocked", reason: "블로그 글 주소가 아닙니다(글 번호가 없습니다)." };
  }

  // 네이버 뉴스: 직접 fetch 금지(robots Disallow /). 검색 API로 우회한다.
  if (host === "n.news.naver.com" || host === "news.naver.com" || host === "m.news.naver.com") {
    const m = /\/article\/(\d+)\/(\d+)/.exec(u.pathname);
    const oid = m?.[1] ?? u.searchParams.get("oid");
    const aid = m?.[2] ?? u.searchParams.get("aid");
    if (oid && aid) return { kind: "naver_news", oid, aid };
    return { kind: "blocked", reason: "네이버 뉴스 기사 주소가 아닙니다." };
  }

  if (host === "cafe.naver.com" || host === "m.cafe.naver.com") return { kind: "naver_cafe" };

  // 유튜브: 쇼츠·일반·youtu.be
  if (host === "youtu.be") {
    const id = u.pathname.split("/").filter(Boolean)[0];
    if (id && /^[\w-]{6,}$/.test(id)) return { kind: "youtube", videoId: id };
  }
  if (host === "youtube.com" || host === "www.youtube.com" || host === "m.youtube.com") {
    const shorts = /^\/(?:shorts|embed|live)\/([\w-]{6,})/.exec(u.pathname);
    const id = shorts?.[1] ?? (u.pathname === "/watch" ? u.searchParams.get("v") : null);
    if (id && /^[\w-]{6,}$/.test(id)) return { kind: "youtube", videoId: id };
    return { kind: "blocked", reason: "유튜브 영상 주소가 아닙니다." };
  }

  const bare = host.replace(/^www\./, "");
  if (bare === "instagram.com" || bare.endsWith(".instagram.com") || bare === "threads.com" || bare === "threads.net" || bare.endsWith(".threads.com") || bare.endsWith(".threads.net")) {
    return { kind: "blocked", reason: "인스타·스레드 본문은 읽지 않습니다(캡처 큐 전용)." };
  }

  if (host.endsWith(".tistory.com")) return { kind: "tistory" };
  return { kind: "web" };
}
