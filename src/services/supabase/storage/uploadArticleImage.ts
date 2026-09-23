// 생성된 이미지를 Supabase Storage `article-images` 버킷(2026-08-28 생성, public)에 올리고
// 공개 URL을 돌려준다. Telegraph/네이버 어느 쪽도 우리 서버에 파일을 올릴 방법이 없으므로,
// 공개적으로 접근 가능한 URL이 있어야 원고에 이미지를 넣을 수 있다.

import { createHash } from "node:crypto";

import { supabase } from "../client.js";

export const ARTICLE_IMAGES_BUCKET = "article-images";

export type UploadArticleImageInput = {
  jobId: string;
  /** 같은 job에 이미지가 여러 장이므로 순번을 파일명에 넣는다. */
  index: number;
  /**
   * 같은 순번의 이미지를 여러 벌 올릴 때 파일명을 가르는 꼬리표(2026-09-15 A/B 비교).
   * 예: index=1 + variant="openai" -> "1-openai.png". 없으면 예전처럼 "1.png".
   */
  variant?: string;
  imageBuffer: Buffer;
  mimeType: string;
};

export type UploadArticleImageResult = { ok: true; url: string; path: string } | { ok: false; error: string };

function extensionFor(mimeType: string): string {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  return "png";
}

/**
 * 내용이 바뀌었는데 주소가 같으면 브라우저는 **옛 이미지를 계속 보여준다**(2026-09-24 실측).
 *
 * 파일명은 자리 번호로 고정이라(`1-web.jpg`) 재수집해도 주소가 그대로다. 그래서 이미지를 다시
 * 모을 때마다 사람이 캐시를 비워야 원고를 제대로 볼 수 있었다 - 실제로 그 일이 있었다.
 *
 * 내용 해시를 붙여 **내용이 바뀌면 주소도 바뀌게** 한다. 같은 이미지를 다시 올리면 해시도 같아
 * 주소가 안 바뀌고, 그때는 캐시가 그대로 쓰이는 게 맞다.
 */
function versionOf(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex").slice(0, 12);
}

export async function uploadArticleImage(input: UploadArticleImageInput): Promise<UploadArticleImageResult> {
  const name = input.variant ? `${input.index}-${input.variant}` : String(input.index);
  const path = `${input.jobId}/${name}.${extensionFor(input.mimeType)}`;

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

  // 내용 해시를 쿼리로 붙인다. Storage는 이 파라미터를 무시하고 같은 파일을 주지만,
  // 브라우저·CDN에는 **다른 주소**라서 새 이미지를 받는다.
  const url = `${data.publicUrl}?v=${versionOf(input.imageBuffer)}`;
  return { ok: true, url, path };
}
