// 생성된 이미지를 Supabase Storage `article-images` 버킷(2026-08-28 생성, public)에 올리고
// 공개 URL을 돌려준다. Telegraph/네이버 어느 쪽도 우리 서버에 파일을 올릴 방법이 없으므로,
// 공개적으로 접근 가능한 URL이 있어야 원고에 이미지를 넣을 수 있다.

import { createHash } from "node:crypto";

import { isAvif, optimizeImage } from "../../images/optimizeImage.js";
import { MIME_BY_FORMAT, sniffImageFormat } from "../../images/sniffImageFormat.js";
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
  /**
   * 올리기 전에 WebP로 바꾸고 긴 변을 줄인다(2026-10-04, 저장소 용량 절감). **기본은 끈다** -
   * 글자가 읽혀야 하는 캡처·표는 변환하면 뭉개질 수 있어 호출하는 쪽이 골라서 켠다.
   * 객체를 주면 화질(`quality`, 0~1)·최대 변(`maxSide`)을 정한다. 변환은 best-effort라
   * 실패하거나 더 커지면 원본으로 올린다.
   */
  optimize?: boolean | { quality?: number; maxSide?: number };
};

/**
 * `extension` - 실제로 올라간 파일의 확장자(2026-10-08). 올리면서 AVIF를 WebP로 바꾸기도 해서 **호출한 쪽이 아는
 * 확장자와 다를 수 있다.** 호출한 쪽은 기록(manifest의 fileName)과 보관함 이름을 이 값에 맞춰야 한다 -
 * 안 맞추면 WebP 바이트가 `.avif` 이름으로 저장된다.
 */
export type UploadArticleImageResult = { ok: true; url: string; path: string; extension?: string } | { ok: false; error: string };

/**
 * 확장자는 **실제 형식**을 따른다(2026-10-08). 전에는 jpeg·webp 외 전부 `png`로 떨어뜨려, AVIF 바이트가
 * `2-web.png`라는 거짓 이름으로 올라갔다(content-type만 `image/avif`로 정직해 이름과 내용물이 어긋났다).
 * 모르는 형식은 예전처럼 `png`로 둔다 - 이름을 못 정한다고 업로드를 막지는 않는다.
 */
export function extensionFor(mimeType: string): string {
  const type = mimeType.toLowerCase();
  if (type.includes("jpeg") || type.includes("jpg")) return "jpg";
  if (type.includes("webp")) return "webp";
  if (type.includes("avif")) return "avif";
  if (type.includes("gif")) return "gif";
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

/**
 * 올리기 직전의 이미지 준비: 실제 형식 확인 → (필요하면) WebP 변환 → 확장자 결정.
 * Supabase 없이 검증할 수 있게 업로드와 분리했다(`test:upload-image-format`).
 */
export async function prepareUploadImage(
  input: Pick<UploadArticleImageInput, "imageBuffer" | "mimeType" | "optimize"> & { label?: string }
): Promise<{ buffer: Buffer; mimeType: string; extension: string }> {
  const label = input.label ?? "";
  let imageBuffer = input.imageBuffer;
  let mimeType = input.mimeType;

  // 서버가 알려 준 content-type은 믿지 않는다 - **실제 바이트**가 기준이다(2026-10-08). 이름·content-type·
  // 바이트 셋이 일치해야 뒤의 발행기들이 각자 방어하지 않아도 된다.
  const sniffed = sniffImageFormat(imageBuffer);
  if (sniffed && MIME_BY_FORMAT[sniffed] !== mimeType.toLowerCase().replace("image/jpg", "image/jpeg")) {
    console.log(`ℹ️ [images] ${label} 실제 형식이 ${sniffed}라 content-type을 바로잡습니다(${mimeType} → ${MIME_BY_FORMAT[sniffed]}).`);
    mimeType = MIME_BY_FORMAT[sniffed];
  }

  // AVIF는 `optimize`를 끈 호출(캡처·표 등)이라도 WebP로 정규화한다 - 형식 정규화가 목적이라 용량과 무관하다.
  // 변환은 best-effort다: 실패하면 AVIF 그대로 **정직한 이름(.avif)**으로 올라간다(extensionFor).
  const normalizeAvif = !input.optimize && isAvif(mimeType);
  if (input.optimize || normalizeAvif) {
    const options = typeof input.optimize === "object" ? input.optimize : {};
    const optimized = await optimizeImage({ buffer: imageBuffer, mimeType, ...options });
    if (optimized.optimized) {
      console.log(
        `ℹ️ [images] ${label} ${normalizeAvif || isAvif(input.mimeType) ? "AVIF → " : ""}WebP 변환 ` +
          `${Math.round(optimized.originalBytes / 1024)}KB → ${Math.round(optimized.buffer.length / 1024)}KB`
      );
      imageBuffer = optimized.buffer;
      mimeType = optimized.mimeType;
    } else if (isAvif(mimeType)) {
      console.warn(`⚠️ [images] ${label} AVIF를 WebP로 바꾸지 못해 .avif 그대로 올립니다: ${optimized.skippedReason ?? ""}`);
    }
  }
  return { buffer: imageBuffer, mimeType, extension: extensionFor(mimeType) };
}

export async function uploadArticleImage(input: UploadArticleImageInput): Promise<UploadArticleImageResult> {
  const prepared = await prepareUploadImage({
    imageBuffer: input.imageBuffer,
    mimeType: input.mimeType,
    optimize: input.optimize,
    label: `${input.jobId.slice(0, 8)}/${input.index}`,
  });
  const imageBuffer = prepared.buffer;
  const mimeType = prepared.mimeType;

  const name = input.variant ? `${input.index}-${input.variant}` : String(input.index);
  const path = `${input.jobId}/${name}.${prepared.extension}`;

  const { error: uploadError } = await supabase.storage
    .from(ARTICLE_IMAGES_BUCKET)
    .upload(path, imageBuffer, { contentType: mimeType, upsert: true });

  if (uploadError) {
    return { ok: false, error: uploadError.message };
  }

  const { data } = supabase.storage.from(ARTICLE_IMAGES_BUCKET).getPublicUrl(path);
  if (!data.publicUrl) {
    return { ok: false, error: "공개 URL을 가져오지 못했습니다." };
  }

  // 내용 해시를 쿼리로 붙인다. Storage는 이 파라미터를 무시하고 같은 파일을 주지만,
  // 브라우저·CDN에는 **다른 주소**라서 새 이미지를 받는다.
  const url = `${data.publicUrl}?v=${versionOf(imageBuffer)}`;
  return { ok: true, url, path, extension: prepared.extension };
}
