// 캡처 결과 -> InstagramCaptureResult 검증·정규화.
//
// 왜 필요한가: createInstagramJob은 이 값을 그대로 믿고 article_jobs에 쓴다. 자동 경로와 수동
// CLI(ig:create-job)가 **같은 검사**를 통과해야 잘못된 job이 조용히 생기지 않는다 - row가 생긴
// 뒤에는 되돌리기가 번거롭다.
//
// 검사는 모아서 보고한다 - 하나 고치고 다시 돌리고를 반복하지 않게.
//
// 2026-09-23 재설계로 images 검증이 사라졌다. 게시물 사진을 원고에 쓰지 않으므로 캡처 결과에
// 이미지가 없다.

import type { InstagramCaptureResult } from "./types.js";

/** article_jobs.category에 들어갈 수 있는 값(keywordCategoryRules.ts의 KeywordCategory와 같다). */
export const VALID_CATEGORIES = ["incident", "entertainment", "ott", "parenting", "living", "community"] as const;

export type ParseResult =
  | { ok: true; capture: InstagramCaptureResult; warnings: string[] }
  | { ok: false; errors: string[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** 문자열이면 다듬어 돌려주고, 아니거나 비면 null. */
function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** 값을 검증해 InstagramCaptureResult로 만든다. */
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
    },
  };
}
