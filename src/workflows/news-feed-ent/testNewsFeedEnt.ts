// 연예 뉴스 피드 소스 회귀 테스트(2026-11-11, KEYWORD-ENT-REDESIGN-2026-11.md R1).
//
// 네트워크 접근 없음: RSS/HTML을 주입한다. fixture는 2026-11-11 실측 응답의 **모양 그대로**
// 줄인 것이다(Google은 `<item>` 하나가 스토리 클러스터이고 `<description>`에 `<ol>`이 들어 있다,
// 다음은 box_news_ranking 블록의 item_newsbasic).
//
// 핵심 단정:
//  ① **소스가 꺼져 있으면 아무 일도 일어나지 않는다**(기본값 = 운영 현재 상태).
//  ② 이슈를 Google이 묶어 준 그대로 쓴다(우리가 제목 유사도로 묶지 않는다).
//  ③ LLM 없이도 쓸 만한 이슈 구가 나온다 - 2026-11-10에 LLM이 60/60 실패했으므로 폴백이 곧 품질이다.
//  ④ 순위는 다음 「많이 본 뉴스」가 먼저, 그 뒤 피드 순서.
//  ⑤ 다음에서 못 맞춘 기사는 **시드가 되지 않는다**(같은 이슈가 두 시드로 갈라지는 것을 막는다).

process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-only-not-a-real-key";

import { parseDaumEntRanking } from "../../services/search/providers/newsFeedEnt/parseDaumEntRanking.js";
import {
  parseGoogleNewsRss,
  stripOutletSuffix,
} from "../../services/search/providers/newsFeedEnt/parseGoogleNewsRss.js";
import { runNewsFeedEntCollection } from "./runNewsFeedEntCollection.js";
import { buildIssuePhraseFromStory, matchDaumRanking, sharedIssueTokens } from "./newsFeedIssuePhrase.js";
import { mapNewsFeedIssuesToInserts, type NewsFeedIssue } from "./mapNewsFeedCandidates.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

/** `<li>` 한 줄. description은 HTML이 이스케이프된 채로 오므로 fixture도 그렇게 만든다. */
function li(title: string, outlet: string): string {
  return (
    `&lt;li&gt;&lt;a href="https://news.google.com/rss/articles/X?oc=5" target="_blank"&gt;${title}` +
    `&lt;/a&gt;&amp;nbsp;&amp;nbsp;&lt;font color="#6f6f6f"&gt;${outlet}&lt;/font&gt;&lt;/li&gt;`
  );
}

function item(title: string, outlet: string, pubDate: string, related: [string, string][]): string {
  const ol = `&lt;ol&gt;${related.map(([t, o]) => li(t, o)).join("")}&lt;/ol&gt;`;
  return (
    `<item><title>${title} - ${outlet}</title>` +
    `<link>https://news.google.com/rss/articles/X?oc=5</link>` +
    `<pubDate>${pubDate}</pubDate>` +
    `<description>${ol}</description>` +
    `<source url="https://example.com">${outlet}</source></item>`
  );
}

