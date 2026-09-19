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
 * 여러 article의 publication을 한 번에 가져온다(최신순).
 *
 * 왜 필요한가(2026-09-19): 수정 반영이 들어오면 배리에이션 article row가 새로 생긴다. article
 * 한 건만 보면 그 새 row에는 publication이 없어 "아직 안 올렸다"로 보이고, 같은 원고가 블로그에
 * 두 번 올라간다. job에 속한 article 전부를 봐야 이미 올라간 글을 찾을 수 있다.
 */
export async function listPublicationsByArticleIds(
  articleIds: number[]
): Promise<PublicationRow[]> {
  if (articleIds.length === 0) return [];
  const { data, error } = await supabase
    .from("publications")
    .select("*")
    .in("article_id", articleIds)
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
