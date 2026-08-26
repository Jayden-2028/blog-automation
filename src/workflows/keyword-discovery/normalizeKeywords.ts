import type {
  KeywordSource,
  NormalizedKeyword,
  RawKeyword,
} from "../../types/keywordDiscovery.js";

const DEFAULT_CATEGORY = "uncategorized";
const DEFAULT_TREND_SCORE = 0;

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeSource(source: RawKeyword["source"]): KeywordSource {
  const collapsed = collapseWhitespace(String(source ?? ""));
  return (collapsed || "unknown").toLowerCase();
}

// 공백 정리 / trim / 빈 키워드 제거 / source·category 표준화 / trend score 기본값 처리.
export function normalizeKeywords(
  rawKeywords: RawKeyword[]
): NormalizedKeyword[] {
  const normalized: NormalizedKeyword[] = [];

  for (const raw of rawKeywords) {
    const keyword = collapseWhitespace(raw.keyword ?? "");
    if (!keyword) continue;

    const category = collapseWhitespace(raw.category ?? "");
    const trendScore =
      typeof raw.trendScore === "number" && Number.isFinite(raw.trendScore)
        ? raw.trendScore
        : DEFAULT_TREND_SCORE;

    normalized.push({
      keyword,
      normalizedKey: keyword.toLowerCase(),
      category: (category || DEFAULT_CATEGORY).toLowerCase(),
      source: normalizeSource(raw.source),
      trendScore,
      sourceUrl: raw.sourceUrl ?? null,
      publishedAt: raw.publishedAt ?? null,
      metadata: raw.metadata ?? {},
    });
  }

  return normalized;
}
