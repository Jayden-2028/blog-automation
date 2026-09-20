// 점수 로직의 불변식 테스트. 외부 호출 없음. 실행: npm run test:ig-score
import {
  applyOpportunity,
  engagementOf,
  medianEngagement,
  outlierRatio,
  rankInstagramTopics,
  recencyDecay,
  reachProxy,
  socialScoreOf,
  SCORING,
} from "./scoreInstagramTopics.js";
import type { PostSignal, TopicCandidate } from "./types.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const NOW = new Date("2026-09-21T12:00:00Z");

function post(over: Partial<PostSignal> = {}): PostSignal {
  return {
    username: "page_a",
    followers: 100_000,
    accountBaseline: 1_000,
    postId: "p1",
    caption: "캡션",
    permalink: "https://instagram.com/p/1",
    timestamp: NOW.toISOString(),
    likes: 1_000,
    comments: 0,
    ...over,
  };
}

function topic(posts: PostSignal[], over: Partial<TopicCandidate> = {}): TopicCandidate {
  return { label: "주제", category: "etc", query: "주제", posts, ...over };
}

// 1) 댓글이 좋아요보다 무겁다 - 검색 의도의 신호라서.
{
  assert(engagementOf({ likes: 0, comments: 1 }) === SCORING.commentWeight, "댓글 가중치가 적용돼야 한다");
  assert(engagementOf({ likes: 10, comments: 2 }) === 10 + 2 * SCORING.commentWeight, "합산이 맞아야 한다");
  console.log("✅ 댓글 가중치");
}

// 2) 중앙값을 쓴다 - 한 건의 대박이 기준선을 끌어올리면 그 페이지의 다음 대박을 못 잡는다.
{
  const posts = [{ likes: 10, comments: 0 }, { likes: 20, comments: 0 }, { likes: 10_000, comments: 0 }];
  assert(medianEngagement(posts) === 20, `중앙값이어야 한다 (${medianEngagement(posts)})`);
  assert(medianEngagement([]) === 0, "빈 배열은 0");
  console.log("✅ 평소 수준은 중앙값(평균 아님)");
}

// 3) 핵심 불변식: 작은 페이지의 대박이 큰 페이지의 평작을 이긴다.
{
  const small = post({ username: "small", followers: 50_000, accountBaseline: 500, likes: 4_000 });
  const big = post({ username: "big", followers: 1_000_000, accountBaseline: 20_000, likes: 20_000 });
  assert(outlierRatio(small) === 8, `작은 페이지는 평소의 8배 (${outlierRatio(small)})`);
  assert(outlierRatio(big) === 1, `큰 페이지는 평소만큼 (${outlierRatio(big)})`);
  const s = socialScoreOf(topic([small]), NOW).score;
  const b = socialScoreOf(topic([big]), NOW).score;
  assert(s > b, `작은 페이지의 대박이 이겨야 한다 (${s.toFixed(2)} vs ${b.toFixed(2)})`);
  console.log("✅ 팔로워가 아니라 '평소 대비'로 정규화");
}

// 4) 같은 이상치 배수라면 큰 페이지가 이긴다 - 실제 도달이 다르므로.
{
  const small = post({ username: "s", followers: 10_000, accountBaseline: 100, likes: 800 });
  const big = post({ username: "b", followers: 1_000_000, accountBaseline: 10_000, likes: 80_000 });
  assert(outlierRatio(small) === outlierRatio(big), "배수는 같아야 한다");
  assert(reachProxy(big.followers) > reachProxy(small.followers), "도달 보정은 큰 페이지가 커야 한다");
  console.log("✅ 배수가 같으면 도달로 갈린다");
}

// 5) 기준선이 없으면 대박으로 치지 않는다(모르는 것을 우대하면 안 된다).
{
  assert(outlierRatio(post({ accountBaseline: 0, likes: 999_999 })) === 1, "기준선 0이면 1배로 본다");
  assert(outlierRatio(post({ accountBaseline: 1, likes: 999_999 })) === SCORING.maxOutlier, "상한이 걸려야 한다");
  console.log("✅ 기준선 없음/폭주 방어");
}

// 6) 교차 등장이 가장 강한 신호. 같은 페이지가 3건 올린 것은 3배가 아니다.
{
  const one = topic([post({ username: "a", postId: "1" }), post({ username: "a", postId: "2" })]);
  const three = topic([post({ username: "a" }), post({ username: "b" }), post({ username: "c" })]);
  const r1 = socialScoreOf(one, NOW);
  const r3 = socialScoreOf(three, NOW);
  assert(r1.pageCount === 1, "같은 페이지 2건은 페이지 1개");
  assert(r3.pageCount === 3, "3개 페이지");
  assert(r3.score > r1.score * 1.5, `교차 등장이 크게 우대돼야 한다 (${r1.score.toFixed(1)} vs ${r3.score.toFixed(1)})`);
  console.log("✅ 교차 등장 보너스는 게시물 수가 아니라 페이지 수 기준");
}

// 7) 최신성 감쇠.
{
  assert(Math.abs(recencyDecay(NOW.toISOString(), NOW) - 1) < 1e-9, "방금 올라온 것은 1");
  const day = new Date(NOW.getTime() - SCORING.halfLifeHours * 36e5).toISOString();
  assert(Math.abs(recencyDecay(day, NOW) - 0.5) < 1e-9, "반감기에서 0.5");
  console.log("✅ 최신성 감쇠");
}

// 8) 검색 수요 보정: 포화도 조회 실패가 소셜 신호를 통째로 없애면 안 된다.
{
  const high = applyOpportunity(100, 1);
  const low = applyOpportunity(100, 0);
  const unknown = applyOpportunity(100, null);
  assert(high > unknown && unknown > low, `미확인은 중간이어야 한다 (${low} < ${unknown} < ${high})`);
  assert(low > 0, "기회도 0이어도 점수가 0이 되면 안 된다");
  console.log("✅ 기회도 보정 - 미확인은 중간, 0이어도 소멸하지 않음");
}

// 9) 전체 랭킹: 반응만 좋고 이미 포화된 주제보다, 반응이 조금 낮아도 빈 주제가 위로 온다.
{
  const buzzy = topic([post({ username: "a", likes: 6_000 })], { label: "포화 주제", query: "포화" });
  const fresh = topic([post({ username: "b", likes: 5_000 })], { label: "빈 주제", query: "빈틈" });
  const ranked = rankInstagramTopics({
    topics: [buzzy, fresh],
    opportunities: new Map([["포화", 0], ["빈틈", 1]]),
    now: NOW,
  });
  assert(ranked[0].label === "빈 주제", `기회도가 순위를 뒤집어야 한다 (${ranked.map((r) => r.label).join(", ")})`);
  assert(ranked[0].reason.includes("평소의"), "근거 문장에 배수가 들어가야 한다");
  console.log("✅ 소셜 x 기회도 - 포화된 주제를 뒤로 민다");
}

// 10) limit이 지켜진다.
{
  const many = Array.from({ length: 40 }, (_, i) => topic([post({ postId: `p${i}` })], { label: `t${i}`, query: `q${i}` }));
  assert(rankInstagramTopics({ topics: many, now: NOW }).length === 20, "기본 20개");
  console.log("✅ top 20 제한");
}

console.log("\n🎉 인스타 점수 로직 테스트 통과");
