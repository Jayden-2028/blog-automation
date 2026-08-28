// images 테이블 repository(SPRINT_3_DESIGN.md 12절).
//
// article_assets를 새로 만들지 않는 이유: 원격에 이미 images 테이블이 있고 필요한 컬럼을 전부
// 갖고 있다(article_id, image_url, source, copyright_status, alt_text) - 2026-08-26 세션에서
// 발견해 CURRENT_STATE.md에 기록해뒀다.

import { supabase } from "../client.js";
import type { ImageInsert, ImageRow } from "../../../types/database.js";

export async function createImage(input: ImageInsert): Promise<ImageRow> {
  const { data, error } = await supabase.from("images").insert(input).select().single();

  if (error) throw error;
  return data;
}

export async function listImagesByArticleId(articleId: number): Promise<ImageRow[]> {
  const { data, error } = await supabase
    .from("images")
    .select("*")
    .eq("article_id", articleId)
    .order("created_at", { ascending: true });

  if (error) throw error;
  return data ?? [];
}