// 2026-11-11 실측 「인강 강사 이도」 클러스터(5개 매체) + 두 건.
const GOOGLE_RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>엔터테인먼트 - 최신 뉴스 - Google 뉴스</title>
${item(
  '"수능 앞두고 아프다더니 예능 출연"…사탐 강사 이도 결국',
  "한국경제",
  "Tue, 10 Nov 2026 22:09:31 GMT",
  [
    ['"수능 앞두고 아프다더니 예능 출연"…사탐 강사 이도 결국 - 한국경제', "한국경제"],
    ["'강의 중단→예능 출연' 이도, 결국 손절 엔딩?…17개 강좌 통삭제 - 머니투데이", "머니투데이"],
    ['이도, 수능 3주 앞두고 강의 중단 사과 "무책임했다…방송 활동 중단"', "뉴스1"],
    ['‘수능 강의 중단’ 이도, 결국 자필 사과... “변명 여지 없는 잘못, 활동 중단” [전문]', "조선일보"],
    ["결국 첫 회 탈락한 이도 \"목표 못 이뤄 아쉬워\"", "뉴시스"],
  ]
)}
${item("‘뉴진스 계약서’ 보도로 다시 드러난 K팝 산업 민낯", "한겨레", "Tue, 10 Nov 2026 09:55:00 GMT", [
  ["‘뉴진스 계약서’ 보도로 다시 드러난 K팝 산업 민낯 - 한겨레", "한겨레"],
  ["뉴진스 계약서 전문 공개…어도어 입장은", "뉴시스"],
])}
${item("젝키 디너쇼 무산에…주최사 대표, '실명폭로' 이재진 고소", "스포츠서울", "Tue, 10 Nov 2026 13:00:00 GMT", [
  ["젝키 디너쇼 무산에…주최사 대표, '실명폭로' 이재진 고소 - 스포츠서울", "스포츠서울"],
])}
</channel></rss>`;

// 다음 「많이 본 뉴스」. 1위는 Google 클러스터와 못 맞추는 기사, 2위가 젝키 이슈다.
const DAUM_HTML = `<html><body>
<div class="box_comp box_news_ranking"><div class="box_tit"><strong class="tit_box"><span class="txt_box"> 많이 본 뉴스</span></strong></div>
<ul class="list_newsbasic">
<li><a class="item_newsbasic" data-tiara-layer="news" data-tiara-ordnum="1" href="https://v.daum.net/v/1"><div class="cont_thumb"><em class="num_g">1<span class="screen_out">위</span></em> <strong class="tit_txt">'JTBC 퇴사' 강지영, 15년 만에 MBC 입성…테이 이어 '굿모닝FM' 진행 [공식]</strong></div></a></li>
<li><a class="item_newsbasic" data-tiara-layer="news" data-tiara-ordnum="2" href="https://v.daum.net/v/2"><div class="cont_thumb"><em class="num_g">2<span class="screen_out">위</span></em> <strong class="tit_txt">젝키 디너쇼 무산에…주최사 대표, '실명폭로' 이재진 고소 "멤버 간 분쟁 아냐"[공식]</strong></div></a></li>
</ul></div>
<ul class="list_other"><li><a class="item_other" data-tiara-ordnum="1"><strong class="tit_txt">다른 섹션 기사 - 순위에 섞이면 안 된다</strong></a></li></ul>
</body></html>`;

function testParsers(): void {
  const stories = parseGoogleNewsRss(GOOGLE_RSS);
  assert(stories.length === 3, `스토리 3건을 읽어야 한다: ${stories.length}`);

  const ido = stories[0];
  assert(
    ido.leadTitle === '"수능 앞두고 아프다더니 예능 출연"…사탐 강사 이도 결국',
    `제목 끝의 " - 매체명" 꼬리를 떼어야 한다: ${ido.leadTitle}`
  );
  assert(ido.leadOutlet === "한국경제", "대표 매체는 <source>에서 온다");
  assert(ido.related.length === 5, `클러스터에 묶인 기사 5건을 읽어야 한다: ${ido.related.length}`);
  assert(ido.outletCount === 5, `매체 5곳: ${ido.outletCount}`);
  assert(ido.publishedAt?.startsWith("2026-11-10"), `pubDate를 ISO로: ${ido.publishedAt}`);
  assert(
    ido.related.some((article) => article.title.includes("자필 사과") && article.outlet === "조선일보"),
    "<li> 안의 제목·매체가 짝으로 읽혀야 한다"
  );
  assert(
    !ido.related.some((article) => article.title.includes(" - 머니투데이")),
    "related 제목에서도 매체 꼬리를 떼야 한다"
  );
  assert(stories[2].outletCount === 1, "기사 1건짜리 클러스터는 매체 1곳이다");
  console.log("✅ Google 뉴스 RSS: 스토리 클러스터 + 매체 목록 + 꼬리 제거");

  // 제목 안의 하이픈을 꼬리로 오인하지 않는다.
  assert(
    stripOutletSuffix("아이유 - 좋은 날 - 스포츠조선", "스포츠조선") === "아이유 - 좋은 날",
    "매체명을 알면 그 꼬리만 떼야 한다"
  );
  assert(
    stripOutletSuffix("방탄소년단 'SWIM', 애플뮤직 베스트 송") === "방탄소년단 'SWIM', 애플뮤직 베스트 송",
    "꼬리가 없으면 그대로 둔다"
  );

  const ranking = parseDaumEntRanking(DAUM_HTML);
  assert(ranking.length === 2, `많이 본 뉴스 2건만 읽어야 한다(다른 섹션 제외): ${ranking.length}`);
  assert(ranking[0].rank === 1 && ranking[0].title.includes("강지영"), "순위와 제목이 짝이어야 한다");
  assert(
    !ranking.some((row) => row.title.includes("다른 섹션")),
    "box_news_ranking 블록 밖의 ordnum은 섞이면 안 된다"
  );
  console.log("✅ 다음 「많이 본 뉴스」: 블록 안 10건만, 다른 섹션 미포함");

  assert(parseGoogleNewsRss("<rss></rss>").length === 0, "구조가 바뀌면 예외 없이 빈 배열");
  assert(parseDaumEntRanking("<html></html>").length === 0, "구조가 바뀌면 예외 없이 빈 배열");
  console.log("✅ 구조가 바뀌어도 예외를 던지지 않는다(보조 소스는 job을 죽이지 않는다)");
}

function testIssuePhrase(): void {
  const stories = parseGoogleNewsRss(GOOGLE_RSS);
  const shared = sharedIssueTokens(stories[0].related.map((article) => article.title));

  // 여러 매체 제목에 공통으로 나오는 명사 = 그 사건의 고유명사. 위치가 아니라 빈도로 뽑는다.
  for (const token of ["이도", "중단"]) {
    assert(shared.includes(token), `공유 토큰에 "${token}"이 있어야 한다: ${JSON.stringify(shared)}`);
  }

  const phrase = buildIssuePhraseFromStory(stories[0]);
  const words = phrase.split(" ");
  assert(words.length >= 2 && words.length <= 5, `이슈 구는 2~5어절: "${phrase}"`);
  assert(phrase.includes("이도"), `이슈 구에 사건 주인공이 들어가야 한다: "${phrase}"`);
  assert(!phrase.includes("아프다더니"), `인용·수식절이 들어가면 안 된다: "${phrase}"`);
  console.log(`✅ LLM 없이도 쓸 만한 이슈 구가 나온다 — "${phrase}"`);

  // 기사 1건짜리 클러스터는 공유 토큰이 없다 -> 대표 제목 앞쪽 핵심 명사로 채운다.
  const single = buildIssuePhraseFromStory(stories[2]);
  assert(single.split(" ").length >= 2, `1건짜리도 구를 만들어야 한다: "${single}"`);
  console.log(`✅ 기사 1건짜리 클러스터도 구가 나온다 — "${single}"`);
}

function testDaumMatching(): void {
  const stories = parseGoogleNewsRss(GOOGLE_RSS);
  const ranking = parseDaumEntRanking(DAUM_HTML);
  const matched = matchDaumRanking(stories, ranking);

  const jekki = matched.byLeadTitle.get(stories[2].leadTitle);
  assert(jekki, "같은 이슈(젝키 디너쇼)는 다음 랭킹과 맞아야 한다");
  assert(jekki.daumRank === 2, `다음 2위가 붙어야 한다: ${jekki.daumRank}`);
  assert(jekki.sharedTokens.length >= 2, "매칭 근거(공유 핵심명사 2개 이상)가 남아야 한다");

  assert(matched.unmatched.length === 1, `못 맞춘 1건이 남아야 한다: ${matched.unmatched.length}`);
  assert(matched.unmatched[0].title.includes("강지영"), "못 맞춘 기사는 그대로 기록된다");
  console.log("✅ 다음 랭킹 매칭: 같은 이슈에만 붙고, 못 맞춘 것은 목록으로만 남는다");

  // 못 맞춘 다음 기사는 **시드가 되지 않는다**(같은 이슈가 두 시드로 갈라지는 것을 막는다).
  const issues: NewsFeedIssue[] = stories.map((story) => ({
    story,
    phrase: buildIssuePhraseFromStory(story),
    phraseSource: "shared_tokens",
    daum: matched.byLeadTitle.get(story.leadTitle) ?? null,
  }));
  const { rows } = mapNewsFeedIssuesToInserts(issues, { collectedAt: "2026-11-11T09:00:00.000Z" });

  assert(rows.length === 3, `Google 스토리 수만큼만 시드가 된다: ${rows.length}`);
  assert(
    !rows.some((row) => row.keyword.includes("강지영")),
    "못 맞춘 다음 기사가 시드로 새어 들어가면 안 된다"
  );

  // 순위: 다음에 맞은 것(2위)이 피드 1·2번보다 앞선다.
  assert(rows[0].metadata && (rows[0].metadata as Record<string, unknown>).daumRank === 2, "다음 매칭분이 1순위");
  assert(
    Number(rows[0].candidate_score) > Number(rows[1].candidate_score),
    `다음 순위가 붙은 시드의 점수가 높아야 한다: ${rows[0].candidate_score} vs ${rows[1].candidate_score}`
  );
  assert(
    rows.every((row) => row.source === "news_feed_ent" && row.topic_normalized === "entertainment"),
    "source/category가 고정값이어야 한다(연예 토픽 피드라 분야가 확정이다)"
  );
  assert(
    (rows[0].metadata as Record<string, unknown>).outletCountSaturated === false,
    "매체 수 포화 여부를 기록해 둔다(R9에서 쓸 때 이 한계를 알아야 한다)"
  );
  console.log("✅ 매핑: 다음 순위 먼저 → 피드 순서, 못 맞춘 기사는 시드 미생성");
}

async function testDisabledByDefault(): Promise<void> {
  // 운영 현재 상태(ENT_NEWS_FEED_ENABLED 미설정)에서는 조회도 쓰기도 하지 않는다.
  let fetched = false;
  const result = await runNewsFeedEntCollection({
    fetchFeed: async () => {
      fetched = true;
      throw new Error("호출되면 안 된다");
    },
  });
  assert(result.status === "skipped" && result.reason === "disabled", "기본값은 skipped(disabled)");
  assert(!fetched, "꺼져 있으면 네트워크 조회조차 하지 않는다");
  assert(result.upsertedCount === 0, "꺼져 있으면 DB에 아무것도 쓰지 않는다");
  console.log("✅ ENT_NEWS_FEED_ENABLED 미설정 = 조회·쓰기 전부 없음(현재 운영 상태)");
}

async function testDryRunCollection(): Promise<void> {
  const result = await runNewsFeedEntCollection({
    enabled: true,
    dryRun: true,
    maxIssues: 15,
    // LLM을 아예 부르지 않는 경로. 2026-11-10처럼 LLM이 죽은 날의 동작이 이것이다.
    buildPhrases: false,
    fetchFeed: async () => ({
      stories: parseGoogleNewsRss(GOOGLE_RSS),
      daumRanking: parseDaumEntRanking(DAUM_HTML),
      sourceErrors: {},
      collectedAt: "2026-11-11T09:00:00.000Z",
    }),
  });

  assert(result.status === "success", `dry-run 성공해야 한다: ${result.status} ${result.error ?? ""}`);
  assert(result.fetchedCount === 3, `스토리 3건: ${result.fetchedCount}`);
  assert(result.upsertedCount === 0, "dry-run은 DB에 쓰지 않는다");
  assert(result.daumRankedCount === 2 && result.daumMatchedCount === 1, "다음 랭킹 2건 중 1건 매칭");
  assert(result.daumUnmatched.length === 1, "못 맞춘 1건이 결과에 남는다");
  assert(result.llmPhraseCount === 0 && result.fallbackPhraseCount === 3, "LLM을 끄면 전부 폴백 구다");
  assert(result.trendDate === "2026-11-11", `trend_date는 수집일: ${result.trendDate}`);
  console.log("✅ dry-run: 조회·매칭·구 생성까지만, DB 쓰기 0");
}

async function testGoogleFailureIsCollectionFailure(): Promise<void> {
  // Google이 비면 시드를 만들 수 없다. 다음 랭킹만으로는 후보를 만들지 않는다(설계 결정).
  const result = await runNewsFeedEntCollection({
    enabled: true,
    dryRun: true,
    buildPhrases: false,
    fetchFeed: async () => ({
      stories: [],
      daumRanking: parseDaumEntRanking(DAUM_HTML),
      sourceErrors: { google_news: "요청 실패: 503" },
      collectedAt: "2026-11-11T09:00:00.000Z",
    }),
  });
  assert(result.status === "failed", "Google이 비면 수집 실패로 알린다");
  assert(result.error?.includes("503"), "실패 사유가 남아야 한다");
  assert(result.upsertedCount === 0, "실패 시 DB에 아무것도 쓰지 않는다");
  console.log("✅ Google 실패 = 수집 실패(다음 랭킹만으로 시드를 만들지 않는다)");

  // 반대로 다음만 죽으면 순위 신호만 잃고 수집은 계속된다.
  const daumDown = await runNewsFeedEntCollection({
    enabled: true,
    dryRun: true,
    buildPhrases: false,
    fetchFeed: async () => ({
      stories: parseGoogleNewsRss(GOOGLE_RSS),
      daumRanking: [],
      sourceErrors: { daum_entertain: "요청 실패: 500" },
      collectedAt: "2026-11-11T09:00:00.000Z",
    }),
  });
  assert(daumDown.status === "success", "다음이 죽어도 수집은 성공한다");
  assert(daumDown.daumMatchedCount === 0, "순위 신호만 없어진다");
  console.log("✅ 다음 실패 = 순위 신호만 상실(수집은 계속)");
}

async function main(): Promise<void> {
  console.log("▶ 연예 뉴스 피드 소스 테스트 시작\n");
  testParsers();
  testIssuePhrase();
  testDaumMatching();
  await testDisabledByDefault();
  await testDryRunCollection();
  await testGoogleFailureIsCollectionFailure();
  console.log("\n✅ 전체 통과");
}

await main();
