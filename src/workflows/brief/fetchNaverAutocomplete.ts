// 네이버 자동완성으로 "사람들이 이 키워드 뒤에 뭘 붙여 검색하는가"를 모은다(2026-09-17).
//
// 왜 필요한가(기획 품질 딥다이브): 원고가 독자 의도와 어긋나는 첫 원인은 **의도 입력이 비어 있다**는
// 것이었다. researcher.md §5는 독자 질문을 지식iN·카페 원문으로만 정의하는데, 화제가 된 지 며칠 안
// 된 키워드엔 그런 글이 없다(분장놀이·이재시 둘 다 "찾지 못함"). 자동완성은 그 순간 실제로 검색되고
// 있는 조합을 돌려준다 - "국중박 분장놀이 결선 / 상금 / 1등 / 대구·전주·공주·춘천"처럼 사람들이
// 뭘 알고 싶은지가 그대로 보인다(실측).
//
// 비공식 엔드포인트다(사용자 결정, 2026-09-17). 공식 연관검색어 API는 없고 검색광고 API는 광고
// 계정이 필요하다. 예고 없이 막힐 수 있으므로 **실패해도 빈 배열**을 돌려주고 브리프는 baseline
// 제목만으로 진행한다 - 이 단계가 원고 생성을 막아서는 안 된다.
//
// job.keyword는 대개 기사 제목을 다듬은 긴 문장("사람이 유물로 변신 국중박 분장놀이 본선행 25팀
// 공개")이라 그대로 넣으면 자동완성이 비어 나온다. 그래서 seed_query·전체 키워드·2어절 창을 여러
// 개 던지고 합친다. 핵심 개체가 무엇인지는 Node가 모른다 - 여러 창을 던져 걸리는 것을 쓴다.

const ENDPOINT = "https://ac.search.naver.com/nx/ac";
const TIMEOUT_MS = 4000;
/** 요청 수 상한. 2어절 창이 많은 긴 키워드에서 폭주하지 않게 자른다. */
const MAX_QUERIES = 10;
const MAX_SUGGESTIONS = 40;

export type AutocompleteGroup = { query: string; suggestions: string[] };

export type FetchAutocomplete = (query: string) => Promise<string[]>;

/** 키워드에서 자동완성에 던질 질의들을 만든다. 순서가 우선순위다(앞에서부터 MAX_QUERIES개). */
export function buildAutocompleteQueries(keyword: string, seedQuery: string | null): string[] {
  const tokens = keyword
    .replace(/[·｜|?!,.'"…()\[\]【】]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);

  const out: string[] = [];
  const push = (q: string) => {
    const trimmed = q.trim();
    if (trimmed.length >= 2 && !out.includes(trimmed)) out.push(trimmed);
  };

  if (seedQuery) push(seedQuery);
  push(keyword);
  for (let i = 0; i + 1 < tokens.length; i += 1) push(`${tokens[i]} ${tokens[i + 1]}`);
  // 단일 어절은 키워드 자체가 짧을 때만 던진다("이재시"). 긴 제목형 키워드에서 "사람이" 같은 어절을
  // 따로 던지면 무관한 조합 9개가 딸려 온다(실측) - 2어절 창이 이미 핵심 개체를 잡는다.
  if (tokens.length <= 2) for (const token of tokens) if (token.length >= 3) push(token);

  return out.slice(0, MAX_QUERIES);
}

export async function fetchNaverAutocomplete(query: string): Promise<string[]> {
  const params = new URLSearchParams({
    q: query,
    st: "100",
    frm: "nv",
    r_format: "json",
    r_enc: "UTF-8",
    r_unicode: "0",
    t_koreng: "1",
    q_enc: "UTF-8",
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${ENDPOINT}?${params.toString()}`, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) return [];
    const data = (await response.json()) as { items?: unknown };
    // 응답 형태: { items: [ [ ["국중박 분장놀이 결선"], ["..."] ] ] } - 바깥 배열은 섹션, 안쪽은 [문구] 배열.
    if (!Array.isArray(data.items)) return [];
    const out: string[] = [];
    for (const section of data.items) {
      if (!Array.isArray(section)) continue;
      for (const entry of section) {
        const text = Array.isArray(entry) ? entry[0] : entry;
        if (typeof text === "string" && text.trim()) out.push(text.trim());
      }
    }
    return out;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 키워드와 한 글자도 안 겹치는 자동완성은 버린다(2026-09-22).
 *
 * 왜: "낼 모레 50인데 너무 예뻐서 20대로 오해받는 여배우"를 던졌더니 `배우 김혜숙 별세`,
 * `내일배움카드`, `나라배움터`가 돌아왔다 - "배우"·"배움" 두 글자만 걸린 결과다. 이런 것이
 * 브리프 프롬프트에 "사람들이 실제로 붙여 검색하는 조합"이라고 실리면 기획을 엉뚱한 데로 끈다.
 *
 * 판정은 느슨하게 둔다 - 키워드의 2글자 이상 토큰이 하나라도 들어 있으면 남긴다. 자동완성은
 * 원래 키워드를 확장한 말이라 보통 겹치고, 안 겹치면 다른 주제로 샌 것이다.
 */
export function relevantSuggestions(keyword: string, suggestions: readonly string[]): string[] {
  const tokenize = (text: string): string[] =>
    text
      .replace(/[^0-9A-Za-z가-힣]+/g, " ")
      .split(/\s+/)
      .filter((token) => token.length >= 2);

  const keywordTokens = tokenize(keyword);
  if (keywordTokens.length === 0) return [...suggestions];

  // 토큰끼리 접두 일치로 본다. 한국어는 조사가 붙어 글자열이 달라지므로(키워드는 "20대로",
  // 자동완성은 "20대") 정확 일치로 재면 멀쩡한 제안까지 버린다 - alignImagePrompts와 같은 판단이다.
  return suggestions.filter((suggestion) =>
    tokenize(suggestion).some((word) =>
      keywordTokens.some((token) => word === token || word.startsWith(token) || token.startsWith(word))
    )
  );
}

/**
 * 여러 질의를 던져 그룹별로 모은다. 질의 자체와 같은 문구는 뺀다(정보가 없다).
 * 실패한 질의는 빈 그룹으로 남기지 않고 버린다 - 프롬프트에 "없음"을 나열할 이유가 없다.
 */
export async function collectAutocomplete(
  keyword: string,
  seedQuery: string | null,
  fetcher: FetchAutocomplete = fetchNaverAutocomplete
): Promise<AutocompleteGroup[]> {
  const queries = buildAutocompleteQueries(keyword, seedQuery);
  const results = await Promise.all(queries.map(async (query) => ({ query, suggestions: await fetcher(query) })));

  const seen = new Set<string>();
  const groups: AutocompleteGroup[] = [];
  let total = 0;
  for (const { query, suggestions } of results) {
    const relevant = relevantSuggestions(keyword, suggestions);
    const fresh = relevant.filter((s) => s !== query && !seen.has(s));
    if (fresh.length === 0) continue;
    const kept = fresh.slice(0, Math.max(0, MAX_SUGGESTIONS - total));
    if (kept.length === 0) break;
    kept.forEach((s) => seen.add(s));
    total += kept.length;
    groups.push({ query, suggestions: kept });
  }
  return groups;
}
