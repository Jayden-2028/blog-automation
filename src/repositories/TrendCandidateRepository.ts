// Creator Advisor 트렌드 탭에서 수집한 동적 키워드 후보(trend_candidates 테이블) repository.
// SeedQueryRepository.ts와 같은 위치/스타일을 따른다 - seed_queries와 trend_candidates는 둘 다
// daily query pool의 입력원이라는 같은 층위의 데이터이기 때문이다(buildDailyQueryPool.ts 참고).
//
// DB 접근은 이 파일 안에만 둔다 - keyword_normalized/topic_normalized 계산, trend_date 결정,
// candidate_score 산출 등 매핑/스코어링 로직은 전부 workflows/creator-advisor/의 순수 함수
// (mapCreatorAdvisorCandidates.ts, scoreCreatorAdvisorCandidate.ts)에 있고, 이 repository는 이미
// 만들어진 TrendCandidateInsert[]를 upsert/조회/만료 처리만 한다.
//
// dedupe 기준: supabase/migrations/20260825150000_trend_candidates.sql의
// uq_trend_candidates_keyword_topic_date_source unique index -
// (keyword_normalized, topic_normalized, trend_date, source).

import { supabase } from "../services/supabase/client.js";
import type {
  TrendCandidateInsert,
  TrendCandidateRow,
  TrendCandidateStatus,
} from "../types/database.js";

const TREND_CANDIDATES_CONFLICT_TARGET = "keyword_normalized,topic_normalized,trend_date,source";

export type ListCandidatesByTrendDateOptions = {
  /** 생략하면 source 무관하게 조회한다. */
  source?: string;
  /** 기본 'active'. */
  status?: TrendCandidateStatus;
};

export type ListLatestActiveCandidatesResult = {
  /** trend_candidates에 해당 source의 active row가 하나도 없으면 null. */
  trendDate: string | null;
  candidates: TrendCandidateRow[];
};

export class TrendCandidateRepository {
  /**
   * 이미 매핑된 TrendCandidateInsert[]를 upsert한다(mapCreatorAdvisorCandidates.ts 참고). 같은
   * (keyword_normalized, topic_normalized, trend_date, source) 조합은 한 row로 병합되며(재수집 시
   * rank/movement_type/candidate_score 등이 최신 값으로 갱신된다), migration의
   * uq_trend_candidates_keyword_topic_date_source unique index를 conflict target으로 사용한다.
   */
  static async upsertCandidates(rows: TrendCandidateInsert[]): Promise<TrendCandidateRow[]> {
    if (rows.length === 0) return [];

    const { data, error } = await supabase
      .from("trend_candidates")
      .upsert(rows, { onConflict: TREND_CANDIDATES_CONFLICT_TARGET })
      .select();

    if (error) throw error;
    return data ?? [];
  }

  /** 특정 trend_date의 후보를 조회한다. 기본은 status='active' 전체(source 무관)이며, options로 좁힐 수 있다. */
  static async listCandidatesByTrendDate(
    trendDate: string,
    options: ListCandidatesByTrendDateOptions = {}
  ): Promise<TrendCandidateRow[]> {
    let query = supabase
      .from("trend_candidates")
      .select("*")
      .eq("trend_date", trendDate)
      .eq("status", options.status ?? "active");

    if (options.source) {
      query = query.eq("source", options.source);
    }

    const { data, error } = await query.order("candidate_score", { ascending: false, nullsFirst: false });

    if (error) throw error;
    return data ?? [];
  }

  /** status='active'인 row 중 가장 최신 trend_date("YYYY-MM-DD")를 반환한다. 없으면 null. */
  static async getLatestAvailableTrendDate(source = "creator_advisor"): Promise<string | null> {
    const { data, error } = await supabase
      .from("trend_candidates")
      .select("trend_date")
      .eq("status", "active")
      .eq("source", source)
      .order("trend_date", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;
    return data?.trend_date ?? null;
  }

  /**
   * getLatestAvailableTrendDate() + listCandidatesByTrendDate()를 합친 편의 메서드.
   * buildDailyQueryPool()이 "latestAvailableTrendDate의 active Creator Advisor 후보"를 한 번에
   * 가져올 때 쓴다. active row가 하나도 없으면 trendDate=null, candidates=[]를 반환한다(예외 아님).
   */
  static async listLatestActiveCandidates(source = "creator_advisor"): Promise<ListLatestActiveCandidatesResult> {
    const trendDate = await this.getLatestAvailableTrendDate(source);
    if (!trendDate) return { trendDate: null, candidates: [] };

    const candidates = await this.listCandidatesByTrendDate(trendDate, { source });
    return { trendDate, candidates };
  }

  /** expires_at이 지난 active row를 status='expired'로 전환한다. 삭제하지 않는다(이력 보존). */
  static async expireOldCandidates(): Promise<number> {
    const nowIso = new Date().toISOString();

    const { data, error } = await supabase
      .from("trend_candidates")
      .update({ status: "expired" satisfies TrendCandidateStatus, updated_at: nowIso })
      .eq("status", "active")
      .lt("expires_at", nowIso)
      .select("id");

    if (error) throw error;
    return data?.length ?? 0;
  }
}
