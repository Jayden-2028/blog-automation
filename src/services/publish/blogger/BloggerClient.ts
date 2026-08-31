// Blogger API v3 클라이언트. refresh token -> access token 교환 + posts.insert.
// SPRINT_5_DESIGN.md §2/§8. setupBloggerAuth.ts로 발급한 BLOGGER_REFRESH_TOKEN을 쓴다.
//
// 완전 자동 발행이라 실패를 삼키지 않는다 - 모든 실패는 { ok:false, stage, error }로 돌려주고
// 호출자(publishArticleToBlogspot)가 publications.status='failed'로 기록한다.

import { BLOGGER_CONFIG } from "../../../config/publishTargets.js";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const API_BASE = "https://www.googleapis.com/blogger/v3";

export type BloggerPublishStage = "config" | "token" | "insert";

export type BloggerInsertInput = {
  title: string;
  /** 완성된 본문 HTML(convertArticleToHtml 결과). */
  contentHtml: string;
  /** 라벨(BLOGSPOT_LABEL_BY_INTERNAL). 남발 금지 - 보통 1개. */
  labels?: string[];
  /**
   * 검색 설명. Blogger API v3 posts.insert에는 전용 필드가 없어(웹 UI 전용 기능) customMetaData에
   * JSON으로 넣어둔다 - 렌더에 직접 반영되지는 않지만 나중에 posts.patch나 UI에서 참고할 수 있다.
   */
  searchDescription?: string | null;
  /** true면 비공개(draft)로 올린다. 가동 초기 관찰용(BLOGGER_CONFIG.publishAsDraft). */
  isDraft?: boolean;
};

// ⚠️ 커스텀 permalink(영문 kebab 슬러그)는 Blogger API로 지정할 수 없다(웹 UI 전용). 발행 URL은
// Blogger가 제목에서 자동 생성한다(한글 제목 -> /YYYY/MM/blog-post.html 또는 음역). 슬러그는
// 배리에이션 산출물에는 남기되(티스토리·나중 개선용) API 호출에는 쓰지 않는다.

export type BloggerInsertResult =
  | { ok: true; postId: string; url: string; isDraft: boolean }
  | { ok: false; stage: BloggerPublishStage; error: string };

export type BloggerClientOptions = {
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  blogId?: string;
  /** 테스트 주입 지점. 기본은 실제 fetch. */
  fetchImpl?: typeof fetch;
};

export class BloggerClient {
  private readonly clientId?: string;
  private readonly clientSecret?: string;
  private readonly refreshToken?: string;
  private readonly blogId?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: BloggerClientOptions = {}) {
    this.clientId = options.clientId ?? BLOGGER_CONFIG.clientId;
    this.clientSecret = options.clientSecret ?? BLOGGER_CONFIG.clientSecret;
    this.refreshToken = options.refreshToken ?? BLOGGER_CONFIG.refreshToken;
    this.blogId = options.blogId ?? BLOGGER_CONFIG.blogId;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private missingConfig(): string | null {
    const missing = [
      !this.clientId && "BLOGGER_CLIENT_ID",
      !this.clientSecret && "BLOGGER_CLIENT_SECRET",
      !this.refreshToken && "BLOGGER_REFRESH_TOKEN",
      !this.blogId && "BLOGGER_BLOG_ID",
    ].filter(Boolean);
    return missing.length > 0 ? `.env에 ${missing.join(", ")}가 없습니다 (npm run setup:blogger)` : null;
  }

  /** refresh token -> 1시간짜리 access token. */
  async getAccessToken(): Promise<{ ok: true; token: string } | { ok: false; error: string }> {
    const res = await this.fetchImpl(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.clientId!,
        client_secret: this.clientSecret!,
        refresh_token: this.refreshToken!,
        grant_type: "refresh_token",
      }).toString(),
    });
    const json = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      error?: string;
      error_description?: string;
    };
    if (!res.ok || !json.access_token) {
      return {
        ok: false,
        error: `access token 교환 실패 (${res.status}): ${json.error ?? ""} ${json.error_description ?? ""}`.trim(),
      };
    }
    return { ok: true, token: json.access_token };
  }

  async insertPost(input: BloggerInsertInput): Promise<BloggerInsertResult> {
    const configError = this.missingConfig();
    if (configError) return { ok: false, stage: "config", error: configError };

    const token = await this.getAccessToken();
    if (!token.ok) return { ok: false, stage: "token", error: token.error };

    const isDraft = input.isDraft ?? BLOGGER_CONFIG.publishAsDraft;
    const url = new URL(`${API_BASE}/blogs/${this.blogId}/posts/`);
    url.searchParams.set("isDraft", String(isDraft));
    url.searchParams.set("fetchImages", "false");

    const body: Record<string, unknown> = {
      kind: "blogger#post",
      title: input.title,
      content: input.contentHtml,
    };
    if (input.labels && input.labels.length > 0) body.labels = input.labels;
    if (input.searchDescription) body.customMetaData = JSON.stringify({ description: input.searchDescription });

    const res = await this.fetchImpl(url.toString(), {
      method: "POST",
      headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as {
      id?: string;
      url?: string;
      error?: { message?: string };
    };
    if (!res.ok || !json.id) {
      return { ok: false, stage: "insert", error: `posts.insert 실패 (${res.status}): ${json.error?.message ?? ""}`.trim() };
    }
    // draft는 아직 공개 URL이 없다(Blogger가 blog 루트를 돌려준다) - 편집 화면 링크를 준다.
    const resultUrl = isDraft
      ? `https://www.blogger.com/blog/post/edit/${this.blogId}/${json.id}`
      : json.url ?? "";
    return { ok: true, postId: json.id, url: resultUrl, isDraft };
  }
}
