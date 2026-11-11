// 폴백 주제어 격리 테스트(2026-11-11, KEYWORD-ENT-REDESIGN-2026-11.md R4).
//
// 왜: 2026-11-10 run 260에서 `extractTopicQueries`가 60건 **전부** 실패했다. 폴백 주제어는 주제어가
// 아니라 제목 앞 두 어절이라(`외도 확인후`·`영화 평점`) 경쟁도 조회의 평균 blogTotal이 4,678~77,368건
// → 1,243,037건(16~265배)으로 튀었고, applyToScore가 켜져 있어 점수를 평균 −2.50점 깎았다.
//
// 지켜야 할 불변식 셋:
// 1) `scoreApplied`가 "이 항목의 점수가 실제로 바뀌었나"를 정확히 말한다(scoreAfter는 preview 값으로
//    그대로 남는다 - 관측 데이터를 잃지 않기 위함).
// 2) `BLOG_COMPETITION_SKIP_FALLBACK`이 **꺼져 있으면 지금까지와 동작이 같다.**
// 3) 폴백 주제어는 다양성 선정의 주제 동일성 판정에 **들어가지 않는다**(hard false로 단정해 버리므로).
//
// 두 env 상태를 한 프로세스에서 볼 수 없다(config가 import 시점에 env를 읽는다). 그래서
// testCompetitionRanking과 같은 방식으로 같은 파일을 env만 바꿔 두 번 돌린다.
//
// 외부 호출 없음: 경쟁도 측정기(run)를 fake로 주입한다.

process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-only-not-a-real-key";

const { rankKeywords } = await import("../dailyKeywordWorkflow.js");
const { BLOG_COMPETITION_CONFIG } = await import("../../config/keywordCompetition.js");

import type { KeywordCluster } from "./clustering/KeywordClusterer.js";
import type { KeywordCandidate } from "../../types/keywordDiscovery.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

function candidate(keyword: string, source: string, publishedAt: string): KeywordCandidate {
  return {
    keyword,
    category: "entertainment",
    source,
    trendScore: 1,
    sourceUrl: null,
    publishedAt,
    metadata: { query: keyword },
  };
}

function cluster(keyword: string): KeywordCluster<KeywordCandidate> {
  const now = new Date().toISOString();
  return {
    representativeKeyword: keyword,
    items: [
      candidate(keyword, "naver_news", now),
      candidate(keyword, "naver_blog", now),
      candidate(keyword, "naver_web", now),
    ],
  };
}

// 2026-11-10 실측 형태. 세 건이 같은 사안(젠슨 황)인데 폴백 주제어는 서로 다르다.
const JENSEN_A = "中 외도 확인후 불륜녀 포섭했나 젠슨 황 스캔들";
const JENSEN_B = "엘리스황이 누구길래 젠슨 황 옆자리 정보원 의혹 나온";
const CLEAN = "이세계아이돌 미니 2집 음원 공개";

// 폴백 주제어 = 제목 앞 두 어절. 일반어라 블로그 건수가 수십만~백만 건이다(실측 평균 1,243,037건).
const FALLBACK_QUERY: Record<string, string> = {
  [JENSEN_A]: "외도 확인후",
  [JENSEN_B]: "엘리스황이 누구길래",
};
const LLM_QUERY: Record<string, string> = {
  [CLEAN]: "이세계아이돌 미니 2집",
};
const BLOG_TOTALS: Record<string, number> = {
  "외도 확인후": 1_243_037,
  "엘리스황이 누구길래": 980_000,
  "이세계아이돌 미니 2집": 120,
};

