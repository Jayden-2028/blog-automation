// NAVER API HUB(https://naverapihub.apigw.ntruss.com) 공통 HTTP/인증 모듈.
// NAVER Cloud Platform의 API Gateway(NCP APIGW) 인증 방식을 사용하며,
// 구형 NAVER Developers Open API(openapi.naver.com, X-Naver-Client-Id 헤더 방식)와는 다르다.
// 뉴스/블로그/웹문서 검색, 검색어트렌드 등 모든 Naver API 호출이 이 모듈을 거친다.
// credential(NAVER_CLIENT_ID / NAVER_CLIENT_SECRET)은 절대 로그로 출력하지 않는다.

// NAVER API HUB 공식 base URL. 모든 provider가 이 상수를 기준으로 endpoint 경로를 구성한다.
export const NAVER_API_HUB_BASE_URL = "https://naverapihub.apigw.ntruss.com";

export type NaverCredentials = {
  clientId: string;
  clientSecret: string;
};

export function getNaverCredentials(): NaverCredentials {
  const clientId = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      "Missing NAVER_CLIENT_ID or NAVER_CLIENT_SECRET. Copy .env.example to .env and fill in your Naver API HUB credentials."
    );
  }

  return { clientId, clientSecret };
}

// NAVER API HUB(NCP APIGW) 인증 헤더. 구형 X-Naver-Client-Id/Secret 헤더는 사용하지 않는다.
function buildNaverHeaders(
  credentials: NaverCredentials,
  extra?: Record<string, string>
): Record<string, string> {
  return {
    "X-NCP-APIGW-API-KEY-ID": credentials.clientId,
    "X-NCP-APIGW-API-KEY": credentials.clientSecret,
    ...extra,
  };
}

// 응답 본문에는 credential이 포함되지 않지만, 안전을 위해 에러 메시지에는 상태 코드/경로만 남긴다.
async function handleNaverResponse<T>(response: Response, path: string): Promise<T> {
  if (!response.ok) {
    // Naver 오류 응답은 보통 { errorMessage, errorCode } JSON을 포함한다. 진단을 돕기 위해 본문을 함께 남기되,
    // credential 값은 응답 본문에 포함되지 않으므로 그대로 노출해도 안전하다.
    const bodyText = await response.text().catch(() => "");
    throw new Error(
      `Naver API request failed: ${response.status} ${response.statusText} (${path})${
        bodyText ? ` - ${bodyText}` : ""
      }`
    );
  }
  return (await response.json()) as T;
}

export type NaverGetJsonOptions = {
  params?: Record<string, string | number | undefined>;
};

// 뉴스/블로그/웹문서 검색 등 GET + query string 기반 API 호출용 wrapper.
export async function naverGetJson<T>(
  url: string,
  options: NaverGetJsonOptions = {}
): Promise<T> {
  const credentials = getNaverCredentials();
  const target = new URL(url);

  for (const [key, value] of Object.entries(options.params ?? {})) {
    if (value === undefined) continue;
    target.searchParams.set(key, String(value));
  }

  const response = await fetch(target, {
    method: "GET",
    headers: buildNaverHeaders(credentials),
  });

  return handleNaverResponse<T>(response, target.pathname);
}

// 검색어트렌드(DataLab) 등 POST + JSON body 기반 API 호출용 wrapper.
export async function naverPostJson<T>(url: string, body: unknown): Promise<T> {
  const credentials = getNaverCredentials();

  const response = await fetch(url, {
    method: "POST",
    headers: buildNaverHeaders(credentials, { "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });

  return handleNaverResponse<T>(response, new URL(url).pathname);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Naver 검색 API는 매칭된 검색어를 <b>...</b>로 감싸고 일부 문자를 HTML entity로 반환한다.
export function stripNaverMarkup(text: string): string {
  const withoutTags = text.replace(/<\/?b>/gi, "");
  return withoutTags
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

// 뉴스 검색 pubDate (RFC 822 형식, 예: "Mon, 26 Sep 2016 07:50:00 +0900")를 ISO 문자열로 변환.
export function parseRfc822Date(pubDate: string): string | undefined {
  const parsed = new Date(pubDate);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

// 블로그 검색 postdate (yyyyMMdd 형식, 예: "20241231")를 ISO 문자열로 변환.
export function parseCompactDate(compactDate: string): string | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(compactDate);
  if (!match) return undefined;

  const [, year, month, day] = match;
  const parsed = new Date(`${year}-${month}-${day}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}
