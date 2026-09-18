// 헤드라인에서 "경쟁도를 조회할 주제구"를 LLM으로 뽑는다. run당 헤드리스 호출 1회.
//
// 왜 규칙 기반을 포기했나(2026-09-04 실측):
// buildCompetitionQuery()는 범용어를 걷어낸 뒤 "앞에서부터 핵심 명사 2개"를 골랐다. 실제 Top 18에
// 적용해보니 절반이 무너졌다.
//   "내 딸은 죽었는데 부산 오피스텔 추락사 유족"      -> [딸은 죽었는데]   2,562,535건
//   "가해자 누나는 드라마 출연 중 부산 오피스텔 추락사" -> [가해자 누나는]      27,157건
// 같은 사건인데 94배다(축약 전 원문 조회 17배보다 오히려 나빠졌다). "한국 문화 행사에 일본 유카타
// 입고 등장했다 안셀"은 [한국 문화]가 되어 1,450만 건이 나왔다 - 주제가 아니라 아무 문서에나
// 들어있는 일반어를 센 것이다.
//
// 원인은 한국어가 head-final이라 핵심 명사가 문장 끝에 오는 경우가 많다는 것이다
// ("...부산 오피스텔 추락사", "...등장했다 안셀"). 그렇다고 "뒤에서 2개"로 뒤집어도
// "2026 여의도 불꽃축제 일정·시간·명당·교통통제"처럼 뒤가 부속 정보인 헤드라인이 깨진다.
// 앞이 맞는 것과 뒤가 맞는 것이 섞여 있어 **위치 기반 규칙으로는 원리적으로 풀리지 않는다.**
//
// 그래서 LLM에 맡긴다. 비용은 run당 1회(약 25초)이고, 실패하면 규칙 기반 결과로 조용히 폴백한다 -
// 경쟁도는 보조 신호이므로 이 단계가 파이프라인을 멈추면 안 된다.

import { runHeadlessClaude } from "../../services/llm/runHeadlessClaude.js";
import { buildCompetitionQuery } from "./buildCompetitionQuery.js";

/**
 * 헤드라인 요약은 짧은 작업이다. 제목 생성(90초)보다 항목이 많아 넉넉하게 잡는다.
 * 2026-09-18에 프로브 창이 30 → 60건으로 넓어져(keywordCompetition.ts) 한 번에 처리할 항목이
 * 두 배가 됐으므로 여유를 더 둔다. 실패하면 규칙 기반 폴백이 있어 파이프라인은 멈추지 않는다.
 */
const TOPIC_EXTRACTION_TIMEOUT_MS = 180_000;

/** 주제구가 이보다 길면 모델이 문장을 그대로 돌려준 것으로 보고 버린다(어절 기준). */
const MAX_TOPIC_WORDS = 5;

export type TopicQueryInput = {
  /** cluster 대표 keyword(canonical). 폴백 계산과 결과 매핑의 키가 된다. */
  keyword: string;
  /** 원문 헤드라인. 있으면 이쪽이 맥락이 풍부해 추출 품질이 높다. */
  headline?: string | null;
};

export type TopicQueryResult = {
  keyword: string;
  /** 실제로 블로그 검색에 쓸 질의. */
  query: string;
  /** 이 질의가 어디서 왔는지. 실측 로그에서 LLM 품질을 판단하려면 구분이 필요하다. */
  source: "llm" | "fallback";
};

export type ExtractTopicQueriesResult = {
  status: "success" | "partial" | "fallback";
  queries: TopicQueryResult[];
  /** LLM 호출 자체가 실패했으면 그 사유. 폴백으로 진행했다는 뜻이지 파이프라인 실패가 아니다. */
  error?: string;
  durationMs: number;
};

