// 네이버 발행본 <-> 파이프라인 원고 짝짓기. 점수는 제목 유사도 + 키워드 적중 + 본문 3-gram 겹침의 가중합이다.
import { diceSimilarity, ngramContainment, ngramJaccard, normalizeForCompare } from "./text.js";

export const MATCH_WINDOW_DAYS = 4;
/** 이 점수 이상이어야 짝으로 본다. 2026-10-29 dry-run 실측으로 정했다(STYLE-LEARN 문서/보고서 참고). */
export const MATCH_THRESHOLD = 0.3;

export type MatchPost = { id: string; title: string; publishedDate: string; text: string };
export type MatchArticle = { id: number; title: string; keyword: string; createdDate: string; text: string };

export type MatchScore = {
  articleId: number;
  score: number;
  titleDice: number;
  keywordHit: number;
  bodyJaccard: number;
  bodyContainment: number;
  dayGap: number;
};

export type PostMatch = { postId: string; best: MatchScore | null; matched: boolean; runnerUp: MatchScore | null };

export function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000);
}

/** 키워드 토큰(2자 이상) 중 글(제목+본문)에 든 비율. */
export function keywordHitRatio(keyword: string, haystack: string): number {
  const tokens = keyword.split(/[\s,·/]+/).map((t) => t.trim()).filter((t) => t.length >= 2);
  if (tokens.length === 0) return 0;
  const hay = normalizeForCompare(haystack);
  return tokens.filter((t) => hay.includes(normalizeForCompare(t))).length / tokens.length;
}

export function scorePair(post: MatchPost, article: MatchArticle): MatchScore {
  const titleDice = diceSimilarity(post.title, article.title);
  const keywordHit = keywordHitRatio(article.keyword, `${post.title} ${post.text}`);
  const bodyJaccard = ngramJaccard(post.text, article.text);
  const bodyContainment = ngramContainment(post.text, article.text);
  // 본문 겹침이 가장 믿을 만하다(제목은 사용자가 전건 재작성한다). 키워드는 후보를 거르는 보조 신호.
  const score = 0.2 * titleDice + 0.1 * keywordHit + 0.35 * bodyJaccard + 0.35 * bodyContainment;
  return { articleId: article.id, score, titleDice, keywordHit, bodyJaccard, bodyContainment, dayGap: dayDiff(post.publishedDate, article.createdDate) };
}

/**
 * 글마다 창(±4일) 안 후보 중 최고 점수를 고른다. 같은 원고가 두 글에 걸리면 점수가 높은 글이 가져간다(1:1).
 * 임계 미만이면 matched=false(사용자 순수작).
 */
export function matchPosts(posts: MatchPost[], articles: MatchArticle[], options: { threshold?: number; windowDays?: number } = {}): PostMatch[] {
  const threshold = options.threshold ?? MATCH_THRESHOLD;
  const windowDays = options.windowDays ?? MATCH_WINDOW_DAYS;
  const scored = posts.map((post) => {
    const cands = articles
      .filter((a) => Math.abs(dayDiff(post.publishedDate, a.createdDate)) <= windowDays)
      .map((a) => scorePair(post, a))
      .sort((x, y) => y.score - x.score);
    return { post, cands };
  });

  // 전역 탐욕 배정: 모든 (글,원고) 점수 내림차순으로 훑으며 둘 다 비었을 때만 확정.
  const all = scored.flatMap(({ post, cands }) => cands.map((c) => ({ postId: post.id, c })));
  all.sort((x, y) => y.c.score - x.c.score);
  const takenPost = new Set<string>();
  const takenArticle = new Set<number>();
  const assigned = new Map<string, MatchScore>();
  for (const { postId, c } of all) {
    if (c.score < threshold) break;
    if (takenPost.has(postId) || takenArticle.has(c.articleId)) continue;
    takenPost.add(postId);
    takenArticle.add(c.articleId);
    assigned.set(postId, c);
  }
  return scored.map(({ post, cands }) => {
    const hit = assigned.get(post.id) ?? null;
    const best = hit ?? cands[0] ?? null;
    const runnerUp = cands.find((c) => c.articleId !== best?.articleId) ?? null;
    return { postId: post.id, best, matched: hit !== null, runnerUp };
  });
}
