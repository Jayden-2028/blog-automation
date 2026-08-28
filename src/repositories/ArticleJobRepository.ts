// Telegram에서 선택된 키워드 = 원고 job(article_jobs 테이블) repository.
// SeedQueryRepository / TrendCandidateRepository와 같은 위치·스타일을 따른다.
//
// DB 접근은 이 파일 안에만 둔다. "어떤 ranking을 job으로 만들지"를 고르는 판단은 호출자
// (TelegramBot의 callback 핸들러)가 하고, 이 repository는 주어진 값을 저장/조회/상태 전이만 한다.

import { supabase } from "../services/supabase/client.js";
import type {
  ArticleJobInsert,
  ArticleJobRow,
  ArticleJobStatus,
  KeywordRankingRow,
} from "../types/database.js";

/** PostgreSQL unique_violation. upsert 대신 insert를 쓰고 이 코드로 "이미 있음"을 판별한다. */
const UNIQUE_VIOLATION = "23505";

export type CreateArticleJobResult = {
  job: ArticleJobRow;
  /**
   * false면 이미 있던 job을 그대로 반환한 것이다(같은 버튼을 두 번 눌렀을 때).
   * 호출자는 이 값으로 "제목 생성 같은 비싼 후속 작업을 할지"를 판단한다.
   */
  created: boolean;
};

export class ArticleJobRepository {
  /**
   * keyword_rankings row 하나를 job으로 만든다. 선택 시점의 값을 복사해 보관하므로
   * 나중에 keyword_rankings가 정리돼도 job만으로 원고를 만들 수 있다.
   *
   * 멱등하다: 같은 (source_run_id, source_rank)로 두 번 호출하면 두 번째는 새로 만들지 않고
   * 기존 job을 `created: false`와 함께 돌려준다. Telegram 버튼은 중복 클릭이 흔하고, 폴링
   * 방식에서는 같은 update를 재처리할 가능성도 있어서 이 성질이 필수다.
   */
  static async createFromRanking(
    ranking: KeywordRankingRow,
    options: {
      selectedVia?: ArticleJobInsert["selected_via"];
      metadata?: Record<string, unknown>;
      /** 기본 'selected'. Pass 버튼은 'rejected'로 만들어 거부 이력을 남긴다. */
      status?: ArticleJobStatus;
    } = {}
  ): Promise<CreateArticleJobResult> {
    const row: ArticleJobInsert = {
      source_run_id: ranking.run_id,
      source_rank: ranking.rank,
      keyword: ranking.keyword,
      headline: ranking.headline,
      seed_query: ranking.seed_query,
      category: ranking.category,
      total_score: ranking.total_score,
      score_breakdown: ranking.score_breakdown,
      status: options.status ?? "selected",
      selected_via: options.selectedVia ?? "telegram",
      metadata: options.metadata ?? {},
    };

    const { data, error } = await supabase.from("article_jobs").insert(row).select().single();

    if (!error && data) return { job: data, created: true };

    // upsert(onConflict)를 쓰지 않는 이유: upsert는 기존 row를 덮어써서 selected_at과 그동안 진행된
    // status를 되돌려 버린다. 이미 writing 단계인 job이 버튼 재클릭으로 selected로 리셋되면 안 된다.
    if (error?.code === UNIQUE_VIOLATION) {
      const existing = await this.findByRunAndRank(ranking.run_id, ranking.rank);
      if (existing) return { job: existing, created: false };
    }

    throw error ?? new Error("article_jobs insert가 row를 반환하지 않았습니다.");
  }

  static async findByRunAndRank(runId: number, rank: number): Promise<ArticleJobRow | null> {
    const { data, error } = await supabase
      .from("article_jobs")
      .select("*")
      .eq("source_run_id", runId)
      .eq("source_rank", rank)
      .maybeSingle();

    if (error) throw error;
    return data ?? null;
  }

  static async findById(id: string): Promise<ArticleJobRow | null> {
    const { data, error } = await supabase.from("article_jobs").select("*").eq("id", id).maybeSingle();

    if (error) throw error;
    return data ?? null;
  }

  /** 특정 status의 job을 오래된 선택 순으로 반환한다. 다음 단계 워커(조사/집필)가 쓴다. */
  static async listByStatus(status: ArticleJobStatus, limit = 20): Promise<ArticleJobRow[]> {
    const { data, error } = await supabase
      .from("article_jobs")
      .select("*")
      .eq("status", status)
      .order("selected_at", { ascending: true })
      .limit(limit);

    if (error) throw error;
    return data ?? [];
  }

  /** 특정 run에서 이미 선택된 job 목록. 알림 메시지의 버튼 상태를 복원할 때 쓴다. */
  static async listByRunId(runId: number): Promise<ArticleJobRow[]> {
    const { data, error } = await supabase
      .from("article_jobs")
      .select("*")
      .eq("source_run_id", runId)
      .order("source_rank", { ascending: true });

    if (error) throw error;
    return data ?? [];
  }

  static async updateStatus(id: string, status: ArticleJobStatus): Promise<ArticleJobRow | null> {
    const { data, error } = await supabase
      .from("article_jobs")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select()
      .maybeSingle();

    if (error) throw error;
    return data ?? null;
  }

  /**
   * metadata를 병합한다(덮어쓰지 않는다). 단계별로 서로 다른 키를 추가하므로
   * (titleSuggestions -> factCards -> imageRefs ...) 통째로 교체하면 앞 단계 결과가 사라진다.
   */
  static async mergeMetadata(id: string, patch: Record<string, unknown>): Promise<ArticleJobRow | null> {
    const current = await this.findById(id);
    if (!current) return null;

    const { data, error } = await supabase
      .from("article_jobs")
      .update({ metadata: { ...current.metadata, ...patch }, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select()
      .maybeSingle();

    if (error) throw error;
    return data ?? null;
  }

  /** 전달된 id만 삭제한다. 테스트 데이터 cleanup 등 명시적으로 id를 아는 row만 지울 때 사용한다. */
  static async deleteByIds(ids: string[]): Promise<number> {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) return 0;

    const { data, error } = await supabase.from("article_jobs").delete().in("id", uniqueIds).select("id");

    if (error) throw error;
    return data?.length ?? 0;
  }
}
