import { supabase } from "../client.js";
import type { SourceInsert, SourceRow } from "../../../types/database.js";

export async function createSource(input: SourceInsert): Promise<SourceRow> {
  const { data, error } = await supabase
    .from("sources")
    .insert(input)
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function listSourcesByKeywordId(
  keywordId: number
): Promise<SourceRow[]> {
  const { data, error } = await supabase
    .from("sources")
    .select("*")
    .eq("keyword_id", keywordId)
    .order("created_at", { ascending: false });

  if (error) throw error;
  return data ?? [];
}
