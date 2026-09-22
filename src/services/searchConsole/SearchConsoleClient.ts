// Google Search Console API(Search Analytics)를 직접 호출한다. SDK를 쓰지 않는다 -
// BloggerClient와 같은 이유로 raw fetch + Node 내장 crypto만 쓴다(의존성 0).
//
// 인증이 Blogger와 다르다(2026-09-21 설계 결정):
//   Blogger         OAuth 사용자 동의 → refresh token. 브라우저 클릭이 한 번 필요했고 만료 이슈가 있다.
//   Search Console  **서비스 계정 JWT**. 동의 화면·콜백 URL이 없고 만료도 없다. GSC 속성에
//                   그 서비스 계정 이메일을 "사용자 추가"만 하면 바로 읽힌다.
// 매일 도는 무인 작업이라 사람 손이 다시 필요한 방식(refresh token 재동의)을 피했다.
//
// ⚠️ GSC 데이터는 **2~3일 지연**된다. 오늘 날짜로 조회하면 0건이 나온다 - 호출부가 날짜를 뒤로
// 물려서 부른다(fetchSearchPerformance.ts의 REPORT_LAG_DAYS).

import { createSign } from "node:crypto";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API_BASE = "https://searchconsole.googleapis.com/webmasters/v3";
/** 읽기만 한다. 쓰기 스코프를 받지 않는 것 자체가 사고 방지다. */
const SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
/** API 1회 응답 상한. 이보다 많으면 startRow로 이어 받는다. */
const ROW_LIMIT = 25_000;

export type SearchAnalyticsRow = {
  date: string;
  pageUrl: string;
  query: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
};

/** URL Inspection 결과 중 우리가 쓰는 것만. 전체 응답은 훨씬 크다. */
export type UrlInspectionResult = {
  url: string;
  /** PASS / PARTIAL / FAIL / NEUTRAL / VERDICT_UNSPECIFIED */
  verdict: string;
  /** "Submitted and indexed", "Redirect error" 같은 사람이 읽는 상태 문자열. 분류의 기준이다. */
  coverageState: string;
  robotsTxtState: string;
  pageFetchState: string;
  lastCrawlTime: string | null;
  /** 구글이 고른 표준 URL. 우리가 넣은 것과 다르면 중복 취급되고 있다는 뜻이다. */
  googleCanonical: string | null;
};

export type SearchConsoleResult<T> = { ok: true; data: T } | { ok: false; error: string; stage: string };

export type SearchConsoleOptions = {
  /** 서비스 계정 JSON 전문(환경변수 GSC_SERVICE_ACCOUNT_JSON). */
  serviceAccountJson?: string;
  /** 속성 주소. URL 접두어 속성이면 "https://example.com/", 도메인 속성이면 "sc-domain:example.com". */
  siteUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
};

type ServiceAccount = { client_email: string; private_key: string };

function base64Url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * 서비스 계정 키로 구글 토큰 엔드포인트에 낼 JWT를 만든다(RS256).
 *
 * 순수 함수로 빼 둔 이유: 네트워크 없이 테스트할 수 있어야 한다 - 서명이 깨지면 401만 보이고
 * 원인이 안 보인다(실측 아님, 예방). 키 내용은 절대 로그에 남기지 않는다.
 */
