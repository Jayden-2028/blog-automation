// 인스타 게시물 -> 주제 순위. 순수 함수만 둔다(외부 호출 없음, 테스트 가능).
//
// 설계 판단(2026-09-21):
//
// 1) 페이지 크기 정규화는 **팔로워로 나누지 않는다.** 흔한 방식이지만 작은 계정을 구조적으로
//    과대평가한다(팔로워가 적을수록 참여율이 높게 나온다). 대신 **그 계정 자신의 평소 수준**과
//    비교한다 - 5만 팔로워 페이지에서 평소의 8배가 나온 게시물이, 100만 페이지에서 평소만큼
//    나온 게시물보다 강한 신호다.
//
// 2) 팔로워는 버리지 않고 **도달 보정**으로만 다시 넣는다. 같은 8배라도 100만 페이지 쪽이
//    실제로 더 많은 사람에게 닿는다. 단 선형으로 넣으면 큰 페이지가 전부 이기므로 log10을 쓴다.
//
// 3) 댓글 가중치를 좋아요보다 높게 둔다. 좋아요는 스크롤 중 반사적으로 눌리지만 댓글은 비용이
//    든다. 게다가 "이게 무슨 일이야?" 같은 댓글은 **검색 의도의 직접 신호**다.
//
// 4) 가장 강한 신호는 **교차 등장**이다. 한 페이지에서 터진 건 그 페이지 취향일 수 있지만,
//    서로 다른 5개 페이지가 같은 날 같은 주제를 올리면 확산 중이라는 뜻이다.
//
// 5) 마지막에 **검색 수요**로 보정한다. 인스타 반응은 구글 디스커버를 잘 예측하지만 검색 수요는
//    예측하지 못한다(밈·감성 짤은 반응만 좋고 검색으로 안 이어진다). 블로그스팟 트래픽은
//    검색과 디스커버 양쪽에서 오므로 두 축을 곱한다.

import type { PostSignal, RankedTopic, TopicCandidate } from "./types.js";

export const SCORING = {
  /** 댓글 1개 = 좋아요 몇 개로 칠 것인가. 데모 결과를 보고 조정한다. */
  commentWeight: 3,
  /** 이상치 배수 상한. 평소 수준이 0에 가까운 계정에서 값이 폭주하는 것을 막는다. */
  maxOutlier: 20,
  /** 반감기(시간). 48시간 창에서 갓 올라온 게시물을 우대한다. */
  halfLifeHours: 24,
  /** 교차 등장 보너스: 페이지 수가 n일 때 곱해지는 값 = 1 + crossPageBonus x (n - 1). */
  crossPageBonus: 0.6,
  /** 기회도(검색 수요) 반영 강도. 0이면 소셜만, 1이면 기회도가 0일 때 점수가 0이 된다. */
  opportunityWeight: 0.5,
} as const;

/** 좋아요 + 댓글x가중치. 이 파이프라인이 얻을 수 있는 유일한 반응 지표다. */
export function engagementOf(post: Pick<PostSignal, "likes" | "comments">): number {
  return post.likes + post.comments * SCORING.commentWeight;
}

