// 종합 키워드 입력 툴 B부 오케스트레이터: 링크 1개 -> 소스 본문(+제목). 모든 실패는 **비치명**이다 - job을 막지 않고
// "본문을 붙여넣어 달라"는 답장(needs_paste)으로 돌려준다(발주서 B-5). 네트워크는 전부 주입받아 테스트는 고정 응답으로 돈다.
//
// 어디서 도는가: 봇 수신이 클라우드(GitHub Actions)라 기본은 클라우드 fetch다. m.blog가 클라우드 IP에서 403이면 맥 배달 패턴으로
// 옮기는 후속이 필요하다 - 아래 `HTTP 403`/`HTTP 4xx` 실패 메시지가 그 신호다(KEYWORD-INPUT-TOOL-IMPL-REPORT 참고).
import { SOURCE_PACK_USER_AGENT, capUtf8 } from "../research/personSourcePack.js";
import type { FetchLike } from "../research/personSourcePack.js";
import { extractBlogPostText } from "../research/referenceBlogPosts.js";
import { ARTICLE_TEXT_MAX_BYTES, MIN_ARTICLE_CHARS, extractArticleText, extractTitle } from "./extractArticleText.js";
import { classifyLink } from "./linkClassify.js";
import { isUrlAllowedByRobots } from "./robots.js";

export type NewsSearchItem = { title: string; description: string; link: string; originallink: string };

export type ExtractDeps = {
  fetchImpl: FetchLike;
  /** 네이버 뉴스 검색 API(기존 키). 없으면 네이버 뉴스 링크는 붙여넣기 안내로 간다. */
  searchNews?: (query: string) => Promise<NewsSearchItem[]>;
  /** env YOUTUBE_API_KEY. 없으면 유튜브 기능은 꺼진다(비치명). */
  youtubeApiKey?: string | null;
  timeoutMs?: number;
};

export type ExtractVia = "naver_blog" | "web" | "tistory" | "news_original" | "news_api_summary" | "youtube_meta";

export type ExtractResult =
  | { status: "ok"; url: string; title: string | null; text: string; via: ExtractVia }
  | { status: "needs_paste"; reply: string };

const PASTE_TAIL = "본문을 복사해 텍스트로 보내 주세요.";
const needsPaste = (reason: string): ExtractResult => ({ status: "needs_paste", reply: `${reason} ${PASTE_TAIL}` });

