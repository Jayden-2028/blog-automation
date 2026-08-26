// Supabase 테이블과 1:1로 매핑되는 타입 정의.
// 테이블 구조는 변경하지 않으며, 실제 컬럼(REST API OpenAPI 정의) 기준으로 작성됨.

export const KEYWORD_STATUSES = [
  "discovered",
  "selected",
  "researching",
  "writing",
  "review",
  "approved",
  "published",
  "rejected",
] as const;
export type KeywordStatus = (typeof KEYWORD_STATUSES)[number];

export const ARTICLE_STATUSES = [
  "draft",
  "writing",
  "review",
  "approved",
  "published",
  "failed",
] as const;
export type ArticleStatus = (typeof ARTICLE_STATUSES)[number];

export const PUBLICATION_STATUSES = [
  "pending",
  "publishing",
  "published",
  "failed",
] as const;
export type PublicationStatus = (typeof PUBLICATION_STATUSES)[number];

// ---------- keywords ----------

export type KeywordRow = {
  id: number;
  keyword: string;
  category: string | null;
  trend_score: number | null;
  source: string | null;
  status: KeywordStatus;
  created_at: string;
};

export type KeywordInsert = {
  keyword: string;
  category?: string | null;
  trend_score?: number | null;
  source?: string | null;
  status?: KeywordStatus;
};

export type KeywordUpdate = Partial<KeywordInsert>;

// ---------- sources ----------

export type SourceRow = {
  id: number;
  keyword_id: number;
  title: string | null;
  url: string | null;
  source_name: string | null;
  published_at: string | null;
  content: string | null;
  created_at: string;
};

export type SourceInsert = {
  keyword_id: number;
  title?: string | null;
  url?: string | null;
  source_name?: string | null;
  published_at?: string | null;
  content?: string | null;
};

export type SourceUpdate = Partial<SourceInsert>;

// ---------- articles ----------

export type ArticleRow = {
  id: number;
  keyword_id: number;
  title: string | null;
  content: string | null;
  status: ArticleStatus;
  ai_model: string | null;
  created_at: string;
  updated_at: string;
};

export type ArticleInsert = {
  keyword_id: number;
  title?: string | null;
  content?: string | null;
  status?: ArticleStatus;
  ai_model?: string | null;
};

export type ArticleUpdate = Partial<ArticleInsert>;

// ---------- publications ----------

export type PublicationRow = {
  id: number;
  article_id: number;
  platform: string | null;
  published_url: string | null;
  status: PublicationStatus;
  published_at: string | null;
  created_at: string;
};

export type PublicationInsert = {
  article_id: number;
  platform?: string | null;
  published_url?: string | null;
  status?: PublicationStatus;
  published_at?: string | null;
};

export type PublicationUpdate = Partial<PublicationInsert>;

// ---------- discovery_runs ----------
// keyword ranking 파이프라인(runKeywordRanking) 1회 실행 단위 메타데이터.
// supabase/migrations/20260824120000_keyword_ranking_history.sql 참고.

export const DISCOVERY_RUN_STATUSES = ["running", "completed", "failed"] as const;
export type DiscoveryRunStatus = (typeof DISCOVERY_RUN_STATUSES)[number];

export type DiscoveryRunRow = {
  id: number;
  started_at: string;
  completed_at: string | null;
  status: DiscoveryRunStatus;
  candidates_count: number;
  clusters_count: number;
  inserted_count: number;
  error_count: number;
  /** 이 run이 어느 데이터 소스 기반인지 (예: naver). 기본 'naver'. */
  source: string;
  /** 이 run에 사용된 seed 검색어 목록 (jsonb 배열). */
  seed_queries: string[] | null;
  /** 기타 실행 옵션/부가 정보 (예: displayPerQuery, trendRangeDays 등). jsonb. */
  metadata: Record<string, unknown> | null;
  created_at: string;
};

export type DiscoveryRunInsert = {
  started_at: string;
  completed_at?: string | null;
  status?: DiscoveryRunStatus;
  candidates_count?: number;
  clusters_count?: number;
  inserted_count?: number;
  error_count?: number;
  source?: string;
  seed_queries?: string[] | null;
  metadata?: Record<string, unknown> | null;
};

export type DiscoveryRunUpdate = Partial<DiscoveryRunInsert>;

// ---------- keyword_rankings ----------
// discovery_runs 1회 실행에서 산출된 keyword(cluster)별 랭킹 "스냅샷".
// keywords 테이블 등 다른 테이블의 현재 상태에 의존하지 않고, 랭킹 당시의 keyword/category/sources/
// score_breakdown/trend_direction/related_count/latest_published_at 값을 그대로 저장해
// 나중에도 랭킹 결과를 완전히 재현할 수 있게 한다.

// scoreKeyword()의 KeywordScoreBreakdown과 구조적으로 동일하지만, database.ts는 다른 모듈에
// 의존하지 않는다는 기존 관례를 유지하기 위해 독립적으로 정의한다.
export type KeywordRankingScoreBreakdownJson = {
  trendMomentum: number;
  newsVelocity: number;
  contentDemand: number;
  freshness: number;
  crossSourceSignal: number;
  clickPotential: number;
  total: number;
};

