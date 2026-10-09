// GA4 Data API(runReport)를 직접 호출한다. SearchConsoleClient와 같은 서비스 계정 JWT 방식 -
// raw fetch + Node 내장 crypto만 쓴다(의존성 0). 읽기 전용 스코프만 받는다.
//
// 일일 sessions·totalUsers·screenPageViews를 채널 그룹별로 받는다(date × sessionDefaultChannelGroup).
// GA4 데이터는 약 1일 지연되므로 호출부가 날짜를 뒤로 물려서 부른다.

import { buildAssertion } from "../searchConsole/SearchConsoleClient.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API_BASE = "https://analyticsdata.googleapis.com/v1beta";
const SCOPE = "https://www.googleapis.com/auth/analytics.readonly";

export type Ga4DailyRow = {
  date: string; // YYYY-MM-DD
  channelGroup: string;
  sessions: number;
  totalUsers: number;
  pageViews: number;
};

export type Ga4Result<T> = { ok: true; data: T } | { ok: false; error: string; stage: string };

/** runReport 응답을 우리 형태로 옮긴다. dimensions: date, sessionDefaultChannelGroup / metrics: sessions, totalUsers, screenPageViews. */
export function mapGa4Rows(raw: unknown): Ga4DailyRow[] {
  const rows = (raw as { rows?: unknown })?.rows;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row): Ga4DailyRow[] => {
    const dims = (row as { dimensionValues?: Array<{ value?: string }> }).dimensionValues;
    const mets = (row as { metricValues?: Array<{ value?: string }> }).metricValues;
    if (!dims || dims.length < 2 || !mets || mets.length < 3) return [];
    const d = String(dims[0].value ?? "");
    if (!/^\d{8}$/.test(d)) return [];
    return [
      {
        date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`,
        channelGroup: String(dims[1].value ?? "(not set)"),
        sessions: Math.round(Number(mets[0].value ?? 0)),
        totalUsers: Math.round(Number(mets[1].value ?? 0)),
        pageViews: Math.round(Number(mets[2].value ?? 0)),
      },
    ];
  });
}

export class Ga4Client {
  private readonly serviceAccountJson: string;
  private readonly fetchImpl: typeof fetch;
  private cachedToken: { token: string; expiresAt: number } | null = null;

  constructor(options: { serviceAccountJson?: string; fetchImpl?: typeof fetch } = {}) {
    this.serviceAccountJson = options.serviceAccountJson ?? process.env.GSC_SERVICE_ACCOUNT_JSON ?? "";
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  missingConfig(): string | null {
    return this.serviceAccountJson ? null : "GSC_SERVICE_ACCOUNT_JSON이 없습니다(GA4도 같은 서비스 계정을 쓴다).";
  }

  private async getAccessToken(): Promise<Ga4Result<string>> {
    if (this.cachedToken && this.cachedToken.expiresAt > Date.now() + 60_000) return { ok: true, data: this.cachedToken.token };

    let account: { client_email?: string; private_key?: string };
    try {
      account = JSON.parse(this.serviceAccountJson);
    } catch {
      return { ok: false, stage: "config", error: "GSC_SERVICE_ACCOUNT_JSON을 JSON으로 읽지 못했습니다." };
    }
    if (!account.client_email || !account.private_key) {
      return { ok: false, stage: "config", error: "서비스 계정 JSON에 client_email/private_key가 없습니다." };
    }

    let assertion: string;
    try {
      assertion = buildAssertion({ client_email: account.client_email, private_key: account.private_key }, new Date(), SCOPE);
    } catch (error) {
      return { ok: false, stage: "token", error: `JWT 서명 실패: ${error instanceof Error ? error.message : String(error)}` };
    }

    const res = await this.fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
    });
    const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string; error?: string };
    if (!res.ok || !json.access_token) {
      return { ok: false, stage: "token", error: `access token 발급 실패(${res.status}): ${json.error_description ?? json.error ?? ""}`.trim() };
    }
    this.cachedToken = { token: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 };
    return { ok: true, data: json.access_token };
  }

  /** 기간(포함)의 일별 × 채널 그룹 지표. 숫자 속성 ID(측정 ID G-… 와 다르다)를 받는다. */
  async fetchDaily(propertyId: string, startDate: string, endDate: string): Promise<Ga4Result<Ga4DailyRow[]>> {
    const configError = this.missingConfig();
    if (configError) return { ok: false, stage: "config", error: configError };
    const token = await this.getAccessToken();
    if (!token.ok) return token;

    const res = await this.fetchImpl(`${API_BASE}/properties/${encodeURIComponent(propertyId)}:runReport`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token.data}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        dateRanges: [{ startDate, endDate }],
        dimensions: [{ name: "date" }, { name: "sessionDefaultChannelGroup" }],
        metrics: [{ name: "sessions" }, { name: "totalUsers" }, { name: "screenPageViews" }],
        limit: 10000,
      }),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    if (!res.ok) {
      return { ok: false, stage: "runReport", error: `runReport 실패(${res.status}): ${json.error?.message ?? ""}`.trim() };
    }
    return { ok: true, data: mapGa4Rows(json) };
  }
}
