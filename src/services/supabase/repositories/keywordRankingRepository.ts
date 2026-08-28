import { supabase } from "../client.js";
import type { KeywordRankingInsert, KeywordRankingRow } from "../../../types/database.js";

export async function createKeywordRankings(
  inputs: KeywordRankingInsert[]
): Promise<KeywordRankingRow[]> {
  if (inputs.length === 0) return [];

  const { data, error } = await supabase.from("keyword_rankings").insert(inputs).select();

  if (error) throw error;
  return data ?? [];
}

/**
 * (run_id, rank) 한 건을 조회한다. Telegram 인라인 버튼의 callback_data가 이 두 값만 담고 있어서,
 * 수신 측이 실제 키워드를 여기서 다시 읽는다. 조회되지 않으면(만료된 run, 위조된 callback_data)
 * null이며, 이 null 판정이 곧 callback_data 검증 역할을 한다.
 */
export async function getKeywordRankingByRunAndRank(
  runId: number,
  rank: number
): Promise<KeywordRankingRow | null> {
  const { data, error } = await supabase
    .from("keyword_rankings")
    .select("*")
    .eq("run_id", runId)
    .eq("rank", rank)
    .maybeSingle();

  if (error) throw error;
  return data ?? null;
}

export async function listKeywordRankingsByRunId(
  runId: number
): Promise<KeywordRankingRow[]> {
  const { data, error } = await supabase
    .from("keyword_rankings")
    .select("*")
    .eq("run_id", runId)
    .order("rank", { ascending: true });

  if (error) throw error;
  return data ?? [];
}
