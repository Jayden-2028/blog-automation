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

export async function getArticleById(id: number): Promise<ArticleRow | null> {
  const { data, error } = await supabase
    .from("articles")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) throw error;
  return data;
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
