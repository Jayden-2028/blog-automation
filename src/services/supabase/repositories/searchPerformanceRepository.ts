// search_performance_daily 읽기/쓰기.
//
// upsert를 쓰는 이유: GSC는 발표 후 며칠간 수치를 보정한다. 같은 날짜를 다시 받아 덮어쓰는 것이
// **정상 운영**이라 (date, page_url, query) unique 위에서 갱신한다.

import { supabase } from "../client.js";

export type SearchPerformanceInsert = {
  date: string;
  page_url: string;
  query: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  job_id: string | null;
};

/** 한 번에 보내는 행 수. 하루치가 수천 건이 될 수 있어 나눠 보낸다. */
const CHUNK = 500;

export async function upsertSearchPerformance(rows: SearchPerformanceInsert[]): Promise<number> {
  let written = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { error } = await supabase
      .from("search_performance_daily")
      .upsert(chunk, { onConflict: "date,page_url,query" });
    if (error) throw error;
    written += chunk.length;
  }
  return written;
}

/**
 * 발행된 글 주소 → job_id. 성과 행을 우리 원고에 붙이는 데 쓴다.
 *
 * publications는 article_id만 갖고 있어 articles를 한 번 거쳐야 job_id가 나온다.
 */
export async function loadPublishedUrlToJobId(): Promise<Map<string, string>> {
  const { data, error } = await supabase
    .from("publications")
    .select("published_url, articles(job_id)")
    .not("published_url", "is", null);
  if (error) throw error;

  const map = new Map<string, string>();
  for (const row of (data ?? []) as Array<{ published_url: string | null; articles: { job_id: string | null } | null }>) {
    const jobId = row.articles?.job_id;
    if (row.published_url && jobId) map.set(row.published_url, jobId);
  }
  return map;
}
