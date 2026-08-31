// 커뮤니티 인기글 제목 -> 검색 가능한 키워드 변환(LLM 1콜).
//
// 왜 다른 소스와 다른가(KEYWORD_SOURCE_EXPANSION.md §5-1): Creator Advisor/구글 트렌드는 이미
// "검색 키워드" 형태로 온다. 커뮤니티 인기글 제목은 "ㅋㅋㅋ 이거 실화냐" 같은 반응형 문장이라
// 그대로 NAVER 검색에 넣으면 아무것도 못 찾는다. 규칙 기반 형태소 분석으로는 밈·축약어를 못 잡으므로
// (§5-1), 하루 1회 LLM 호출로 (a) 검색 가능한 고유명사/이슈명 (b) 블로그 소재 적합 여부
// (c) category를 한 번에 뽑는다.
//
// clustering에는 LLM을 안 쓰면서 여기엔 쓰는 이유(§5-1): clustering은 이미 동작하는 규칙 기반
// 경로가 있다. 제목 -> 키워드는 규칙 기반 경로가 아예 없다.

import { runHeadlessClaude, type RunHeadlessClaudeResult } from "../../services/llm/runHeadlessClaude.js";
import { KEYWORD_CATEGORY_RULES, type KeywordCategory } from "../../config/keywordCategoryRules.js";

const VALID_CATEGORIES = new Set<string>(KEYWORD_CATEGORY_RULES.map((rule) => rule.category));

function isKeywordCategory(value: string): value is KeywordCategory {
  return VALID_CATEGORIES.has(value);
}

/** 추출 대상 1건 = 어느 사이트의 몇 번째 인기글인지 + 원제목. */
export type CommunityPostInput = {
  site: string;
  title: string;
  siteRank: number;
};

/** LLM이 뽑아낸 결과 1건. index는 입력 배열의 0-based 위치(원본 title/site로 되짚기 위함). */
export type ExtractedCommunityItem = {
  index: number;
  keyword: string;
  /** LLM이 유효한 category를 안 주거나 못 알아들으면 null - 호출자가 폴백 판정한다. */
  category: KeywordCategory | null;
};

/** 헤드리스 호출 1회 타임아웃. 제목 생성(90초)보다 입력이 크므로(40~60건) 넉넉히 잡는다. */
export const EXTRACTION_TIMEOUT_MS = 180_000;

const CATEGORY_LABELS: readonly KeywordCategory[] = KEYWORD_CATEGORY_RULES.map((rule) => rule.category);

export function buildExtractionPrompt(posts: readonly CommunityPostInput[]): string {
  const list = posts
    .map((post, i) => `${i}. [${post.site}] ${post.title}`)
    .join("\n");

  // 출력 형식을 강하게 고정한다(generateTitleSuggestions.ts와 같은 이유) - 이 출력은 사람이 아니라
  // parseExtractionOutput이 읽는다. 설명이나 머리말이 섞이면 파싱이 깨진다.
  return [
    "너는 한국 인터넷 커뮤니티 인기글 제목에서 블로그 소재를 골라내는 편집자다.",
    "",
    "아래는 오늘 여러 커뮤니티의 인기글 제목 목록이다(번호. [사이트] 제목).",
    "",
    list,
    "",
    "각 항목을 보고, 다음 조건을 모두 만족하는 것만 골라라:",
    "- 구체적인 고유명사/이슈명이 있어 검색 가능하다 (예: 특정 인물, 작품, 사건, 정책, 브랜드)",
    "- 단순 잡담·반응·감상('ㅋㅋㅋ', '실화냐', '오늘 기분')뿐이라 검색해도 원본 이슈를 못 찾는 것은 제외한다",
    "- 욕설/혐오/선정적 표현이 제목의 핵심인 것은 제외한다",
    "",
    "고른 항목마다 한 줄씩, 정확히 이 형식으로 출력해라:",
    "번호|키워드|category",
    "",
    "규칙:",
    "- 번호는 입력 목록의 번호를 그대로 쓴다(0부터 시작)",
    "- 키워드는 그 제목이 다루는 핵심 검색어만 5~15자 내외로 적는다(제목을 그대로 베끼지 않는다)",
    `- category는 반드시 다음 중 하나다: ${CATEGORY_LABELS.join(", ")}`,
    "- category를 모르겠으면 category 칸을 비워두되 구분자 |는 그대로 둔다(번호|키워드|)",
    "- 골라낼 항목이 없으면 아무것도 출력하지 않는다",
    "- 번호|키워드|category 형식이 아닌 줄, 설명, 머리말, 마무리 문장을 절대 출력하지 않는다",
  ].join("\n");
}

/**
 * LLM 출력 -> ExtractedCommunityItem[]. 형식을 어긴 줄은 조용히 버린다(예외를 던지지 않는다) -
 * 모델이 규칙을 어기는 것은 흔한 일이고, 한 줄이 깨졌다고 나머지 결과까지 버릴 이유가 없다.
 */
export function parseExtractionOutput(output: string, inputCount: number): ExtractedCommunityItem[] {
  const items: ExtractedCommunityItem[] = [];
  const seenIndex = new Set<number>();

  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    const parts = line.split("|");
    if (parts.length < 2) continue;

    const index = Number.parseInt(parts[0].trim(), 10);
    if (!Number.isInteger(index) || index < 0 || index >= inputCount || seenIndex.has(index)) continue;

    const keyword = parts[1]
      .trim()
      .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
      .trim();
    if (!keyword) continue;

    const rawCategory = (parts[2] ?? "").trim().toLowerCase();
    const category = isKeywordCategory(rawCategory) ? rawCategory : null;

    seenIndex.add(index);
    items.push({ index, keyword, category });
  }

  return items;
}

export type ExtractCommunityKeywordsOptions = {
  /** 테스트에서 실제 claude 서브프로세스 대신 결과를 주입하는 지점. */
  runHeadless?: (prompt: string) => Promise<RunHeadlessClaudeResult>;
};

export type ExtractCommunityKeywordsResult = {
  items: ExtractedCommunityItem[];
  /** LLM 호출 자체가 실패했을 때만 채워진다. items는 이 경우 항상 빈 배열. */
  error?: string;
};

/**
 * 절대 throw하지 않는다(runHeadlessClaude/generateTitleSuggestions와 같은 계약) - 추출 실패가
 * daily job 전체를 죽이면 안 된다. posts가 비어 있으면 LLM을 호출하지 않고 즉시 빈 결과를 반환한다
 * (하루 1콜이라는 비용 근거를 지키려면 수집된 글이 0건일 때까지 콜을 쓸 이유가 없다).
 */
export async function extractCommunityKeywords(
  posts: readonly CommunityPostInput[],
  options: ExtractCommunityKeywordsOptions = {}
): Promise<ExtractCommunityKeywordsResult> {
  if (posts.length === 0) return { items: [] };

  const runHeadless =
    options.runHeadless ??
    ((prompt: string) => runHeadlessClaude({ prompt, timeoutMs: EXTRACTION_TIMEOUT_MS }));

  const result = await runHeadless(buildExtractionPrompt(posts));

  if (!result.ok) {
    console.error("⚠️ [extractCommunityKeywords] LLM 추출 실패 -", result.error);
    return { items: [], error: result.error };
  }

  return { items: parseExtractionOutput(result.output, posts.length) };
}