export function buildAssertion(account: ServiceAccount, now: Date): string {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64Url(
    JSON.stringify({
      iss: account.client_email,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: issuedAt,
      exp: issuedAt + 3600,
    })
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claim}`);
  // 환경변수를 거치며 줄바꿈이 "\n" 문자열로 굳는 경우가 흔하다 - 되돌려 놓지 않으면 서명이 깨진다.
  const key = account.private_key.replace(/\\n/g, "\n");
  return `${header}.${claim}.${base64Url(signer.sign(key))}`;
}

/** GSC 응답 row를 우리 형태로 옮긴다. dimensions 순서는 호출부가 date,page,query로 고정한다. */
export function mapAnalyticsRows(raw: unknown): SearchAnalyticsRow[] {
  const rows = (raw as { rows?: unknown })?.rows;
  if (!Array.isArray(rows)) return [];

  return rows.flatMap((row): SearchAnalyticsRow[] => {
    const keys = (row as { keys?: unknown }).keys;
    if (!Array.isArray(keys) || keys.length < 3) return [];
    const [date, pageUrl, query] = keys.map((k) => String(k));
    const metrics = row as { clicks?: number; impressions?: number; ctr?: number; position?: number };
    return [
      {
        date,
        pageUrl,
        query,
        clicks: Math.round(metrics.clicks ?? 0),
        impressions: Math.round(metrics.impressions ?? 0),
        ctr: Number(metrics.ctr ?? 0),
        position: Number(metrics.position ?? 0),
      },
    ];
  });
}

export class SearchConsoleClient {
  private readonly serviceAccountJson: string;
  private readonly siteUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private cachedToken: { token: string; expiresAt: number } | null = null;

  constructor(options: SearchConsoleOptions = {}) {
    this.serviceAccountJson = options.serviceAccountJson ?? process.env.GSC_SERVICE_ACCOUNT_JSON ?? "";
    this.siteUrl = options.siteUrl ?? process.env.GSC_SITE_URL ?? "";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  /** 설정 누락을 호출 전에 거른다 - "토큰 없음"이 401 API 오류로 둔갑하지 않게. */
  missingConfig(): string | null {
    if (!this.serviceAccountJson) return "GSC_SERVICE_ACCOUNT_JSON이 없습니다(서비스 계정 JSON 전문).";
    if (!this.siteUrl) return "GSC_SITE_URL이 없습니다(예: https://whynowissue.blogspot.com/).";
    return null;
  }

  private parseAccount(): SearchConsoleResult<ServiceAccount> {
    try {
      const parsed = JSON.parse(this.serviceAccountJson) as Partial<ServiceAccount>;
      if (!parsed.client_email || !parsed.private_key) {
        return { ok: false, stage: "config", error: "서비스 계정 JSON에 client_email/private_key가 없습니다." };
      }
      return { ok: true, data: { client_email: parsed.client_email, private_key: parsed.private_key } };
    } catch {
      // 키 내용은 찍지 않는다.
      return { ok: false, stage: "config", error: "GSC_SERVICE_ACCOUNT_JSON을 JSON으로 읽지 못했습니다." };
    }
  }

  private async getAccessToken(): Promise<SearchConsoleResult<string>> {
    const cached = this.cachedToken;
    if (cached && cached.expiresAt > this.now().getTime() + 60_000) return { ok: true, data: cached.token };

    const account = this.parseAccount();
    if (!account.ok) return account;

    let assertion: string;
    try {
      assertion = buildAssertion(account.data, this.now());
    } catch (error) {
      return { ok: false, stage: "token", error: `JWT 서명 실패(키 형식 확인): ${error instanceof Error ? error.message : String(error)}` };
    }

    const res = await this.fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
    });
    const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string; error?: string };

    if (!res.ok || !json.access_token) {
      return {
        ok: false,
        stage: "token",
        error: `access token 발급 실패(${res.status}): ${json.error_description ?? json.error ?? ""}`.trim(),
      };
    }
    this.cachedToken = { token: json.access_token, expiresAt: this.now().getTime() + (json.expires_in ?? 3600) * 1000 };
    return { ok: true, data: json.access_token };
  }

  /**
   * 하루치 성과를 date×page×query로 받아온다. 25,000건을 넘으면 이어 받는다.
   *
   * 왜 세 축을 한 번에 받는가: "어느 글이 어떤 검색어로 들어왔나"가 우리가 알고 싶은 것이다.
   * page만 받으면 검색어를 모르고, query만 받으면 어느 글인지 모른다.
   */
  async fetchDay(date: string): Promise<SearchConsoleResult<SearchAnalyticsRow[]>> {
    const configError = this.missingConfig();
    if (configError) return { ok: false, stage: "config", error: configError };

    const token = await this.getAccessToken();
    if (!token.ok) return token;

    const url = `${API_BASE}/sites/${encodeURIComponent(this.siteUrl)}/searchAnalytics/query`;
    const all: SearchAnalyticsRow[] = [];

    for (let startRow = 0; ; startRow += ROW_LIMIT) {
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token.data}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          startDate: date,
          endDate: date,
          dimensions: ["date", "page", "query"],
          rowLimit: ROW_LIMIT,
          startRow,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } };

      if (!res.ok) {
        return {
          ok: false,
          stage: "query",
          error: `searchAnalytics 실패(${res.status}): ${json.error?.message ?? ""}`.trim(),
        };
      }

      const page = mapAnalyticsRows(json);
      all.push(...page);
      if (page.length < ROW_LIMIT) break;
    }

    return { ok: true, data: all };
  }

  /**
   * URL 하나의 색인 상태를 묻는다(URL Inspection API).
   *
   * Search Analytics와 다른 엔드포인트·다른 버전(v1)을 쓴다. 할당량도 따로 잡히는데
   * 사이트당 하루 2,000건이라 우리 규모(수십 건)에서는 여유가 많다.
   *
   * 이 API가 있어서 "색인이 안 되고 있다"를 사람이 GSC를 열어보고 발견할 필요가 없어진다
   * (2026-09-21 - 실제로 그렇게 발견했다).
   */
  async inspectUrl(url: string): Promise<SearchConsoleResult<UrlInspectionResult>> {
    const configError = this.missingConfig();
    if (configError) return { ok: false, stage: "config", error: configError };

    const token = await this.getAccessToken();
    if (!token.ok) return token;

    const res = await this.fetchImpl("https://searchconsole.googleapis.com/v1/urlInspection/index:inspect", {
      method: "POST",
      headers: { Authorization: `Bearer ${token.data}`, "Content-Type": "application/json" },
      body: JSON.stringify({ inspectionUrl: url, siteUrl: this.siteUrl }),
    });
    const json = (await res.json().catch(() => ({}))) as {
      inspectionResult?: { indexStatusResult?: Record<string, unknown> };
      error?: { message?: string };
    };

    if (!res.ok) {
      return { ok: false, stage: "inspect", error: `urlInspection 실패(${res.status}): ${json.error?.message ?? ""}`.trim() };
    }

    const status = json.inspectionResult?.indexStatusResult ?? {};
    return {
      ok: true,
      data: {
        url,
        verdict: String(status.verdict ?? "VERDICT_UNSPECIFIED"),
        coverageState: String(status.coverageState ?? ""),
        robotsTxtState: String(status.robotsTxtState ?? ""),
        pageFetchState: String(status.pageFetchState ?? ""),
        lastCrawlTime: status.lastCrawlTime ? String(status.lastCrawlTime) : null,
        googleCanonical: status.googleCanonical ? String(status.googleCanonical) : null,
      },
    };
  }
}
