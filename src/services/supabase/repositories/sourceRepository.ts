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

/** job_id 기준으로 여러 건을 한 번에 저장한다. 자료조사 단계가 검색 결과 N건을 한 번에 넣는다. */
export async function createSources(
  inputs: SourceInsert[]
): Promise<SourceRow[]> {
  if (inputs.length === 0) return [];

  const { data, error } = await supabase
    .from("sources")
    .insert(inputs)
    .select();

  if (error) throw error;
  return data ?? [];
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

/** 특정 job의 근거를 전부 조회한다. 원고 생성/검수/텔레그램 알림이 이걸 쓴다. */
export async function listSourcesByJobId(
  jobId: string
): Promise<SourceRow[]> {
  const { data, error } = await supabase
    .from("sources")
    .select("*")
    .eq("job_id", jobId)
    .order("created_at", { ascending: true });

  if (error) throw error;
  return data ?? [];
}
