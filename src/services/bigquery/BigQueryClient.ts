// BigQuery REST(jobs.query)를 직접 호출한다. Ga4Client·SearchConsoleClient와 같은 서비스 계정
// JWT 방식 - raw fetch + Node 내장 crypto만 쓴다(@google-cloud/bigquery를 붙이지 않는다).
//
// 왜 BigQuery인가: Cloud Billing API는 결제 계정 목록과 단가(SKU)만 주고 "실제로 얼마 썼는지"는
// 주지 않는다. 실제 청구액은 결제 데이터 내보내기로 BigQuery에 쌓인 테이블을 읽어야 한다.
//
// 스칼라만 다룬다: REST 응답의 rows[].f[].v는 중첩(RECORD)·반복(REPEATED) 필드를 객체/배열로
// 돌려주는데, 호출부 SQL에서 service.description 처럼 미리 평탄화하므로 여기서는 문자열로만 읽는다.

import { buildAssertion } from "../searchConsole/SearchConsoleClient.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API_BASE = "https://bigquery.googleapis.com/bigquery/v2";
const SCOPE = "https://www.googleapis.com/auth/bigquery.readonly";

export type BigQueryResult<T> = { ok: true; data: T } | { ok: false; error: string; stage: string };
export type BigQueryRow = Record<string, string | null>;

type QueryResponse = {
  jobComplete?: boolean;
  jobReference?: { jobId?: string; location?: string };
  schema?: { fields?: Array<{ name?: string }> };
  rows?: Array<{ f?: Array<{ v?: unknown }> }>;
  error?: { message?: string };
};

/** schema.fields의 이름 순서와 rows[].f의 위치가 1:1로 대응한다. */
export function mapRows(res: QueryResponse): BigQueryRow[] {
  const names = (res.schema?.fields ?? []).map((f) => String(f?.name ?? ""));
  return (res.rows ?? []).map((row) => {
    const cells = row?.f ?? [];
    const out: BigQueryRow = {};
    names.forEach((name, i) => {
      const v = cells[i]?.v;
      out[name] = v === null || v === undefined ? null : String(v);
    });
    return out;
  });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class BigQueryClient {
  private readonly serviceAccountJson: string;
  private readonly fetchImpl: typeof fetch;
  private cachedToken: { token: string; expiresAt: number } | null = null;

  constructor(options: { serviceAccountJson?: string; fetchImpl?: typeof fetch } = {}) {
    this.serviceAccountJson = options.serviceAccountJson ?? process.env.GCP_SA_KEY ?? "";
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  missingConfig(): string | null {
    return this.serviceAccountJson ? null : "GCP_SA_KEY가 없습니다(BigQuery 읽기 전용 서비스 계정 JSON).";
  }

  private async getAccessToken(): Promise<BigQueryResult<string>> {
    if (this.cachedToken && this.cachedToken.expiresAt > Date.now() + 60_000) {
      return { ok: true, data: this.cachedToken.token };
    }

    let account: { client_email?: string; private_key?: string };
    try {
      account = JSON.parse(this.serviceAccountJson);
    } catch {
      return { ok: false, stage: "config", error: "GCP_SA_KEY를 JSON으로 읽지 못했습니다(파일 내용 전체를 넣었는지 확인)." };
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
    const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!res.ok || !json.access_token) {
      return { ok: false, stage: "token", error: `access token 발급 실패(${res.status}): ${json.error_description ?? json.error ?? ""}`.trim() };
    }
    this.cachedToken = { token: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 };
    return { ok: true, data: json.access_token };
  }

  /** 데이터셋 안의 테이블 이름 목록. 내보내기가 만든 테이블 이름을 사람이 몰라도 찾아내려고 쓴다. */
  async listTables(projectId: string, datasetId: string): Promise<BigQueryResult<string[]>> {
    const configError = this.missingConfig();
    if (configError) return { ok: false, stage: "config", error: configError };
    const token = await this.getAccessToken();
    if (!token.ok) return token;

    const url = `${API_BASE}/projects/${encodeURIComponent(projectId)}/datasets/${encodeURIComponent(datasetId)}/tables?maxResults=200`;
    const res = await this.fetchImpl(url, { headers: { Authorization: `Bearer ${token.data}` } });
    const json = (await res.json().catch(() => ({}))) as { tables?: Array<{ tableReference?: { tableId?: string } }>; error?: { message?: string } };
    if (!res.ok) {
      return { ok: false, stage: "listTables", error: `테이블 목록 조회 실패(${res.status}): ${json.error?.message ?? ""}`.trim() };
    }
    return { ok: true, data: (json.tables ?? []).map((t) => String(t?.tableReference?.tableId ?? "")).filter(Boolean) };
  }

  /** 표준 SQL 질의. 작은 결과는 즉시 돌아오고, 아니면 완료될 때까지 짧게 폴링한다. */
  async query(projectId: string, sql: string): Promise<BigQueryResult<BigQueryRow[]>> {
    const configError = this.missingConfig();
    if (configError) return { ok: false, stage: "config", error: configError };
    const token = await this.getAccessToken();
    if (!token.ok) return token;
    const headers = { Authorization: `Bearer ${token.data}`, "Content-Type": "application/json" };

    const res = await this.fetchImpl(`${API_BASE}/projects/${encodeURIComponent(projectId)}/queries`, {
      method: "POST",
      headers,
      body: JSON.stringify({ query: sql, useLegacySql: false, timeoutMs: 60_000 }),
    });
    let payload = (await res.json().catch(() => ({}))) as QueryResponse;
    if (!res.ok) {
      return { ok: false, stage: "query", error: `질의 실패(${res.status}): ${payload.error?.message ?? ""}`.trim() };
    }

    // 큰 테이블이면 첫 응답이 jobComplete=false로 돌아온다. 결과가 나올 때까지만 짧게 기다린다.
    let waited = 0;
    while (!payload.jobComplete && payload.jobReference?.jobId && waited < 120_000) {
      await sleep(3_000);
      waited += 3_000;
      const jobId = encodeURIComponent(payload.jobReference.jobId);
      const location = payload.jobReference.location ? `&location=${encodeURIComponent(payload.jobReference.location)}` : "";
      const poll = await this.fetchImpl(
        `${API_BASE}/projects/${encodeURIComponent(projectId)}/queries/${jobId}?timeoutMs=30000${location}`,
        { headers }
      );
      payload = (await poll.json().catch(() => ({}))) as QueryResponse;
      if (!poll.ok) {
        return { ok: false, stage: "query", error: `질의 결과 조회 실패(${poll.status}): ${payload.error?.message ?? ""}`.trim() };
      }
    }
    if (!payload.jobComplete) {
      return { ok: false, stage: "query", error: "질의가 제한 시간 안에 끝나지 않았습니다. 기간을 줄여 다시 실행하세요." };
    }
    return { ok: true, data: mapRows(payload) };
  }
}
