// 캡처 세션이 쓴 JSON -> InstagramCaptureResult 검증·정규화.
//
// 왜 필요한가: createInstagramJob은 InstagramCaptureResult를 그대로 믿고 DB에 쓰고 이미지를
// 업로드한다. 그런데 이 타입을 만드는 코드는 없다 - 브라우저 캡처를 수행한 세션이 손으로 채운다.
// 필드가 12개라 오타 하나가 "job은 생겼는데 이미지가 0장"으로 끝나고, 그때는 이미 article_jobs
// row가 생긴 뒤라 되돌리기가 번거롭다. 그래서 **쓰기 전에** 전부 검사한다.
//
// 검사는 모아서 보고한다 - 하나 고치고 다시 돌리고를 반복하지 않게.

import type { InstagramCandidateImage, InstagramCaptureResult } from "./types.js";

/** article_jobs.category에 들어갈 수 있는 값(keywordCategoryRules.ts의 KeywordCategory와 같다). */
export const VALID_CATEGORIES = ["incident", "entertainment", "ott", "parenting", "living", "community"] as const;

const VALID_KINDS = ["instagram_capture", "web_alternative"] as const;

export type ParseResult =
  | { ok: true; capture: InstagramCaptureResult; warnings: string[] }
  | { ok: false; errors: string[] };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function readString(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

function parseImage(raw: unknown, i: number, errors: string[]): InstagramCandidateImage | null {
  const where = `images[${i}]`;
  if (!isPlainObject(raw)) {
    errors.push(`${where}: 객체가 아닙니다.`);
    return null;
  }

  const slideIndex = raw.slideIndex;
  if (typeof slideIndex !== "number" || !Number.isInteger(slideIndex) || slideIndex < 1) {
    errors.push(`${where}.slideIndex: 1 이상의 정수여야 합니다(받은 값: ${JSON.stringify(slideIndex)}).`);
  }

  const kind = raw.kind;
  if (typeof kind !== "string" || !VALID_KINDS.includes(kind as (typeof VALID_KINDS)[number])) {
    errors.push(`${where}.kind: ${VALID_KINDS.join(" 또는 ")} 중 하나여야 합니다(받은 값: ${JSON.stringify(kind)}).`);
  }

  const localPath = readString(raw.localPath);
  if (!localPath) errors.push(`${where}.localPath: 비어 있습니다 - 캡처한 파일 경로가 필요합니다.`);

  // 웹 대체 이미지는 출처가 근거다. 없으면 나중에 "어디서 가져왔더라"가 되고, 저작권 판단을
  // 사람이 하기로 한 정책(INSTAGRAM_POSTING_CONVERTER.md)의 근거가 사라진다.
  if (kind === "web_alternative" && !readString(raw.sourcePage)) {
    errors.push(`${where}.sourcePage: web_alternative는 출처 페이지가 필요합니다.`);
  }

  if (errors.length > 0) return null;

  return {
    slideIndex: slideIndex as number,
    kind: kind as InstagramCandidateImage["kind"],
    localPath: localPath as string,
    sourcePage: readString(raw.sourcePage),
    note: readString(raw.note),
  };
}

/** JSON.parse된 값을 검증해 InstagramCaptureResult로 만든다. 파일 존재 확인은 호출부가 한다. */
export function parseCaptureFile(raw: unknown): ParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!isPlainObject(raw)) return { ok: false, errors: ["최상위가 JSON 객체가 아닙니다."] };

  const queueEntryId = readString(raw.queueEntryId);
  if (!queueEntryId) errors.push("queueEntryId: 비어 있습니다 - ig-capture:status가 보여주는 id입니다.");

  const instagramUrl = readString(raw.instagramUrl);
  if (!instagramUrl) errors.push("instagramUrl: 비어 있습니다.");

  const searchKeyword = readString(raw.searchKeyword);
  if (!searchKeyword) errors.push("searchKeyword: 비어 있습니다 - 자료조사·원고의 주제어가 됩니다.");

  const caption = typeof raw.caption === "string" ? raw.caption : null;
  if (caption === null) errors.push("caption: 문자열이어야 합니다(캡션이 없으면 빈 문자열).");

  const burnedInRaw = raw.burnedInText;
  let burnedInText: string[] = [];
  if (!Array.isArray(burnedInRaw)) {
    errors.push("burnedInText: 배열이어야 합니다(없으면 []).");
  } else {
    const bad = burnedInRaw.findIndex((t) => typeof t !== "string");
    if (bad !== -1) errors.push(`burnedInText[${bad}]: 문자열이어야 합니다.`);
    else burnedInText = burnedInRaw.filter((t): t is string => t.trim().length > 0);
  }

  let category: string | null = null;
  if (raw.category === null || raw.category === undefined) {
    warnings.push("category가 비어 있습니다 - 집필 문체 라우팅이 기본값으로 갑니다.");
  } else if (typeof raw.category !== "string" || !VALID_CATEGORIES.includes(raw.category as never)) {
    errors.push(`category: ${VALID_CATEGORIES.join(" / ")} 중 하나거나 null이어야 합니다(받은 값: ${JSON.stringify(raw.category)}).`);
  } else {
    category = raw.category;
  }

  const imagesRaw = raw.images;
  const images: InstagramCandidateImage[] = [];
  if (!Array.isArray(imagesRaw)) {
    errors.push("images: 배열이어야 합니다(후보가 없으면 []).");
  } else {
    for (let i = 0; i < imagesRaw.length; i += 1) {
      const parsed = parseImage(imagesRaw[i], i, errors);
      if (parsed) images.push(parsed);
    }
  }

  // 후보 0장도 막지는 않는다 - 번인 텍스트만 건진 게시물이 있을 수 있다(정보 슬라이드). 다만
  // 그러면 원고의 이미지 자리는 전부 웹 검색으로 채워지므로 알고 있어야 한다.
  if (images.length === 0 && errors.length === 0) {
    warnings.push("이미지 후보가 0장입니다 - 원고 이미지 자리는 기존 웹 검색으로 채워집니다.");
  }

  const dupes = images
    .map((img) => `${img.slideIndex}/${img.kind}`)
    .filter((key, i, all) => all.indexOf(key) !== i);
  if (dupes.length > 0) {
    errors.push(`같은 slideIndex에 같은 kind가 둘 이상입니다: ${[...new Set(dupes)].join(", ")}`);
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    warnings,
    capture: {
      queueEntryId: queueEntryId as string,
      instagramUrl: instagramUrl as string,
      caption: caption as string,
      burnedInText,
      searchKeyword: searchKeyword as string,
      category,
      images,
      profileEmbedUrl: readString(raw.profileEmbedUrl),
    },
  };
}
