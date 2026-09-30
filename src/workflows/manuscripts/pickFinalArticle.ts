// 이 job의 **최종 원고** article을 고른다(2026-09-30 - 배리에이션 단계 폐지).
//
// 작성 단계 원고(platform=null)가 곧 최종본이다. 다만 배리에이션 시절에 이미 만든
// platform="blogspot" 원고가 기준 원고보다 새것이면(그 원고 기준으로 이미지가 채워졌다) 그것을 쓴다.
// 수정 반영(job:revise)은 기준 원고 row를 새로 만들므로, 그 경우엔 기준 원고가 더 새것이라 기준 원고를 쓴다.

import type { ArticleRow } from "../../types/database.js";

export const LEGACY_BLOGSPOT_PLATFORM = "blogspot";

export function pickFinalArticle(articles: ArticleRow[]): { final: ArticleRow; base: ArticleRow; legacyVariant: ArticleRow | null } | null {
  const base = [...articles].reverse().find((article) => article.platform == null);
  if (!base) return null;
  const variant = [...articles].reverse().find((article) => article.platform === LEGACY_BLOGSPOT_PLATFORM) ?? null;
  const legacyVariant = variant && variant.id > base.id ? variant : null;
  return { final: legacyVariant ?? base, base, legacyVariant };
}
