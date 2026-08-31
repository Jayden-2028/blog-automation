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
  status: PublicationStatus
): Promise<PublicationRow> {
  const { data, error } = await supabase
    .from("publications")
    .update({ status } satisfies PublicationUpdate)
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
