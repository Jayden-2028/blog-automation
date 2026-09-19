import { supabase } from "../client.js";
import type {
  PublicationInsert,
  PublicationRow,
  PublicationStatus,
  PublicationUpdate,
} from "../../../types/database.js";

export async function createPublication(
  input: PublicationInsert
): Promise<PublicationRow> {
  const { data, error } = await supabase
    .from("publications")
    .insert(input)
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function updatePublicationStatus(
  id: number,
  status: PublicationStatus,
  /**
   * 초안을 공개로 전환하면 URL이 편집 주소에서 공개 주소로 바뀐다(2026-09-19). 생략하면 기존 값을
   * 그대로 둔다 - status만 바꾸는 호출이 URL을 지워버리면 안 된다.
   */
  publishedUrl?: string
): Promise<PublicationRow> {
  const { data, error } = await supabase
    .from("publications")
    .update({ status, ...(publishedUrl ? { published_url: publishedUrl } : {}) } satisfies PublicationUpdate)
    .eq("id", id)
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function listPublicationsByArticleId(
  articleId: number
): Promise<PublicationRow[]> {
  const { data, error } = await supabase
    .from("publications")
    .select("*")
    .eq("article_id", articleId)
    .order("created_at", { ascending: false });

  if (error) throw error;
  return data ?? [];
}

/**
 * 오늘(로컬 자정 기준) 해당 platform으로 실제 발행/임시저장된 publication 수. 일일 상한 하드 가드용.
 * status='failed'는 세지 않는다(실패는 재시도되므로 상한을 잠식하면 안 된다).
 */
export async function countTodayPublicationsByPlatform(platform: string): Promise<number> {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const { count, error } = await supabase
    .from("publications")
    .select("id", { count: "exact", head: true })
    .eq("platform", platform)
    .neq("status", "failed")
    .gte("created_at", startOfDay.toISOString());

  if (error) throw error;
  return count ?? 0;
}
