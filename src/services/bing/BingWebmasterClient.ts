// Bing Webmaster URL Submission API 클라이언트(2026-10-27, TKM 색인 대응).
//
// 키가 없으면(GitHub secret 미등록 포함) 조용히 건너뛴다. 오류는 던지지 않고 결과 객체로 돌려준다 -
// 호출부는 이미 공개된 글의 부가 작업이라, 여기서 실패해도 발행 성공을 되돌리거나 실패로 만들면 안 된다.
//
//   POST {BASE}/SubmitUrlBatch?apikey=  body {siteUrl, urlList}
//   GET  {BASE}/GetUrlSubmissionQuota?siteUrl=&apikey=  -> {d:{DailyQuota, MonthlyQuota}}
// siteUrl은 Bing Webmaster에 등록된 사이트와 같아야 한다(끝 슬래시 포함 형태로 보낸다).

const BING_API_BASE = "https://ssl.bing.com/webmaster/api.svc/json";
const REQUEST_TIMEOUT_MS = 15_000;

export type BingFetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}>;

export type BingSubmitResult =
  | { skipped: "no-key" }
  | { skipped: "no-urls" }
  | { ok: true; submitted: number }
  | { ok: false; error: string; status?: number };

export type BingQuotaResult =
  | { skipped: "no-key" }
  | { ok: true; dailyQuota: number; monthlyQuota: number }
  | { ok: false; error: string; status?: number };

export type BingClientOptions = {
  /** 생략하면 process.env.BING_WEBMASTER_API_KEY. 빈 문자열이면 건너뛴다. */
  apiKey?: string | undefined;
  fetchImpl?: BingFetch;
  log?: (message: string) => void;
};

/** Bing에 등록된 사이트 주소 형태: origin + 끝 슬래시. */
export function normalizeSiteUrl(value: string): string {
  const url = new URL(value);
  return `${url.origin}/`;
}

/**
 * 제출에 쓸 siteUrl. BING_SITE_URL이 있으면 그것을 우선하고(커스텀 도메인 전환 대비), 없으면 글 URL의 origin.
 * 둘 다 없으면 null.
 */
export function resolveBingSiteUrl(sampleUrl: string | null | undefined, env: string | undefined = process.env.BING_SITE_URL): string | null {
  for (const candidate of [env?.trim(), sampleUrl]) {
    if (!candidate) continue;
    try {
      return normalizeSiteUrl(candidate);
    } catch {
      // 잘못된 값은 다음 후보로
    }
  }
  return null;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class BingWebmasterClient {
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: BingFetch;
  private readonly log: (message: string) => void;

  constructor(options: BingClientOptions = {}) {
    this.apiKey = ("apiKey" in options ? options.apiKey : process.env.BING_WEBMASTER_API_KEY)?.trim() || undefined;
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.log = options.log ?? ((message) => console.log(message));
  }

  get enabled(): boolean {
    return Boolean(this.apiKey);
  }

  async submitUrls(siteUrl: string, urls: readonly string[]): Promise<BingSubmitResult> {
    if (!this.apiKey) {
      this.log("ℹ️ [bing] BING_WEBMASTER_API_KEY 없음 - URL 제출 건너뜀");
      return { skipped: "no-key" };
    }
    const urlList = [...new Set(urls.filter(Boolean))];
    if (urlList.length === 0) return { skipped: "no-urls" };

    const response = await this.request(`/SubmitUrlBatch?apikey=${encodeURIComponent(this.apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ siteUrl, urlList }),
    });
    if (!response.ok) return response;
    return { ok: true, submitted: urlList.length };
  }

  async getQuota(siteUrl: string): Promise<BingQuotaResult> {
    if (!this.apiKey) {
      this.log("ℹ️ [bing] BING_WEBMASTER_API_KEY 없음 - 할당량 조회 건너뜀");
      return { skipped: "no-key" };
    }
    const response = await this.request(
      `/GetUrlSubmissionQuota?siteUrl=${encodeURIComponent(siteUrl)}&apikey=${encodeURIComponent(this.apiKey)}`,
      { method: "GET" }
    );
    if (!response.ok) return response;
    const quota = (response.json as { d?: { DailyQuota?: unknown; MonthlyQuota?: unknown } } | null)?.d;
    if (typeof quota?.DailyQuota !== "number" || typeof quota?.MonthlyQuota !== "number") {
      return { ok: false, error: "할당량 응답 형식이 예상과 다릅니다" };
    }
    return { ok: true, dailyQuota: quota.DailyQuota, monthlyQuota: quota.MonthlyQuota };
  }

  /** 던지지 않는다. 2xx면 파싱한 JSON을, 아니면 오류 객체를 돌려준다. 오류 문구에 키가 섞이지 않게 URL은 싣지 않는다. */
  private async request(
    path: string,
    init: { method: string; headers?: Record<string, string>; body?: string }
  ): Promise<{ ok: true; json: unknown } | { ok: false; error: string; status?: number }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(`${BING_API_BASE}${path}`, { ...init, signal: controller.signal });
      const text = await response.text().catch(() => "");
      if (!response.ok) {
        const message = (() => {
          try {
            return (JSON.parse(text) as { Message?: string }).Message;
          } catch {
            return undefined;
          }
        })();
        return { ok: false, status: response.status, error: `HTTP ${response.status}: ${(message ?? text).slice(0, 300) || "(본문 없음)"}` };
      }
      try {
        return { ok: true, json: text ? JSON.parse(text) : null };
      } catch {
        return { ok: true, json: null };
      }
    } catch (error) {
      return { ok: false, error: `네트워크 오류: ${describe(error)}` };
    } finally {
      clearTimeout(timer);
    }
  }
}