/** 계정의 "평소 수준"(중앙값). 평균이 아니라 중앙값인 이유는 한 건의 대박이 기준선을 끌어올리기 때문이다. */
export function medianEngagement(posts: Array<Pick<PostSignal, "likes" | "comments">>): number {
  if (posts.length === 0) return 0;
  const sorted = posts.map(engagementOf).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** 평소 대비 몇 배인가. 기준선이 없으면(신생 계정 등) 1로 본다 - 모르는 것을 대박으로 치지 않는다. */
export function outlierRatio(post: PostSignal): number {
  if (!Number.isFinite(post.accountBaseline) || post.accountBaseline <= 0) return 1;
  return Math.min(SCORING.maxOutlier, engagementOf(post) / post.accountBaseline);
}

/** 최신성 감쇠. 24시간마다 절반. */
export function recencyDecay(timestamp: string, now: Date = new Date()): number {
  const hours = (now.getTime() - new Date(timestamp).getTime()) / 36e5;
  if (!Number.isFinite(hours) || hours < 0) return 1;
  return Math.pow(0.5, hours / SCORING.halfLifeHours);
}

/** 도달 보정. 팔로워 1천 = 1.0, 100만 = 2.0 정도로 완만하게 벌어진다. */
export function reachProxy(followers: number): number {
  if (!Number.isFinite(followers) || followers <= 0) return 1;
  return Math.max(1, Math.log10(followers) / 3);
}

export function scorePost(post: PostSignal, now: Date = new Date()): number {
  return outlierRatio(post) * reachProxy(post.followers) * recencyDecay(post.timestamp, now);
}

/**
 * 주제 단위 소셜 점수. 게시물 점수 합 x 교차 등장 보너스.
 *
 * 합을 쓰는 이유: 같은 주제를 여러 페이지가 다루면 그 자체가 신호다(평균을 쓰면 희석된다).
 * 다만 한 페이지가 같은 주제로 3건을 연달아 올린 경우까지 3배가 되면 안 되므로,
 * 보너스는 **게시물 수가 아니라 서로 다른 페이지 수**로 계산한다.
 */
export function socialScoreOf(topic: TopicCandidate, now: Date = new Date()): { score: number; pageCount: number } {
  const base = topic.posts.reduce((sum, post) => sum + scorePost(post, now), 0);
  const pageCount = new Set(topic.posts.map((post) => post.username)).size;
  const bonus = 1 + SCORING.crossPageBonus * Math.max(0, pageCount - 1);
  return { score: base * bonus, pageCount };
}

/**
 * 최종 점수 = 소셜 x (1 - w + w x 기회도).
 *
 * 기회도를 그대로 곱하지 않는 이유: 포화도 조회가 실패하거나(null) 값이 0이어도 소셜 신호가
 * 통째로 사라지면 안 된다. w만큼만 영향을 준다.
 */
export function applyOpportunity(socialScore: number, opportunity: number | null): number {
  const w = SCORING.opportunityWeight;
  if (opportunity === null) return socialScore * (1 - w / 2); // 모르면 중간 정도로 깎는다
  return socialScore * (1 - w + w * opportunity);
}

function describe(topic: TopicCandidate, pageCount: number, blogTotal: number | null, topPost: PostSignal | null): string {
  const parts: string[] = [];
  parts.push(pageCount > 1 ? `${pageCount}개 페이지 동시 등장` : "단일 페이지");
  if (topPost) {
    const ratio = outlierRatio(topPost);
    parts.push(`@${topPost.username} 평소의 ${ratio.toFixed(1)}배`);
  }
  parts.push(blogTotal === null ? "블로그 글 수 미확인" : `블로그 글 ${blogTotal.toLocaleString()}건`);
  return parts.join(" · ");
}

export type RankInput = {
  topics: TopicCandidate[];
  /** query -> 블로그 문서 총 개수. 조회 실패는 null. */
  blogTotals?: Map<string, number | null>;
  /** query -> 기회도(0~1). computeOpportunityRatio 결과를 그대로 받는다. */
  opportunities?: Map<string, number | null>;
  now?: Date;
  limit?: number;
};

export function rankInstagramTopics(input: RankInput): RankedTopic[] {
  const now = input.now ?? new Date();
  const limit = input.limit ?? 20;

  const ranked = input.topics.map((topic): RankedTopic => {
    const { score: socialScore, pageCount } = socialScoreOf(topic, now);
    const blogTotal = input.blogTotals?.get(topic.query) ?? null;
    const opportunity = input.opportunities?.get(topic.query) ?? null;
    const topPost = [...topic.posts].sort((a, b) => scorePost(b, now) - scorePost(a, now))[0] ?? null;

    return {
      ...topic,
      socialScore,
      pageCount,
      blogTotal,
      opportunity,
      finalScore: applyOpportunity(socialScore, opportunity),
      reason: describe(topic, pageCount, blogTotal, topPost),
    };
  });

  return ranked.sort((a, b) => b.finalScore - a.finalScore).slice(0, limit);
}
