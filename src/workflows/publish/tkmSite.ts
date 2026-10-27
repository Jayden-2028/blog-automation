// The Korea Manual 사이트 단위 작업(2026-10-27): 글 목록 읽기, All Guides 허브 페이지 재생성, 발행 직후 본문 마무리.
// 순수 변환은 tkmPostStructure.ts에 있고, 여기는 Blogger API를 부르는 쪽이다(테스트는 TkmSiteDeps를 주입한다).
//
// All Guides 페이지는 **발행할 때마다 다시 만든다**(pages.patch, 멱등). 정적 목록으로 두면 다음 글부터 다시 고아가 된다.
// 페이지 ID는 저장하지 않는다 - 매번 pages.list에서 경로(/p/all-guides.html)로 찾는다. 없으면 새로 만든다.

import type { BloggerClient, BloggerListedPage } from "../../services/publish/blogger/BloggerClient.js";
import {
  TKM_ALL_GUIDES_PATH,
  TKM_ALL_GUIDES_TITLE,
  TKM_JSONLD_IN_BODY,
  applyTkmStructure,
  buildAllGuidesHtml,
  describePost,
  firstImageUrl,
  pickTkmRelated,
  siteOrigin,
} from "./tkmPostStructure.js";
import type { TkmPost } from "./tkmPostStructure.js";

export type TkmSiteDeps = {
  listPosts: () => Promise<TkmPost[]>;
  listPages: () => Promise<BloggerListedPage[]>;
  insertPage: (title: string, html: string) => Promise<BloggerListedPage>;
  patchPage: (pageId: string, title: string, html: string) => Promise<void>;
  patchPostContent: (postId: string, html: string) => Promise<void>;
};

function unwrap<T>(result: { ok: true } & T | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(result.error);
  return result;
}

export function bloggerTkmSiteDeps(client: BloggerClient): TkmSiteDeps {
  return {
    listPosts: async () => unwrap(await client.listLivePosts()).posts,
    listPages: async () => unwrap(await client.listPages()).pages,
    insertPage: async (title, html) => unwrap(await client.insertPage(title, html)).page,
    patchPage: async (pageId, title, html) => {
      unwrap(await client.patchPage(pageId, title, html));
    },
    patchPostContent: async (postId, html) => {
      const result = await client.patchPostContent(postId, html);
      if (!result.ok) throw new Error(result.error);
    },
  };
}

export function findAllGuidesPage(pages: readonly BloggerListedPage[]): BloggerListedPage | null {
  return pages.find((page) => page.url && new URL(page.url).pathname === TKM_ALL_GUIDES_PATH) ?? null;
}

/**
 * All Guides 페이지를 지금 글 목록으로 다시 만든다. 없으면 만든다. 돌려주는 값은 페이지 공개 URL.
 * `dryRun`이면 아무것도 쓰지 않고, 있으면 그 주소를, 없으면 만들어질 주소(글 URL의 origin + 경로)를 돌려준다.
 */
export async function syncAllGuidesPage(
  deps: TkmSiteDeps,
  posts: readonly TkmPost[],
  options: { dryRun?: boolean } = {}
): Promise<{ url: string | null; action: "created" | "updated" | "would-create" | "would-update" }> {
  const existing = findAllGuidesPage(await deps.listPages());
  const html = buildAllGuidesHtml(posts);
  if (options.dryRun) {
    const origin = posts.map((post) => siteOrigin(post.url)).find(Boolean) ?? null;
    return existing
      ? { url: existing.url, action: "would-update" }
      : { url: origin ? `${origin}${TKM_ALL_GUIDES_PATH}` : null, action: "would-create" };
  }
  if (existing) {
    await deps.patchPage(existing.id, TKM_ALL_GUIDES_TITLE, html);
    return { url: existing.url, action: "updated" };
  }
  const created = await deps.insertPage(TKM_ALL_GUIDES_TITLE, html);
  return { url: created.url || null, action: "created" };
}

/** 발행 직전 본문에 넣을 사이트 정보(글 목록 + 허브 주소). 실패하면 null - 발행을 막지 않는다. */
export async function loadTkmSiteContext(deps: TkmSiteDeps): Promise<{ posts: TkmPost[]; allGuidesUrl: string | null } | null> {
  try {
    const [posts, pages] = await Promise.all([deps.listPosts(), deps.listPages()]);
    return { posts, allGuidesUrl: findAllGuidesPage(pages)?.url ?? null };
  } catch (error) {
    console.warn(`⚠️ [tkm] 글 목록을 읽지 못했습니다(구조 보강 없이 발행): ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export type TkmPostIdentity = {
  postId: string;
  url: string;
  title: string;
  labels: string[];
  /** ISO. 새로 공개한 글이면 지금 시각. */
  published: string;
  searchDescription: string | null;
};

/**
 * 공개된 글 하나를 마무리한다: All Guides 재생성 -> 그 주소와 (켜져 있으면) JSON-LD로 본문을 다시 짜서 바뀌었으면 patch.
 * 전부 실패해도 던지지 않는다 - 글은 이미 공개됐고, 구조 보강은 다음 발행이나 일괄 갱신에서 다시 맞춰진다.
 */
export async function finalizeTkmPost(
  deps: TkmSiteDeps,
  post: TkmPostIdentity,
  publishedHtml: string,
  now: () => Date = () => new Date()
): Promise<{ allGuidesUrl: string | null; patched: boolean; warnings: string[] }> {
  const warnings: string[] = [];
  let posts: TkmPost[] = [];
  try {
    posts = await deps.listPosts();
  } catch (error) {
    warnings.push(`글 목록: ${error instanceof Error ? error.message : String(error)}`);
    return { allGuidesUrl: null, patched: false, warnings };
  }
  // 방금 공개한 글이 목록에 아직 없을 수 있다(API 반영 지연) - 직접 넣는다.
  const self: TkmPost = { url: post.url, title: post.title, labels: post.labels, published: post.published };
  if (!posts.some((candidate) => candidate.url === post.url)) posts = [self, ...posts];

  let allGuidesUrl: string | null = null;
  try {
    allGuidesUrl = (await syncAllGuidesPage(deps, posts)).url;
  } catch (error) {
    warnings.push(`All Guides 페이지: ${error instanceof Error ? error.message : String(error)}`);
  }

  const next = applyTkmStructure(publishedHtml, {
    related: pickTkmRelated(self, posts, allGuidesUrl),
    jsonLd: TKM_JSONLD_IN_BODY
      ? {
          url: post.url,
          headline: post.title,
          description: describePost(publishedHtml, post.searchDescription),
          datePublished: post.published,
          dateModified: now().toISOString(),
          imageUrl: firstImageUrl(publishedHtml),
        }
      : null,
  }).html;
  if (next === publishedHtml) return { allGuidesUrl, patched: false, warnings };
  try {
    await deps.patchPostContent(post.postId, next);
    return { allGuidesUrl, patched: true, warnings };
  } catch (error) {
    warnings.push(`본문 마무리: ${error instanceof Error ? error.message : String(error)}`);
    return { allGuidesUrl, patched: false, warnings };
  }
}
