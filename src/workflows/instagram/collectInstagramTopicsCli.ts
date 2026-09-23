// 인스타 기반 키워드 수집 전체 흐름을 한 번 도는 진입점(데모 단계).
//
//   게시물 수집 -> 주제 추출·클러스터링(LLM) -> 블로그 포화도 조회 -> 점수 -> HTML
//
// --fixture: Meta 토큰 없이 가짜 데이터로 전체 흐름을 돌린다. 토큰 발급이 막혀 있는 동안
//            로직과 화면을 먼저 확정하기 위한 경로다. 블로그 포화도는 **실제로 조회**한다
//            (fixture 주제를 실재 소재로 고른 이유 - 숫자가 의미를 갖는다).
//
// 사용: npm run ig:collect -- --fixture
//       npm run ig:collect              (토큰이 준비된 뒤 실제 수집)
import "dotenv/config";

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { PIPELINE_ROOT } from "../../config/pipelinePaths.js";
import { activeInstagramSources } from "../../config/instagramSources.js";
import { BusinessDiscoveryClient } from "../../services/instagram/BusinessDiscoveryClient.js";
import { fetchBlogDocumentTotal } from "../../services/search/naver/fetchBlogTotal.js";
import { computeOpportunityRatio } from "../keyword-ranking/computeCompetitionScore.js";
import { extractTopics } from "./extractTopics.js";
import { medianEngagement, rankInstagramTopics } from "./scoreInstagramTopics.js";
import { renderInstagramTopicsPage } from "./renderInstagramTopicsPage.js";
import type { PostSignal } from "./types.js";

const RECENT_WINDOW_HOURS = 48;
const OUTPUT_PATH = resolve(PIPELINE_ROOT, "reports", "instagram-topics.html");
/** 포화도 조회는 주제당 1회. 상위 몇 개까지 볼지 - 네이버 rate limit 보호. */
const SATURATION_LIMIT = 30;

type Fixture = {
  accounts: Array<{ username: string; followers: number; baselinePosts: number[] }>;
  posts: Array<{ username: string; hoursAgo: number; likes: number; comments: number; caption: string }>;
};

async function loadFixturePosts(): Promise<PostSignal[]> {
  const path = resolve(PIPELINE_ROOT, "src/workflows/instagram/fixtures/sampleDay.json");
  const fixture = JSON.parse(await readFile(path, "utf8")) as Fixture;

  const byName = new Map(fixture.accounts.map((a) => [a.username, a]));
  return fixture.posts.map((post, i) => {
    const account = byName.get(post.username);
    // baselinePosts는 "좋아요 상당" 값이라 댓글 0으로 환산해 중앙값을 낸다.
    const baseline = medianEngagement((account?.baselinePosts ?? []).map((likes) => ({ likes, comments: 0 })));
    return {
      username: post.username,
      followers: account?.followers ?? 0,
      accountBaseline: baseline,
      postId: `fixture-${i + 1}`,
      caption: post.caption,
      permalink: `https://www.instagram.com/${post.username}/`,
      timestamp: new Date(Date.now() - post.hoursAgo * 36e5).toISOString(),
      likes: post.likes,
      comments: post.comments,
    };
  });
}

async function loadLivePosts(): Promise<PostSignal[]> {
  const client = new BusinessDiscoveryClient();
  const configError = client.missingConfig();
  if (configError) throw new Error(`${configError} (토큰 없이 보려면 --fixture)`);

  const signals: PostSignal[] = [];
  for (const source of activeInstagramSources()) {
    const result = await client.fetchAccount(source.username);
    if (!result.ok) {
      console.warn(`⚠️ @${source.username} 건너뜀: ${result.hint ?? result.error}`);
      continue;
    }

    // 기준선은 **수집한 전체**로 낸다(최근 48시간만으로 내면 대박 하나가 기준선이 된다).
    const baseline = medianEngagement(
      result.media.map((m) => ({ likes: m.like_count ?? 0, comments: m.comments_count ?? 0 }))
    );

    for (const media of result.media) {
      const hours = (Date.now() - new Date(media.timestamp).getTime()) / 36e5;
      if (hours > RECENT_WINDOW_HOURS) continue;
      signals.push({
        username: source.username,
        followers: result.followersCount,
        accountBaseline: baseline,
        postId: media.id,
        caption: media.caption ?? "",
        permalink: media.permalink,
        timestamp: media.timestamp,
        likes: media.like_count ?? 0,
        comments: media.comments_count ?? 0,
      });
    }
  }
  return signals;
}

async function main(): Promise<void> {
  const useFixture = process.argv.includes("--fixture");

  console.log(useFixture ? "▶ fixture 모드(토큰 없이 전체 흐름 점검)\n" : "▶ 실제 수집\n");

  const posts = useFixture ? await loadFixturePosts() : await loadLivePosts();
  console.log(`· 최근 ${RECENT_WINDOW_HOURS}시간 게시물 ${posts.length}건 / 페이지 ${new Set(posts.map((p) => p.username)).size}개`);
  if (posts.length === 0) {
    console.error("❌ 게시물이 없습니다.");
    process.exitCode = 1;
    return;
  }

  console.log("· 주제 추출·클러스터링 중(LLM 1회)...");
  const extracted = await extractTopics(posts);
  if (extracted.status === "failed") {
    console.error(`❌ 주제 추출 실패: ${extracted.error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`· 주제 ${extracted.topics.length}건 (${Math.round(extracted.durationMs / 1000)}초)`);

  // 블로그 포화도. 실패해도 순위는 나온다(점수에서 "미확인"으로 처리된다).
  const blogTotals = new Map<string, number | null>();
  const opportunities = new Map<string, number | null>();
  const targets = extracted.topics.slice(0, SATURATION_LIMIT);
  console.log(`· 블로그 포화도 조회 ${targets.length}건...`);
  for (const topic of targets) {
    const total = await fetchBlogDocumentTotal(topic.query).catch(() => null);
    blogTotals.set(topic.query, total);
    // 수요 신호는 데모에서 중립값(0.5)으로 둔다 - 인스타 반응 자체가 수요 신호라 이중 계산을
    // 피하고, 실제 검색량 연동은 probe 이후 별도로 붙인다.
    opportunities.set(topic.query, total === null ? null : computeOpportunityRatio(total, 0.5));
  }

  const ranked = rankInstagramTopics({ topics: extracted.topics, blogTotals, opportunities });

  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, renderInstagramTopicsPage(ranked), "utf8");

  console.log(`\n── top ${Math.min(10, ranked.length)} ${"─".repeat(40)}`);
  ranked.slice(0, 10).forEach((topic, i) => {
    console.log(`${String(i + 1).padStart(2)}. [${topic.category}] ${topic.label}`);
    console.log(`    ${topic.finalScore.toFixed(1)}점 · ${topic.reason}`);
  });
  console.log(`\n✅ ${OUTPUT_PATH}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
