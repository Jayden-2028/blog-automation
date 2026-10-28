// 네이버 발행본 수집(읽기 전용). 요청 사이 1초 이상 간격을 둔다. 실패는 건너뛰고 errors에 남긴다(비치명).
import { SOURCE_PACK_USER_AGENT } from "../research/personSourcePack.js";
import type { FetchLike } from "../research/personSourcePack.js";
import { extractNaverPost, parseNaverRss } from "./naverPost.js";
import type { NaverPost, RssPost } from "./naverPost.js";
import { dayDiff } from "./match.js";
import { kstDate } from "./text.js";

export const NAVER_BLOG_ID = "whyissuenow";
export const REQUEST_GAP_MS = 1100;
/** 한 번에 읽는 글 수 상한(RSS가 50건이라 사실상 전체 상한). */
export const MAX_POSTS = 50;

export type CollectedPost = RssPost & { post: NaverPost };
export type CollectResult = { posts: CollectedPost[]; listed: number; errors: string[] };

async function getText(url: string, fetchImpl: FetchLike, timeoutMs = 15000): Promise<string> {
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

/** 최근 days일(KST 오늘 포함) 안에 발행된 RSS 항목만 고른다. */
export function selectRecent(items: RssPost[], days: number, today: string): RssPost[] {
  return items.filter((i) => dayDiff(today, i.publishedDate) < days && dayDiff(today, i.publishedDate) >= 0).slice(0, MAX_POSTS);
}

export async function collectNaverPosts(
  days: number,
  options: { fetchImpl?: FetchLike; now?: Date; sleep?: (ms: number) => Promise<void>; blogId?: string } = {}
): Promise<CollectResult> {
  const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const sleep = options.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const blogId = options.blogId ?? NAVER_BLOG_ID;
  const today = kstDate(options.now ?? new Date());
  const errors: string[] = [];

  let listed: RssPost[];
  try {
    listed = parseNaverRss(await getText(`https://rss.blog.naver.com/${blogId}.xml`, fetchImpl));
  } catch (error) {
    return { posts: [], listed: 0, errors: [`RSS 실패: ${error instanceof Error ? error.message : String(error)}`] };
  }
  const targets = selectRecent(listed, days, today);
  const posts: CollectedPost[] = [];
  for (const item of targets) {
    await sleep(REQUEST_GAP_MS);
    try {
      const post = extractNaverPost(await getText(`https://m.blog.naver.com/${blogId}/${item.logNo}`, fetchImpl));
      if (!post) {
        errors.push(`${item.logNo}: 본문 추출 실패`);
        continue;
      }
      posts.push({ ...item, post: { ...post, title: post.title || item.title } });
    } catch (error) {
      errors.push(`${item.logNo}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { posts, listed: targets.length, errors };
}