export type KeywordRankingRow = {
  id: number;
  run_id: number;
  /** keywords 테이블에 대응 row가 있는 경우에만 연결됨. ranking 단계는 keywords에 쓰지 않으므로 대부분 null. */
  keyword_id: number | null;
  keyword: string;
  /** 원본 대표 headline(뉴스/블로그 title). 20260825090000 migration 적용 전까지는 이 컬럼이 없다. */
  headline: string | null;
  /** trend 데이터를 조회하는 데 사용된 원래 seed 검색어. 위와 동일하게 migration 적용 전까지는 없다. */
  seed_query: string | null;
  category: string | null;
  rank: number;
  total_score: number;
  trend_score: number | null;
  news_score: number | null;
  content_score: number | null;
  freshness_score: number | null;
  cross_source_score: number | null;
  click_score: number | null;
  trend_direction: string | null;
  related_count: number | null;
  sources: string[] | null;
  score_breakdown: KeywordRankingScoreBreakdownJson | null;
  reason: string | null;
  latest_published_at: string | null;
  created_at: string;
};

export type KeywordRankingInsert = {
  run_id: number;
  keyword_id?: number | null;
  keyword: string;
  headline?: string | null;
  seed_query?: string | null;
  category?: string | null;
  rank: number;
  total_score: number;
  trend_score?: number | null;
  news_score?: number | null;
  content_score?: number | null;
  freshness_score?: number | null;
  cross_source_score?: number | null;
  click_score?: number | null;
  trend_direction?: string | null;
  related_count?: number | null;
  sources?: string[] | null;
  score_breakdown?: KeywordRankingScoreBreakdownJson | null;
  reason?: string | null;
  latest_published_at?: string | null;
};

export type KeywordRankingUpdate = Partial<KeywordRankingInsert>;

// ---------- seed_queries ----------
// keyword ranking 파이프라인이 사용하는 seed 검색어 목록.
// supabase/migrations/20260825120000_seed_queries.sql 참고.

export const SEED_QUERY_STATUSES = ["active", "paused", "archived"] as const;
export type SeedQueryStatus = (typeof SEED_QUERY_STATUSES)[number];

export type SeedQueryRow = {
  id: string;
  keyword: string;
  category: string;
  priority: number;
  status: SeedQueryStatus;
  source: string;
  created_at: string;
  updated_at: string;
};

export type SeedQueryInsert = {
  keyword: string;
  category: string;
  priority?: number;
  status?: SeedQueryStatus;
  source?: string;
};

export type SeedQueryUpdate = Partial<SeedQueryInsert> & {
  updated_at?: string;
};

// ---------- trend_candidates ----------
// NAVER Creator Advisor 트렌드 탭에서 수집한 동적 키워드 후보. daily query pool의 두 번째 입력원
// (seed_queries + trend_candidates). supabase/migrations/20260825150000_trend_candidates.sql 참고.

export const TREND_CANDIDATE_STATUSES = ["active", "expired", "archived"] as const;
export type TrendCandidateStatus = (typeof TREND_CANDIDATE_STATUSES)[number];

export const TREND_CANDIDATE_MOVEMENT_TYPES = ["new", "up", "down", "flat"] as const;
export type TrendCandidateMovementType = (typeof TREND_CANDIDATE_MOVEMENT_TYPES)[number];

export type TrendCandidateRow = {
  id: string;
  keyword: string;
  keyword_normalized: string;
  topic: string;
  topic_normalized: string;
  source: string;
  /** "YYYY-MM-DD". Creator Advisor가 표시하는 트렌드 기준일(수집 시각과 다를 수 있음). */
  trend_date: string;
  rank: number;
  movement_type: TrendCandidateMovementType;
  rank_change: number | null;
  candidate_score: number | null;
  collected_at: string;
  expires_at: string | null;
  status: TrendCandidateStatus;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type TrendCandidateInsert = {
  keyword: string;
  keyword_normalized: string;
  topic: string;
  topic_normalized: string;
  source?: string;
  trend_date: string;
  rank: number;
  movement_type: TrendCandidateMovementType;
  rank_change?: number | null;
  candidate_score?: number | null;
  collected_at?: string;
  expires_at?: string | null;
  status?: TrendCandidateStatus;
  metadata?: Record<string, unknown>;
};

export type TrendCandidateUpdate = Partial<TrendCandidateInsert> & {
  updated_at?: string;
};

// ---------- Supabase client generic ----------

export type Database = {
  public: {
    Tables: {
      keywords: {
        Row: KeywordRow;
        Insert: KeywordInsert;
        Update: KeywordUpdate;
        Relationships: [];
      };
      sources: {
        Row: SourceRow;
        Insert: SourceInsert;
        Update: SourceUpdate;
        Relationships: [];
      };
      articles: {
        Row: ArticleRow;
        Insert: ArticleInsert;
        Update: ArticleUpdate;
        Relationships: [];
      };
      publications: {
        Row: PublicationRow;
        Insert: PublicationInsert;
        Update: PublicationUpdate;
        Relationships: [];
      };
      discovery_runs: {
        Row: DiscoveryRunRow;
        Insert: DiscoveryRunInsert;
        Update: DiscoveryRunUpdate;
        Relationships: [];
      };
      keyword_rankings: {
        Row: KeywordRankingRow;
        Insert: KeywordRankingInsert;
        Update: KeywordRankingUpdate;
        Relationships: [];
      };
      seed_queries: {
        Row: SeedQueryRow;
        Insert: SeedQueryInsert;
        Update: SeedQueryUpdate;
        Relationships: [];
      };
      trend_candidates: {
        Row: TrendCandidateRow;
        Insert: TrendCandidateInsert;
        Update: TrendCandidateUpdate;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
  };
};
