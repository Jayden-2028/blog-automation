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
