import { supabase } from "../client.js";
import type {
  KeywordInsert,
  KeywordRow,
  KeywordStatus,
  KeywordUpdate,
} from "../../../types/database.js";

export async function createKeyword(input: KeywordInsert): Promise<KeywordRow> {
  const { data, error } = await supabase
    .from("keywords")
    .insert(input)
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function getKeywordById(id: number): Promise<KeywordRow | null> {
  const { data, error } = await supabase
    .from("keywords")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) throw error;
  return data;
}

export interface ListKeywordsOptions {
  status?: KeywordStatus;
  limit?: number;
}

export async function listKeywords(
  options: ListKeywordsOptions = {}
): Promise<KeywordRow[]> {
  let query = supabase
    .from("keywords")
    .select("*")
    .order("created_at", { ascending: false });

  if (options.status) {
    query = query.eq("status", options.status);
  }
  if (options.limit) {
    query = query.limit(options.limit);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

export async function updateKeywordStatus(
  id: number,
  status: KeywordStatus
): Promise<KeywordRow> {
  const { data, error } = await supabase
    .from("keywords")
    .update({ status } satisfies KeywordUpdate)
    .eq("id", id)
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function deleteKeyword(id: number): Promise<void> {
  const { error } = await supabase.from("keywords").delete().eq("id", id);
  if (error) throw error;
}

// keyword discovery의 DB 중복 확인용: 대소문자 무시하고 sinceIso 이후 생성된 동일 keyword를 찾는다.
export async function findRecentKeywordByName(
  keyword: string,
  sinceIso: string
): Promise<KeywordRow | null> {
  const { data, error } = await supabase
    .from("keywords")
    .select("*")
    .ilike("keyword", keyword)
    .gte("created_at", sinceIso)
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data;
}
