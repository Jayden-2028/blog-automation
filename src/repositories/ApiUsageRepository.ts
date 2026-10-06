// 유료 API 사용량·비용 원장(api_usage 테이블) repository.
// 다른 repository와 같은 위치·스타일을 따른다 - DB 접근은 이 파일 안에만 둔다.
//
// record()가 예외를 던지지 않는 이유: 비용 기록은 **부수적 관측**이다. 이미지 1장을 이미 만들어
// 돈까지 쓴 뒤에 원장 insert가 실패했다고 원고 준비 전체를 실패시키면, 돈은 그대로 나가고 산출물만
// 잃는다(최악의 조합). 이미지 생성이 best-effort인 것과 같은 판단이다
// (workflows/images/generateManuscriptImages.ts 머리말).

import { supabase } from "../services/supabase/client.js";
import type { ApiUsageInsert, ApiUsageRow } from "../types/database.js";

export type RecordApiUsageResult = { ok: true; row: ApiUsageRow } | { ok: false; error: string };

export class ApiUsageRepository {
  /** 호출 1건을 원장에 남긴다. 실패해도 예외를 던지지 않고 사유만 돌려준다(호출자는 로그만 남긴다). */
  static async record(row: ApiUsageInsert): Promise<RecordApiUsageResult> {
    try {
      const { data, error } = await supabase.from("api_usage").insert(row).select().single();
      if (error) return { ok: false, error: error.message };
      return { ok: true, row: data };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * 집계 구간의 원장을 통째로 읽는다. 합계는 SQL이 아니라 Node(buildCostSummary)에서 낸다 -
   * "오늘/이번 달/원고당" 같은 집계 축이 자주 바뀌는데, 그때마다 DB 함수를 고치면 migration
   * 승인 게이트를 매번 통과해야 한다. 개인 규모(하루 수십 건)라 전부 읽어도 부담이 없다.
   */
  static async listSince(since: Date, limit = 50_000): Promise<ApiUsageRow[]> {
    // PostgREST는 요청당 최대 1000행(hosted 기본 max_rows)이라 limit만 올려서는 조용히 잘린다 -
    // Serper가 호출 1건당 1행을 쌓으면서 하루 수백 행이 되었다(2026-10-06). 페이지로 나눠 읽는다.
    const PAGE = 1000;
    const rows: ApiUsageRow[] = [];
    for (let from = 0; from < limit; from += PAGE) {
      const { data, error } = await supabase
        .from("api_usage")
        .select("*")
        .gte("occurred_at", since.toISOString())
        .order("occurred_at", { ascending: false })
        .range(from, Math.min(from + PAGE, limit) - 1);

      if (error) throw new Error(`api_usage 조회 실패: ${error.message}`);
      rows.push(...(data ?? []));
      if (!data || data.length < PAGE) break;
    }
    return rows;
  }

  /** 구매일 이후 **크레딧을 쓴** serper 호출 수(실패 행 제외). 행이 많아 count만 받는다. */
  static async countBilledSerperSince(since: Date): Promise<number> {
    const { count, error } = await supabase
      .from("api_usage")
      .select("*", { count: "exact", head: true })
      .eq("provider", "serper")
      .not("operation", "like", "%.failed")
      .gte("occurred_at", since.toISOString());

    if (error) throw new Error(`api_usage serper 집계 실패: ${error.message}`);
    return count ?? 0;
  }
}
