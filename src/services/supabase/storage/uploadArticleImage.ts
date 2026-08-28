// 생성된 이미지를 Supabase Storage `article-images` 버킷(2026-08-28 생성, public)에 올리고
// 공개 URL을 돌려준다. Telegraph/네이버 어느 쪽도 우리 서버에 파일을 올릴 방법이 없으므로,
// 공개적으로 접근 가능한 URL이 있어야 원고에 이미지를 넣을 수 있다.

import { supabase } from "../client.js";

export const ARTICLE_IMAGES_BUCKET = "article-images";

export type UploadArticleImageInput = {
  jobId: string;
  /** 같은 job에 이미지가 여러 장이므로 순번을 파일명에 넣는다. */
  index: number;
  imageBuffer: Buffer;
  mimeType: string;
};

export type UploadArticleImageResult = { ok: true; url: string; path: string } | { ok: false; error: string };

function extensionFor(mimeType: string): string {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  return "png";
}

export async function uploadArticleImage(input: UploadArticleImageInput): Promise<UploadArticleImageResult> {
  const path = `${input.jobId}/${input.index}.${extensionFor(input.mimeType)}`;

  const { error: uploadError } = await supabase.storage
    .from(ARTICLE_IMAGES_BUCKET)
    .upload(path, input.imageBuffer, { contentType: input.mimeType, upsert: true });

  if (uploadError) {
    return { ok: false, error: uploadError.message };
  }

  const { data } = supabase.storage.from(ARTICLE_IMAGES_BUCKET).getPublicUrl(path);
  if (!data.publicUrl) {
    return { ok: false, error: "공개 URL을 가져오지 못했습니다." };
  }

  return { ok: true, url: data.publicUrl, path };
}
