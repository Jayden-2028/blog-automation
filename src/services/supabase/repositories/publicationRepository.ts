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
