import { supabase } from "../client.js";
import type {
  ArticleInsert,
  ArticleRow,
  ArticleStatus,
  ArticleUpdate,
} from "../../../types/database.js";

export async function createArticle(input: ArticleInsert): Promise<ArticleRow> {
  const { data, error } = await supabase
    .from("articles")
    .insert(input)
    .select()
    .single();

  if (error) throw error;
  return data;
}

/** job_id 기준 원고 생성. */
export async function createArticleForJob(
  input: ArticleInsert & { job_id: string }
): Promise<ArticleRow> {
  return createArticle(input);
}

export async function getArticleById(id: number): Promise<ArticleRow | null> {
  const { data, error } = await supabase
    .from("articles")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) throw error;
  return data;
}

/** 특정 job의 원고를 조회한다(보통 1건이지만 재작성 이력이 남을 수 있어 배열로 반환). */
export async function listArticlesByJobId(
  jobId: string
): Promise<ArticleRow[]> {
  const { data, error } = await supabase
    .from("articles")
    .select("*")
    .eq("job_id", jobId)
    .order("created_at", { ascending: true });

  if (error) throw error;
  return data ?? [];
}

/**
 * 여러 job의 원고를 한 번에 가져온다. job 목록 리포트(report:jobs)처럼 job N건의 제목이
 * 필요할 때 listArticlesByJobId를 N번 부르지 않기 위한 배치 조회다.
 */
export async function listArticlesByJobIds(jobIds: string[]): Promise<ArticleRow[]> {
  if (jobIds.length === 0) return [];

  const { data, error } = await supabase
    .from("articles")
    .select("*")
    .in("job_id", jobIds)
    .order("created_at", { ascending: true });

  if (error) throw error;
  return data ?? [];
}

export async function updateArticle(
  id: number,
  patch: ArticleUpdate
): Promise<ArticleRow> {
  const { data, error } = await supabase
    .from("articles")
    .update(patch)
    .eq("id", id)
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function updateArticleStatus(
  id: number,
  status: ArticleStatus
): Promise<ArticleRow> {
  const { data, error } = await supabase
    .from("articles")
    .update({ status } satisfies ArticleUpdate)
    .eq("id", id)
    .select()
    .single();

  if (error) throw error;
  return data;
}