export function buildTopicExtractionPrompt(inputs: readonly TopicQueryInput[]): string {
  const numbered = inputs
    .map((input, index) => `${index + 1}. ${input.headline?.trim() || input.keyword.trim()}`)
    .join("\n");

  // 출력 형식을 강하게 고정한다 - 파서가 읽는 출력이지 사람이 읽는 게 아니다.
  // 번호를 붙이게 하는 이유: 줄 순서만으로 맞추면 모델이 한 줄을 빠뜨렸을 때 그 뒤가 전부
  // 밀려서 엉뚱한 키워드에 엉뚱한 주제가 붙는다. 번호가 있으면 빠진 항목만 폴백된다.
  return [
    "너는 한국어 뉴스 헤드라인에서 '검색용 주제어'를 뽑는 도구다.",
    "",
    "아래 헤드라인 각각에 대해, 그 글이 다루는 **핵심 주제**를 검색어 형태로 뽑아라.",
    "이 주제어는 네이버 블로그 검색에 넣어 '이 주제로 이미 글이 얼마나 있는지' 세는 데 쓰인다.",
    "",
    numbered,
    "",
    "규칙:",
    "- 한 줄에 하나씩, `번호|주제어` 형식으로만 출력한다. 예: `1|부산 오피스텔 추락사`",
    "- 입력과 같은 번호를 붙인다. 순서를 바꾸거나 항목을 빠뜨리지 않는다.",
    `- 주제어는 2~${MAX_TOPIC_WORDS}어절. 문장이 아니라 명사구로 쓴다.`,
    "- 그 사건/작품/제도를 특정하는 고유명사를 반드시 포함한다(인명·지명·작품명·기관명·제도명).",
    "- 인용구나 수식절을 주제어로 삼지 않는다. 예: '내 딸은 죽었는데' (X) -> '부산 오피스텔 추락사' (O)",
    "- '한국 문화', '최근 이슈'처럼 아무 글에나 해당하는 일반어만으로 만들지 않는다.",
    "- 조사(은/는/이/가/을/를)를 붙이지 않는다. '누나는' (X) -> '누나' (O)",
    "- 설명, 머리말, 마무리 문장, 빈 줄을 붙이지 않는다.",
  ].join("\n");
}

/**
 * `번호|주제어` 줄을 파싱해 index -> 주제어 맵을 만든다.
 * 형식을 어긴 줄, 범위 밖 번호, 너무 긴 주제어는 조용히 버린다 - 호출자가 폴백한다.
 */
export function parseTopicQueryOutput(output: string, expectedCount: number): Map<number, string> {
  const byIndex = new Map<number, string>();

  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    // "1|주제" / "1. |주제" / "1 | 주제" 등 흔한 변형을 함께 받는다.
    const match = /^(\d+)\s*[.)]?\s*\|\s*(.+)$/.exec(line);
    if (!match) continue;

    const index = Number.parseInt(match[1], 10);
    if (!Number.isInteger(index) || index < 1 || index > expectedCount) continue;
    if (byIndex.has(index)) continue; // 중복 번호는 첫 줄만 채택

    const topic = match[2]
      .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();

    if (!topic) continue;
    if (topic.split(" ").length > MAX_TOPIC_WORDS) continue; // 문장을 돌려준 경우

    byIndex.set(index, topic);
  }

  return byIndex;
}

/**
 * 헤드라인들에서 경쟁도 조회용 주제구를 뽑는다.
 * **예외를 던지지 않는다.** LLM이 실패하거나 일부 항목을 빠뜨리면 그 항목만 규칙 기반으로 폴백한다.
 */
export async function extractTopicQueries(
  inputs: readonly TopicQueryInput[]
): Promise<ExtractTopicQueriesResult> {
  const startedAt = Date.now();

  const fallbackAll = (error?: string): ExtractTopicQueriesResult => ({
    status: "fallback",
    queries: inputs.map((input) => ({
      keyword: input.keyword,
      query: buildCompetitionQuery(input.headline?.trim() || input.keyword),
      source: "fallback" as const,
    })),
    error,
    durationMs: Date.now() - startedAt,
  });

  if (inputs.length === 0) {
    return { status: "success", queries: [], durationMs: Date.now() - startedAt };
  }

  const result = await runHeadlessClaude({
    prompt: buildTopicExtractionPrompt(inputs),
    timeoutMs: TOPIC_EXTRACTION_TIMEOUT_MS,
  });

  if (!result.ok) {
    console.error("⚠️ 주제어 추출 실패(규칙 기반으로 폴백) -", result.error);
    return fallbackAll(result.error);
  }

  const byIndex = parseTopicQueryOutput(result.output, inputs.length);
  if (byIndex.size === 0) {
    console.error("⚠️ 주제어 추출 출력에서 아무것도 파싱하지 못했습니다(규칙 기반으로 폴백).");
    return fallbackAll("출력 파싱 실패");
  }

  const queries: TopicQueryResult[] = inputs.map((input, i) => {
    const topic = byIndex.get(i + 1);
    return topic
      ? { keyword: input.keyword, query: topic, source: "llm" as const }
      : {
          keyword: input.keyword,
          query: buildCompetitionQuery(input.headline?.trim() || input.keyword),
          source: "fallback" as const,
        };
  });

  const fallbackCount = queries.filter((q) => q.source === "fallback").length;

  return {
    status: fallbackCount === 0 ? "success" : "partial",
    queries,
    error: fallbackCount > 0 ? `${fallbackCount}건은 규칙 기반으로 폴백` : undefined,
    durationMs: Date.now() - startedAt,
  };
}
