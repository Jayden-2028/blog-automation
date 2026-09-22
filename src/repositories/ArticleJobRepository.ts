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

/**
 * 수동 등록 job(인스타그램 등)이 쓰는 가짜 discovery_run 네임스페이스.
 * source_run_id는 실제 discovery_runs.id가 양의 serial이라, 절대 겹치지 않는 음수 값을 고른다.
 */
const MANUAL_SOURCE_RUN_ID = -1;

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

  /**
   * discovery_run 없이 job을 만든다(인스타그램 수동 큐레이션 등). keyword_rankings를 거치지 않으므로
   * createFromRanking을 못 쓴다 - source_run_id/source_rank는 (run_id, rank) 유니크 인덱스를 만족시키기
   * 위한 자리채우기일 뿐, 실제 discovery_run을 가리키지 않는다.
   *
   * rank는 Unix seconds를 쓴다(같은 초 안에 두 건이 들어오면 유니크 충돌 - 그때는 1씩 올려 재시도).
   * 사람이 한 번에 하나씩 텔레그램으로 보내는 흐름이라 실제로 부딪힐 확률은 낮다.
   */
  static async createManual(input: {
    keyword: string;
    headline?: string | null;
    category?: string | null;
    metadata: Record<string, unknown>;
  }): Promise<CreateArticleJobResult> {
    let rank = Math.floor(Date.now() / 1000);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const row: ArticleJobInsert = {
        source_run_id: MANUAL_SOURCE_RUN_ID,
        source_rank: rank,
        keyword: input.keyword,
        headline: input.headline ?? null,
        seed_query: null,
        category: input.category ?? null,
        total_score: null,
        score_breakdown: null,
        status: "selected",
        selected_via: "manual",
        metadata: input.metadata,
      };

      const { data, error } = await supabase.from("article_jobs").insert(row).select().single();
      if (!error && data) return { job: data, created: true };

      if (error?.code === UNIQUE_VIOLATION) {
        rank += 1;
        continue;
      }
      throw error ?? new Error("article_jobs insert가 row를 반환하지 않았습니다.");
    }
    throw new Error("createManual: source_rank 재시도 5회 모두 충돌했습니다.");
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

  /**
   * 승인됐지만 아직 원고를 안 만든 job만 반환한다(오래된 선택 순).
   *
   * 왜 별도 메서드인가(2026-09-16 실측 사고): prepareApprovedManuscripts는 원래
   * `listByStatus("approved", 20)`으로 20건을 받아 **메모리에서** channelManuscriptsReadyAt이 없는
   * 것만 걸렀다. 그런데 이 조회는 selected_at **오름차순**(오래된 것 먼저)이라, 승인 후 준비까지
   * 끝난 job이 20건을 채우자 그 20건이 전부 필터에 걸러져 pending이 항상 빈 배열이 됐다 - 정작
   * 준비가 필요한 **새로 승인된 job은 20건 창 밖으로 밀려나** 조회조차 되지 않았다. 그래서
   * 텔레그램에서 승인해도 job-publish-prepare가 13초 만에 아무 로그 없이 끝나고 원고가 뷰어에
   * 영영 안 나타났다(approved 22건 / limit 20에서 발생, 이후 승인은 전부 무음 유실).
   *
   * 필터를 DB로 내려 "준비 안 된 것"만 뽑으므로 승인 누적 건수와 무관하게 안전하다.
   * `metadata->>channelManuscriptsReadyAt is null`은 키가 아예 없는 경우와 JSON null 둘 다 잡는다.
   */
  static async listApprovedWithoutManuscript(limit = 20): Promise<ArticleJobRow[]> {
    const { data, error } = await supabase
      .from("article_jobs")
      .select("*")
      .eq("status", "approved")
      .filter("metadata->>channelManuscriptsReadyAt", "is", null)
      .order("selected_at", { ascending: true })
      .limit(limit);

    if (error) throw error;
    return data ?? [];
  }

  /**
   * "수정 필요" 안내 메시지의 message_id로 job을 찾는다(답장 매칭).
   *
   * 왜 status를 review로 한정하지 않는가(2026-09-19 실측 사고): 예전 구현은
   * `listByStatus("review", 50)`을 훑었는데, **이미 승인된 원고**를 최종본에서 보고 수정 요청하면
   * job.status가 approved라 매칭이 통째로 실패해 답장이 조용히 무시됐다(사용자 리포트 - "정풍운동
   * 수정 요청에 응답이 없다"). 승인 후에도 고칠 수 있어야 하므로 두 status를 모두 본다.
   *
   * 필터를 DB로 내려 조회 창(50건) 밖으로 밀려나는 문제도 같이 없앤다 - message_id는 유일하다.
   */
  static async findByEditRequestMessageId(messageId: number): Promise<ArticleJobRow | null> {
    const { data, error } = await supabase
      .from("article_jobs")
      .select("*")
      .in("status", ["review", "approved"])
      .filter("metadata->>editRequestMessageId", "eq", String(messageId))
      .order("selected_at", { ascending: false })
      .limit(1);

    if (error) throw error;
    return data?.[0] ?? null;
  }

  /**
   * status와 무관하게 최근 선택된 job을 최신순으로 반환한다.
   *
   * listByStatus는 "다음 단계 워커가 집어갈 job"을 찾는 용도라 status가 고정이다. 이 메서드는
   * 사람이 "그 원고 jobId가 뭐였지"를 찾을 때(report:jobs)를 위한 것이라 전 status를 훑는다.
   */
  static async listRecent(limit = 200): Promise<ArticleJobRow[]> {
    const { data, error } = await supabase
      .from("article_jobs")
      .select("*")
      .order("selected_at", { ascending: false })
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
