// 구글 영문 자동완성 제안 조회(사용설명서 트랙 주제 수집, 개편3 §4.2).
//
// 인증이 없는 공개 제안 엔드포인트(suggestqueries.google.com, client=firefox -> JSON)다. User-Agent를
// 위장하지 않고(스크래핑 원칙 - GoogleTrendsProvider와 같다), 호출 측이 요청 간격을 둬서 부드럽게 쓴다.
// 실패는 예외로 던지고 비치명적 처리는 호출자가 한다(시드 하나가 죽어도 나머지는 돌아야 한다).

export const AUTOCOMPLETE_URL = "https://suggestqueries.google.com/complete/search";

export type FetchAutocompleteOptions = {
  /** 언어. 기본 en. */
  hl?: string;
  /** 국가(검색 수요 지역). 기본 us - 해외 독자 기준이다. */
  gl?: string;
  timeoutMs?: number;
  /** 테스트 주입: 네트워크 대신 JSON 본문을 돌려준다. */
  fetchJson?: (url: string) => Promise<unknown>;
};

export function buildAutocompleteUrl(query: string, options: Pick<FetchAutocompleteOptions, "hl" | "gl"> = {}): string {
  const params = new URLSearchParams({
    client: "firefox",
    hl: options.hl ?? "en",
    gl: options.gl ?? "us",
    q: query,
  });
  return `${AUTOCOMPLETE_URL}?${params.toString()}`;
}

/** `["query", ["s1","s2",...]]` 형식에서 제안 문자열만 뽑는다. 모양이 다르면 빈 배열(예외 아님). */
export function parseAutocompleteResponse(body: unknown): string[] {
  if (!Array.isArray(body) || !Array.isArray(body[1])) return [];
  return body[1].filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}

async function defaultFetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`Google Autocomplete 요청 실패: ${response.status} ${response.statusText}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/** 순서를 유지한 제안 목록(앞일수록 수요가 큰 질의). */
export async function fetchAutocompleteSuggestions(query: string, options: FetchAutocompleteOptions = {}): Promise<string[]> {
  const url = buildAutocompleteUrl(query, options);
  const fetchJson = options.fetchJson ?? ((u: string) => defaultFetchJson(u, options.timeoutMs ?? 10_000));
  return parseAutocompleteResponse(await fetchJson(url));
}
