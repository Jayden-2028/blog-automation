// 키워드 수집(discovery) 파이프라인 전용 타입.
// Supabase 테이블 타입(src/types/database.ts)과는 별개로,
// provider → normalize → deduplicate 단계를 거치는 중간 데이터 형태를 표현한다.

export const KEYWORD_SOURCES = [
  "mock",
  "naver",
  "naver_news",
  "naver_blog",
  "naver_web",
  "naver_trend",
  "google",
] as const;
export type KnownKeywordSource = (typeof KEYWORD_SOURCES)[number];
// 향후 추가될 provider를 위해 알려진 값 외의 문자열도 허용한다.
export type KeywordSource = KnownKeywordSource | (string & {});

// provider가 외부에서 그대로 가져온 원본 데이터.
export type RawKeyword = {
  keyword: string;
  category?: string;
  source: KeywordSource;
  trendScore?: number;
  sourceUrl?: string;
  publishedAt?: string;
  metadata?: Record<string, unknown>;
};

// normalizeKeywords()를 거쳐 정리된 데이터.
// normalizedKey는 대소문자/공백 차이를 무시한 중복 판정용 키.
export type NormalizedKeyword = {
  keyword: string;
  normalizedKey: string;
  category: string;
  source: KeywordSource;
  trendScore: number;
  sourceUrl: string | null;
  publishedAt: string | null;
  metadata: Record<string, unknown>;
};

// deduplicateKeywords()를 거쳐 DB 저장 후보가 된 데이터.
export type KeywordCandidate = {
  keyword: string;
  category: string;
  source: KeywordSource;
  trendScore: number;
  sourceUrl: string | null;
  publishedAt: string | null;
  metadata: Record<string, unknown>;
};
