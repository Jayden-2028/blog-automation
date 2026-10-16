// 테마 블로그 조사 풀 수집(PERSON-RESEARCH-SOURCES-2026-10 §B). 맥 person-pack 폴러에서 돈다.
//
// 이 글들은 **구성·커버리지 참고용**이다 - 사실 근거가 아니고 문장·표현을 가져오지 않는다(개인 블로그, 검증 안 됨).
// 검색: 네이버 블로그 검색 API(`bloggerlink`로 풀 필터) -> 상위 3건. 본문: m.blog.naver.com 모바일 페이지(.se-main-container).
// 어떤 실패도 비치명이다(빈 배열 + errors).
import { parse } from "node-html-parser";

import { PERSON_REFERENCE_BLOGS } from "../../config/personReferenceBlogs.js";
import { SOURCE_PACK_USER_AGENT, capUtf8 } from "./personSourcePack.js";
import type { FetchLike } from "./personSourcePack.js";

export const REFERENCE_BLOG_SEARCH_DISPLAY = 30;
export const REFERENCE_BLOG_MAX_POSTS = 3;
/** 건당·합계 상한(UTF-8 바이트). */
export const REFERENCE_BLOG_POST_MAX_BYTES = 8 * 1024;
export const REFERENCE_BLOG_TOTAL_MAX_BYTES = 20 * 1024;

export type ReferenceBlogPost = {
  blogId: string;
  title: string;
  url: string;
  postedAt?: string;
  /** 본문 텍스트(건당 8KB 상한). 광고·위젯·댓글 제외. */
  excerpt: string;
};

/** 블로그 검색 API 응답 항목(필요한 필드만). */
export type BlogSearchItem = { title: string; link: string; description?: string; bloggerlink: string; postdate?: string };

const BLOG_ID_RE = /blog\.naver\.com\/(?:PostView\.naver\?blogId=)?([A-Za-z0-9_.-]+)/i;

export function blogIdOf(url: string): string | null {
  return BLOG_ID_RE.exec(url ?? "")?.[1]?.toLowerCase() ?? null;
}

/** 포스트 링크(`blog.naver.com/<id>/<logNo>` 또는 PostView 형식)에서 logNo. */
export function logNoOf(link: string): string | null {
  return /blog\.naver\.com\/[^/?#]+\/(\d{6,})/i.exec(link)?.[1] ?? /[?&]logNo=(\d{6,})/i.exec(link)?.[1] ?? null;
}

const stripTags = (s: string) => s.replace(/<[^>]*>/g, "").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").trim();

/** bloggerlink가 풀에 속하는 항목만 검색 순서대로 남기고 상위 limit건. 같은 글(logNo) 중복은 뺀다. */
export function filterReferenceBlogItems(
  items: BlogSearchItem[],
  limit: number = REFERENCE_BLOG_MAX_POSTS,
  pool: readonly { blogId: string }[] = PERSON_REFERENCE_BLOGS
): Array<{ blogId: string; logNo: string; title: string; postedAt?: string }> {
  const allowed = new Set(pool.map((b) => b.blogId.toLowerCase()));
  const seen = new Set<string>();
  const out: Array<{ blogId: string; logNo: string; title: string; postedAt?: string }> = [];
  for (const item of items) {
    const blogId = blogIdOf(item.bloggerlink) ?? blogIdOf(item.link);
    const logNo = logNoOf(item.link);
    if (!blogId || !logNo || !allowed.has(blogId) || seen.has(logNo)) continue;
    seen.add(logNo);
    const d = item.postdate && /^\d{8}$/.test(item.postdate) ? `${item.postdate.slice(0, 4)}-${item.postdate.slice(4, 6)}-${item.postdate.slice(6)}` : undefined;
    out.push({ blogId, logNo, title: stripTags(item.title), ...(d ? { postedAt: d } : {}) });
    if (out.length >= limit) break;
  }
  return out;
}

/** 모바일 글 HTML -> 본문 텍스트. SmartEditor 본문 컨테이너만 쓰고 링크 카드·스티커·광고·댓글은 뺀다. */
export function extractBlogPostText(html: string, maxBytes: number = REFERENCE_BLOG_POST_MAX_BYTES): string {
  const root = parse(html, { blockTextElements: { script: false, style: false, noscript: false } });
  root.querySelectorAll("script,style,noscript,svg,iframe").forEach((n) => n.remove());
  const container = root.querySelector(".se-main-container") ?? root.querySelector("#postViewArea") ?? root.querySelector(".post_ct");
  if (!container) return "";
  container
    .querySelectorAll(".se-module-oglink,.se-sticker,.se-module-image,.se-module-video,.se-module-map,.se-module-materialMedia,.ad,.u_cbox,.comment_area,[class*=banner]")
    .forEach((n) => n.remove());
  const text = container.structuredText
    .replace(/ /g, " ")
    .replace(/[​-‍﻿]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text ? capUtf8(text, maxBytes) : "";
}

export type SearchBlogFn = (query: string, display: number) => Promise<BlogSearchItem[]>;

export type CollectReferenceBlogOptions = {
  search: SearchBlogFn;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
};

async function fetchHtml(url: string, fetchImpl: FetchLike, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { headers: { "User-Agent": SOURCE_PACK_USER_AGENT, "Accept-Language": "ko-KR,ko;q=0.9" }, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** 합계 상한을 넘으면 뒤 글부터 줄인다(앞 글 = 검색 상위가 우선). */
export function fitReferencePosts(posts: ReferenceBlogPost[], totalMax: number = REFERENCE_BLOG_TOTAL_MAX_BYTES): ReferenceBlogPost[] {
  let remaining = totalMax;
  const out: ReferenceBlogPost[] = [];
  for (const post of posts) {
    if (remaining < 200) break;
    const excerpt = capUtf8(post.excerpt, Math.min(REFERENCE_BLOG_POST_MAX_BYTES, remaining));
    remaining -= Buffer.byteLength(excerpt, "utf8");
    out.push({ ...post, excerpt });
  }
  return out;
}

/** 인물 이름으로 풀 블로그 글을 찾아 본문까지 담는다. 던지지 않고 errors에 사유를 남긴다. */
export async function collectReferenceBlogPosts(
  keyword: string,
  options: CollectReferenceBlogOptions
): Promise<{ posts: ReferenceBlogPost[]; errors: string[] }> {
  const errors: string[] = [];
  const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? 20_000;
  let hits: ReturnType<typeof filterReferenceBlogItems> = [];
  try {
    hits = filterReferenceBlogItems(await options.search(keyword.trim(), REFERENCE_BLOG_SEARCH_DISPLAY));
  } catch (error) {
    return { posts: [], errors: [`referenceBlogs: 검색 실패 - ${error instanceof Error ? error.message : String(error)}`] };
  }
  const posts: ReferenceBlogPost[] = [];
  for (const hit of hits) {
    const url = `https://m.blog.naver.com/${hit.blogId}/${hit.logNo}`;
    try {
      const excerpt = extractBlogPostText(await fetchHtml(url, fetchImpl, timeoutMs));
      if (!excerpt) {
        errors.push(`referenceBlogs: ${hit.blogId}/${hit.logNo} 본문 비어 있음`);
        continue;
      }
      posts.push({ blogId: hit.blogId, title: hit.title, url, ...(hit.postedAt ? { postedAt: hit.postedAt } : {}), excerpt });
    } catch (error) {
      errors.push(`referenceBlogs: ${hit.blogId}/${hit.logNo} ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { posts: fitReferencePosts(posts), errors };
}