async function main(): Promise<void> {
  const skipFallback = BLOG_COMPETITION_CONFIG.skipFallbackQueries;
  const applyToScore = BLOG_COMPETITION_CONFIG.applyToScore;
  console.log(
    `▶ 폴백 주제어 격리 테스트 (applyToScore=${applyToScore}, skipFallbackQueries=${skipFallback})\n`
  );

  const clusters = [cluster(JENSEN_A), cluster(JENSEN_B), cluster(CLEAN)];
  const queries = [JENSEN_A, JENSEN_B, CLEAN];

  const ranked = await rankKeywords(clusters, queries, {
    topN: 3,
    competition: {
      probeTopN: 30,
      run: async (items) =>
        new Map(
          items.map((item) => {
            const fallback = FALLBACK_QUERY[item.keyword];
            const query = fallback ?? LLM_QUERY[item.keyword] ?? item.keyword;
            return [
              item.keyword,
              { query, total: BLOG_TOTALS[query] ?? null, source: fallback ? "fallback" : "llm" },
            ];
          })
        ),
    },
  });

  const competition = ranked.competition;
  assert(competition, "competition 결과가 있어야 한다");

  // ---------- 집계 ----------
  assert(competition.fallbackCount === 2, `폴백 2건을 세야 한다: ${competition.fallbackCount}`);
  console.log("✅ fallbackCount가 run 기록에 남는다(전량 실패 판정의 근거)");

  // ---------- scoreApplied ----------
  const byKeyword = new Map(competition.entries.map((entry) => [entry.keyword, entry]));
  const jensenA = byKeyword.get(JENSEN_A)!;
  const clean = byKeyword.get(CLEAN)!;

  assert(jensenA.querySource === "fallback", "폴백 출처가 기록돼야 한다");
  assert(jensenA.scoreAfter !== jensenA.scoreBefore, "scoreAfter는 preview 값으로 그대로 채워야 한다");

  if (!applyToScore) {
    assert(
      competition.entries.every((entry) => entry.scoreApplied === false),
      "applyToScore=false면 어떤 항목도 점수에 반영되지 않는다"
    );
    assert(competition.fallbackSkippedCount === 0, "반영 자체가 없으므로 「게이트가 막은 건수」는 0이다");
    console.log("✅ applyToScore=false: scoreApplied 전부 false, fallbackSkippedCount=0");
  } else if (skipFallback) {
    assert(jensenA.scoreApplied === false, "폴백 항목은 점수 반영에서 제외된다");
    assert(clean.scoreApplied === true, "LLM 주제어 항목은 그대로 반영된다");
    assert(competition.fallbackSkippedCount === 2, `게이트가 막은 건수는 2다: ${competition.fallbackSkippedCount}`);

    const jensenRanked = ranked.rankings.find((item) => item.keyword === JENSEN_A)!;
    assert(
      jensenRanked.totalScore === jensenA.scoreBefore,
      `폴백 항목의 최종 점수는 경쟁도 반영 전과 같아야 한다 (${jensenRanked.totalScore} vs ${jensenA.scoreBefore})`
    );
    const cleanRanked = ranked.rankings.find((item) => item.keyword === CLEAN)!;
    assert(
      cleanRanked.totalScore === clean.scoreAfter,
      "LLM 항목의 최종 점수는 경쟁도가 반영된 값이다"
    );
    console.log("✅ skipFallback=on: 폴백은 점수 불변, LLM 항목만 반영");
  } else {
    // 게이트 off + applyToScore on = 2026-11-10 운영 상태. 폴백도 그대로 반영된다.
    assert(jensenA.scoreApplied === true, "게이트가 꺼져 있으면 폴백도 반영된다(기존 동작)");
    assert(competition.fallbackSkippedCount === 0, "게이트가 꺼져 있으면 막은 건수는 0이다");
    const jensenRanked = ranked.rankings.find((item) => item.keyword === JENSEN_A)!;
    assert(
      jensenRanked.totalScore === jensenA.scoreAfter,
      "게이트 off에서는 폴백 blogTotal이 최종 점수에 그대로 들어간다(기존 동작)"
    );
    console.log("✅ 게이트 off + applyToScore on = 2026-11-10 동작 그대로(폴백도 점수에 반영)");
  }

  // ---------- 폴백은 주제 동일성 판정에 들어가지 않는다 ----------
  // diversityTopicQuery는 topicQueryByKeyword가 비면 null이다. 세 항목 중 LLM 주제어는 하나뿐이고
  // isSameTopicQuery는 **양쪽 모두** 주제어가 있을 때만 판정하므로, 폴백을 뺀 뒤에는 어떤 쌍도
  // 주제어로 판정되지 않는다 - 즉 기존 df 기반 판정으로 흘러간다("모르겠다"가 올바른 처리다).
  if (ranked.diversityTopicQuery) {
    assert(
      ranked.diversityTopicQuery.removed.length === 0 && ranked.diversityTopicQuery.added.length === 0,
      "폴백 주제어를 뺐으므로 주제어 판정이 Top N을 바꾸지 않아야 한다"
    );
  }
  console.log("✅ 폴백 주제어는 topicQueryByKeyword에 들어가지 않는다(hard false 단정 방지)");

  console.log("\n✅ 전체 통과");
}

await main();