async function fetchText(url: string, deps: ExtractDeps, accept?: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 15000);
  try {
    const res = await deps.fetchImpl(url, {
      headers: { "User-Agent": SOURCE_PACK_USER_AGENT, "Accept-Language": "ko-KR,ko;q=0.9", ...(accept ? { Accept: accept } : {}) },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** 일반 웹 글(티스토리·블로그·언론사 원문). robots를 먼저 본다. */
async function extractWebPage(url: string, via: "web" | "tistory" | "news_original", deps: ExtractDeps): Promise<ExtractResult> {
  if (!(await isUrlAllowedByRobots(url, deps.fetchImpl))) return needsPaste("이 사이트는 자동 수집을 허용하지 않거나 확인하지 못했습니다.");
  let html: string;
  try {
    html = await fetchText(url, deps);
  } catch (error) {
    return needsPaste(`글을 가져오지 못했습니다(${error instanceof Error ? error.message : "오류"}).`);
  }
  const { title, text } = extractArticleText(html);
  if (!text) return needsPaste("본문을 찾지 못했습니다.");
  return { status: "ok", url, title, text, via };
}

async function extractNaverBlog(mobileUrl: string, deps: ExtractDeps): Promise<ExtractResult> {
  let html: string;
  try {
    html = await fetchText(mobileUrl, deps);
  } catch (error) {
    // HTTP 403이면 클라우드 IP 차단일 수 있다 - 보고서의 probe 항목.
    return needsPaste(`블로그 글을 가져오지 못했습니다(${error instanceof Error ? error.message : "오류"}).`);
  }
  const text = extractBlogPostText(html, ARTICLE_TEXT_MAX_BYTES);
  if (!text) return needsPaste("블로그 본문을 읽지 못했습니다(비공개이거나 스마트에디터 글이 아닐 수 있습니다).");
  return { status: "ok", url: mobileUrl, title: extractTitle(html), text, via: "naver_blog" };
}

async function extractNaverNews(oid: string, aid: string, hint: string, deps: ExtractDeps): Promise<ExtractResult> {
  // n.news.naver.com은 robots `Disallow: /`라 직접 가져오지 않는다. 제목(hint)으로 검색 API에서 같은 기사를 찾아 언론사 원문을 읽는다.
  if (!deps.searchNews || !hint.trim()) {
    return needsPaste("네이버 뉴스 페이지는 직접 읽을 수 없습니다(수집 금지). 기사 제목을 링크와 함께 보내면 언론사 원문을 찾아 읽습니다. 또는");
  }
  let items: NewsSearchItem[];
  try {
    items = await deps.searchNews(hint.trim());
  } catch {
    return needsPaste("뉴스 검색에 실패했습니다.");
  }
  const match = items.find((i) => i.link.includes(`/${oid}/${aid}`) || (i.link.includes(`oid=${oid}`) && i.link.includes(`aid=${aid}`)));
  if (!match) return needsPaste("제목으로 해당 기사를 찾지 못했습니다(제목을 더 정확히 보내 보세요).");

  const original = match.originallink;
  if (original) {
    const kind = classifyLink(original).kind;
    if (kind === "web" || kind === "tistory") {
      const fromOriginal = await extractWebPage(original, "news_original", deps);
      if (fromOriginal.status === "ok") return { ...fromOriginal, title: fromOriginal.title ?? match.title };
    }
  }
  // 원문을 못 읽으면 API 응답의 제목·요약만 쓴다(발주서 B-3).
  const text = `${match.title}\n\n${match.description}`.trim();
  return { status: "ok", url: original || match.link, title: match.title, text: capUtf8(text, ARTICLE_TEXT_MAX_BYTES), via: "news_api_summary" };
}

async function extractYoutube(videoId: string, url: string, deps: ExtractDeps): Promise<ExtractResult> {
  if (!deps.youtubeApiKey) {
    return { status: "needs_paste", reply: "유튜브 영상 정보를 자동으로 읽는 기능이 꺼져 있습니다(YOUTUBE_API_KEY 없음). 영상 요점을 같이 보내 주세요." };
  }
  try {
    const api = `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${encodeURIComponent(videoId)}&key=${encodeURIComponent(deps.youtubeApiKey)}`;
    const body = JSON.parse(await fetchText(api, deps, "application/json")) as {
      items?: Array<{ snippet?: { title?: string; description?: string; channelTitle?: string } }>;
    };
    const snippet = body.items?.[0]?.snippet;
    if (!snippet?.title) return { status: "needs_paste", reply: "영상 정보를 찾지 못했습니다(비공개이거나 삭제된 영상일 수 있습니다). 영상 요점을 같이 보내 주세요." };
    // 자막은 수집하지 않는다(공식 API로 남의 영상 자막은 못 받는다 - 비공식 수단 금지). 제목·채널·설명만.
    const text = [`제목: ${snippet.title}`, snippet.channelTitle ? `채널: ${snippet.channelTitle}` : null, snippet.description ? `설명:\n${snippet.description}` : null]
      .filter(Boolean)
      .join("\n");
    return { status: "ok", url, title: snippet.title, text: capUtf8(text, ARTICLE_TEXT_MAX_BYTES), via: "youtube_meta" };
  } catch {
    // 오류 메시지에 요청 URL(=API 키)이 섞일 수 있어 원문을 노출하지 않는다.
    return { status: "needs_paste", reply: "유튜브 영상 정보를 가져오지 못했습니다. 영상 요점을 같이 보내 주세요." };
  }
}

/**
 * 링크 1개를 소스 본문으로 읽는다. `hint`는 사용자가 링크와 함께 보낸 말(뉴스 검색어·유튜브 요점으로 쓴다).
 * 예외를 던지지 않는다 - 어떤 실패든 needs_paste다.
 */
export async function extractLinkSource(url: string, hint: string, deps: ExtractDeps): Promise<ExtractResult> {
  try {
    const link = classifyLink(url);
    switch (link.kind) {
      case "naver_blog":
        return await extractNaverBlog(link.mobileUrl, deps);
      case "naver_news":
        return await extractNaverNews(link.oid, link.aid, hint, deps);
      case "naver_cafe":
        return needsPaste("네이버 카페 글은 자동으로 읽을 수 없습니다(수집 금지).");
      case "youtube":
        return await extractYoutube(link.videoId, url, deps);
      case "tistory":
        return await extractWebPage(url, "tistory", deps);
      case "web":
        return await extractWebPage(url, "web", deps);
      case "blocked":
        return needsPaste(link.reason);
    }
  } catch (error) {
    return needsPaste(`링크를 읽다 실패했습니다(${error instanceof Error ? error.message : "오류"}).`);
  }
}

export { MIN_ARTICLE_CHARS };
