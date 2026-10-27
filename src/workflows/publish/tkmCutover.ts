// Korea Plain 맞춤 도메인 전환(2026-10-28) - DB에 남은 옛 blogspot 주소를 공개 주소로 바꾸는 순수 함수.
// CLI(tkmCutoverUrlsCli.ts)가 Supabase를 읽고 쓰고, 여기는 값 변환만 한다(테스트 대상).
//
// 바꾸는 것은 **호스트뿐**이다(경로·쿼리·해시 그대로). 구 주소는 Blogger가 301로 넘기는 소스라 지우지 않는다 -
// DB 기록만 공개 주소로 맞춘다. 규칙은 config/publishTargets.ts의 normalizeTkmUrl·rewriteTkmLegacyUrls 하나다.

import { rewriteTkmLegacyUrls } from "../../config/publishTargets.js";

export type LegacyHit = { path: string; before: string; after: string };

/**
 * JSON 값 안의 문자열에서 옛 blogspot 절대 URL을 찾아 공개 주소로 바꾼다. 원본은 건드리지 않고 새 값을 돌려준다.
 * hits는 바뀐 문자열의 위치(`bingSubmit.urls[0]` 꼴)와 전후 값 - dry-run 표에 쓴다.
 */
export function rewriteLegacyUrlsDeep(value: unknown, path = ""): { value: unknown; hits: LegacyHit[] } {
  if (typeof value === "string") {
    const { text, count } = rewriteTkmLegacyUrls(value);
    return count > 0 ? { value: text, hits: [{ path, before: value, after: text }] } : { value, hits: [] };
  }
  if (Array.isArray(value)) {
    const hits: LegacyHit[] = [];
    const next = value.map((item, index) => {
      const result = rewriteLegacyUrlsDeep(item, `${path}[${index}]`);
      hits.push(...result.hits);
      return result.value;
    });
    return hits.length > 0 ? { value: next, hits } : { value, hits };
  }
  if (value && typeof value === "object") {
    const hits: LegacyHit[] = [];
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const result = rewriteLegacyUrlsDeep(item, path ? `${path}.${key}` : key);
      hits.push(...result.hits);
      next[key] = result.value;
    }
    return hits.length > 0 ? { value: next, hits } : { value, hits };
  }
  return { value, hits: [] };
}

/** 경로의 배열 첨자를 걷은 필드 이름(`bingSubmit.urls[0]` → `bingSubmit.urls`). 필드별 집계용. */
export function fieldOf(path: string): string {
  return path.replace(/\[\d+\]/g, "[]");
}

/** metadata 최상위 키 중 바뀐 것만 담은 patch(mergeMetadata는 최상위 병합이라 바뀐 키만 보내면 된다). */
export function changedTopLevel(before: Record<string, unknown>, after: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(after)) {
    if (before[key] !== value) patch[key] = value;
  }
  return patch;
}
