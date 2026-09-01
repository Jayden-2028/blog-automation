import { supabase } from "../client.js";
import type { SourceInsert, SourceRow } from "../../../types/database.js";

/**
 * 공공 페이지 본문을 fetch해 오면 NUL 바이트(U+0000)가 섞여 있을 수 있는데, PostgreSQL text
 * 컬럼은 이를 저장하지 못한다(22P05 "unsupported Unicode escape sequence"). insert 직전에 NUL과
 * 기타 C0 제어 문자를 걷어낸다(\t \n \r은 유지).
 */
function stripControlChars(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f) continue;
    out += ch;
  }
  return out;
}

function sanitizeSourceInsert(input: SourceInsert): SourceInsert {
  const clean = (v: string | null | undefined): string | null | undefined =>
    typeof v === "string" ? stripControlChars(v) : v;
  return { ...input, title: clean(input.title), content: clean(input.content), url: clean(input.url) };
}

export async function createSource(input: SourceInsert): Promise<SourceRow> {
  const { data, error } = await supabase
    .from("sources")
    .insert(sanitizeSourceInsert(input))
    .select()
    .single();

  if (error) throw error;
  return data;
}

/** job_id 기준으로 여러 건을 한 번에 저장한다. 자료조사 단계가 검색 결과 N건을 한 번에 넣는다. */
export async function createSources(inputs: SourceInsert[]): Promise<SourceRow[]> {
  if (inputs.length === 0) return [];

  const { data, error } = await supabase
    .from("sources")
    .insert(inputs.map(sanitizeSourceInsert))
    .select();

  if (error) throw error;
  return data ?? [];
}

export async function listSourcesByKeywordId(keywordId: number): Promise<SourceRow[]> {
  const { data, error } = await supabase
    .from("sources")
    .select("*")
    .eq("keyword_id", keywordId)
    .order("created_at", { ascending: false });

  if (error) throw error;
  return data ?? [];
}

/** 특정 job의 근거를 전부 조회한다. 원고 생성/검수/텔레그램 알림이 이걸 쓴다. */
export async function listSourcesByJobId(jobId: string): Promise<SourceRow[]> {
  const { data, error } = await supabase
    .from("sources")
    .select("*")
    .eq("job_id", jobId)
    .order("created_at", { ascending: true });

  if (error) throw error;
  return data ?? [];
}
