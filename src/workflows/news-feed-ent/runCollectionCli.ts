// 연예 뉴스 피드 수집을 단독 실행하는 CLI. `npm run collect:news-feed-ent`
//
// **기본이 dry-run이고, LLM도 부르지 않는다.** 실제 trend_candidates 쓰기는 WRITE=1,
// LLM 이슈 구 생성은 LLM=1을 명시해야 한다 - 원격 DB 쓰기는 승인 대상이고(collect:daum-realtime과
// 같은 규약), 이슈 구는 LLM 없이도 공유 토큰 폴백으로 볼 수 있어 비용 0으로 품질을 먼저 본다.
//
// 사용 예:
//   npm run collect:news-feed-ent                    # 조회 + 구 생성(폴백만) + 매핑, DB 쓰기 없음
//   LLM=1 npm run collect:news-feed-ent              # LLM 구까지 비교
//   WRITE=1 LLM=1 npm run collect:news-feed-ent      # 실제 upsert (승인 후)
//
// 소스가 꺼져 있어도(ENT_NEWS_FEED_ENABLED 미설정) 이 CLI는 enabled: true로 강제해 돌린다 -
// 켜기 전에 무엇이 들어올지 보는 것이 이 CLI의 용도다.

import { fetchNewsFeedEnt } from "../../services/search/providers/newsFeedEnt/NewsFeedEntProvider.js";
import { TREND_SOURCE_CONFIGS } from "../../config/trendSources.js";
import { buildIssuePhraseFromStory, matchDaumRanking } from "./newsFeedIssuePhrase.js";
import { runNewsFeedEntCollection } from "./runNewsFeedEntCollection.js";

const write = process.env.WRITE === "1";
const useLlm = process.env.LLM === "1";

async function main(): Promise<void> {
  console.log(`▶ 연예 뉴스 피드 수집 (${write ? "WRITE" : "dry-run"}, 이슈 구 ${useLlm ? "LLM" : "폴백만"})\n`);

  const fetched = await fetchNewsFeedEnt();
  for (const [source, error] of Object.entries(fetched.sourceErrors)) {
    console.error(`⚠️ "${source}" 조회 실패 - ${error}`);
  }
  console.log(`Google 스토리 ${fetched.stories.length}건 · 다음 랭킹 ${fetched.daumRanking.length}건\n`);

  const matched = matchDaumRanking(fetched.stories, fetched.daumRanking);
  const max = TREND_SOURCE_CONFIGS.news_feed_ent.maxDailyCandidates;

  const ranked = [...fetched.stories].sort((a, b) => {
    const rankA = matched.byLeadTitle.get(a.leadTitle)?.daumRank ?? Number.POSITIVE_INFINITY;
    const rankB = matched.byLeadTitle.get(b.leadTitle)?.daumRank ?? Number.POSITIVE_INFINITY;
    if (rankA !== rankB) return rankA - rankB;
    return a.feedPosition - b.feedPosition;
  });

  console.log(`상위 ${max}건(다음 순위 먼저, 그 뒤 피드 순서):`);
  ranked.slice(0, max).forEach((story, index) => {
    const daum = matched.byLeadTitle.get(story.leadTitle);
    const where = daum ? `다음 ${daum.daumRank}위` : `피드 ${story.feedPosition}번`;
    console.log(`  ${String(index + 1).padStart(2)}. [${where} · 매체 ${story.outletCount}곳] ${buildIssuePhraseFromStory(story)}`);
    console.log(`      ← ${story.leadTitle}`);
  });

  if (matched.unmatched.length > 0) {
    console.log(`\n다음 랭킹 중 Google 클러스터와 못 맞춘 ${matched.unmatched.length}건(시드 미생성):`);
    for (const item of matched.unmatched) console.log(`  ${item.rank}위 ${item.title}`);
  }

  const result = await runNewsFeedEntCollection({
    enabled: true,
    dryRun: !write,
    ...(useLlm ? {} : { buildPhrases: false as const }),
  });

  console.log("\n결과:", {
    ...result,
    daumUnmatched: `${result.daumUnmatched.length}건`,
  });
  if (result.status === "failed") process.exitCode = 1;
}

await main();
