// Blogger API v3 클라이언트. refresh token -> access token 교환 + posts.insert.
// SPRINT_5_DESIGN.md §2/§8. setupBloggerAuth.ts로 발급한 BLOGGER_REFRESH_TOKEN을 쓴다.
//
// 완전 자동 발행이라 실패를 삼키지 않는다 - 모든 실패는 { ok:false, stage, error }로 돌려주고
// 호출자(publishArticleToBlogspot)가 publications.status='failed'로 기록한다.

import { BLOGGER_CONFIG } from "../../../config/publishTargets.js";
import type { BloggerReaderComments } from "../../../config/publishTargets.js";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const API_BASE = "https://www.googleapis.com/blogger/v3";

export type BloggerPublishStage = "config" | "token" | "insert" | "publish";

export type BloggerInsertInput = {
  title: string;
  /** 완성된 본문 HTML(convertArticleToHtml 결과). */
  contentHtml: string;
  /** 라벨(BLOGSPOT_LABEL_BY_INTERNAL). 남발 금지 - 보통 1개. */
  labels?: string[];
  /**
   * ⚠️ 검색 설명은 **API로 설정할 수 없다**(2026-09-16 실측). 예전엔 `customMetaData`에 JSON으로
   * 넣었는데, PATCH가 200을 돌려주면서도 값이 저장되지 않는다(GET으로 재조회 시 필드 자체가 없음).
   * 공식 Post 리소스 문서에도 없는 필드였다. 조용히 버려지는 호출을 남겨두면 "보냈으니 됐겠지"로
   * 착각하게 되므로 아예 보내지 않는다 - 검색 설명은 발행 후 Blogger UI에서 사람이 넣어야 한다
   * (원고 뷰어가 값을 보여주므로 복사해 붙여넣으면 된다).
   */
  searchDescription?: string | null;
  /** true면 비공개(draft)로 올린다. 가동 초기 관찰용(BLOGGER_CONFIG.publishAsDraft). */
  isDraft?: boolean;
  /** 글별 댓글 허용. 생략하면 BLOGGER_CONFIG.readerComments(기본 비허용). */
  readerComments?: BloggerReaderComments;
};

// ⚠️ 커스텀 permalink(영문 kebab 슬러그)는 Blogger API로 지정할 수 없다(웹 UI 전용). 발행 URL은
// Blogger가 제목에서 자동 생성한다(한글 제목 -> /YYYY/MM/blog-post.html 또는 음역). 슬러그는
// 배리에이션 산출물에는 남기되(티스토리·나중 개선용) API 호출에는 쓰지 않는다.

export type BloggerInsertResult =
  | { ok: true; postId: string; url: string; isDraft: boolean }
  | { ok: false; stage: BloggerPublishStage; error: string };

export type BloggerPublishResult =
  | { ok: true; postId: string; url: string; status: string; publishedAt: string; scheduled: boolean }
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
      // 댓글은 기본 비허용(사용자 결정 2026-09-16). 유효값 3종은 실측으로 확인했다.
      readerComments: input.readerComments ?? BLOGGER_CONFIG.readerComments,
    };
    if (input.labels && input.labels.length > 0) body.labels = input.labels;
    // searchDescription은 의도적으로 보내지 않는다 - 위 타입 주석 참고(API가 조용히 버린다).

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

  /**
   * 초안(draft)을 발행하거나 미래 시각으로 **예약**한다(posts.publish).
   *
   * `publishDate`를 주면 그 시각에 공개되도록 예약되고, 생략하면 즉시 공개된다. 임시저장 →
   * 사람이 검수(퍼머링크·검색 설명 입력) → 예약 공개 흐름을 코드로 잇기 위한 지점이다
   * (2026-09-16 사용자 요청).
   *
   * ⚠️ 즉시 공개든 예약이든 **글이 실제로 공개되는 동작**이다 - 호출부가 사용자 승인을 받고
   * 호출해야 한다(CLAUDE.md 발행 게이트).
   */
  async publishPost(postId: string, publishDate?: Date): Promise<BloggerPublishResult> {
    const configError = this.missingConfig();
    if (configError) return { ok: false, stage: "config", error: configError };

    const token = await this.getAccessToken();
    if (!token.ok) return { ok: false, stage: "token", error: token.error };

    const url = new URL(`${API_BASE}/blogs/${this.blogId}/posts/${postId}/publish`);
    if (publishDate) url.searchParams.set("publishDate", publishDate.toISOString());

    const res = await this.fetchImpl(url.toString(), {
      method: "POST",
      headers: { Authorization: `Bearer ${token.token}` },
    });
    const json = (await res.json().catch(() => ({}))) as {
      id?: string;
      url?: string;
      status?: string;
      published?: string;
      error?: { message?: string };
    };
    if (!res.ok || !json.id) {
      return { ok: false, stage: "publish", error: `posts.publish 실패 (${res.status}): ${json.error?.message ?? ""}`.trim() };
    }
    return {
      ok: true,
      postId: json.id,
      url: json.url ?? "",
      status: json.status ?? "",
      publishedAt: json.published ?? "",
      scheduled: Boolean(publishDate),
    };
  }
}
