// 문자 bigram 변형 접기 회귀 테스트(2026-11-11, KEYWORD-ENT-REDESIGN-2026-11.md R3).
//
// 핵심 단정은 두 가지다.
//   ① **게이트가 꺼져 있으면 2026-11-10과 완전히 같다.** 같은 입력에 대해 entries와 foldedGroups가
//      기존 경로(1·2단계)의 결과와 바이트 단위로 같아야 한다.
//   ② 게이트를 켜면 토큰 판정이 원리적으로 못 보던 세 경우(띄어쓰기·한 글자 표기·2개 그룹)가 접힌다.
//
// 조회 함수를 주입하고 enabledSources를 명시하므로 실제 Supabase·네트워크를 건드리지 않는다.

import {
  buildDailyQueryPool,
  charBigrams,
  charGramKeepCount,
  isSameCharGramGroup,
  parseCharGramFoldEnabled,
} from "./buildDailyQueryPool.js";
import type { SeedQueryRow, TrendCandidateRow } from "../../types/database.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

function makeTrend(keyword: string, rank: number, score: number, topic = "스타·연예인"): TrendCandidateRow {
  return {
    id: `trend-${keyword}-${rank}`,
    keyword,
    keyword_normalized: keyword,
    topic,
    topic_normalized: "entertainment",
    source: "creator_advisor",
    trend_date: "2026-11-09",
    rank,
    movement_type: "up",
    rank_change: 1,
    candidate_score: score,
    collected_at: "2026-11-09T16:00:00.000Z",
    expires_at: "2026-11-10T16:00:00.000Z",
    status: "active",
    metadata: {},
    created_at: "2026-11-09T16:00:00.000Z",
    updated_at: "2026-11-09T16:00:00.000Z",
  };
}

function makeSeed(keyword: string): SeedQueryRow {
  return {
    id: `seed-${keyword}`,
    keyword,
    category: "entertainment",
    priority: 5,
    status: "active",
    source: "manual",
    created_at: "2026-08-25T00:00:00.000Z",
    updated_at: "2026-08-25T00:00:00.000Z",
  };
}

// 2026-11-10 run 260의 동적 시드 실측. 2단계(토큰 부분집합)가 접은 것은 젠슨황 그룹 하나뿐이었다.
//
// topic을 네 엔터 카드에 흩어 놓은 이유: selectTopCreatorAdvisorCandidates의 maxPerTopic(6)이
// 한 카드에 몰아 두면 먼저 잘라 버려서 접기 판정이 보기도 전에 후보가 사라진다.
const RUN_260_TRENDS = [
  makeTrend("젠슨황", 1, 28, "방송"),
  makeTrend("젠슨황 와이프", 7, 25, "방송"),
  makeTrend("젠슨황 스파이", 6, 27, "방송"),
  makeTrend("젠슨 황 불륜", 4, 30, "스타·연예인"),
  makeTrend("젠슨 황 불륜 인정", 2, 35, "스타·연예인"),
  makeTrend("앨리스황", 1, 35, "스타·연예인"),
  makeTrend("엘리스황", 4, 30, "드라마"),
  // 서로 다른 이슈. 접히면 안 된다(2단계 주석의 보수성 반례와 같은 형태).
  makeTrend("김지원 닥터X", 9, 22, "드라마"),
  makeTrend("김지원 광고", 11, 20, "영화"),
  makeTrend("이세계아이돌", 5, 26, "영화"),
];

async function buildPool(charGramFoldEnabled: boolean, trends: TrendCandidateRow[], seeds: SeedQueryRow[] = []) {
  return buildDailyQueryPool({
    enabledSources: ["creator_advisor"],
    creatorAdvisorEnabled: true,
    loadActiveSeeds: async () => seeds,
    loadLatestCreatorAdvisorCandidates: async () => ({ trendDate: "2026-11-09", candidates: trends }),
    variantFoldEnabled: true,
    charGramFoldEnabled,
  });
}

function keywordsOf(entries: { keyword: string }[]): string[] {
  return entries.map((entry) => entry.keyword).sort();
}

/**
 * 불변식: 어느 그룹의 `kept`에 적힌 키워드도 **반드시 풀에 남아 있어야 한다.**
 * 1주 preview 기록으로 적용 여부를 판단하므로, 이게 깨지면 관측 자체가 무의미해진다.
 */
function assertKeptIsInPool(pool: { entries: { keyword: string }[]; foldedGroups: { kept: string[] }[] }): void {
  const inPool = new Set(pool.entries.map((entry) => entry.keyword));
  const missing = pool.foldedGroups.flatMap((group) => group.kept).filter((keyword) => !inPool.has(keyword));
  assert(
    missing.length === 0,
    `foldedGroups.kept에 풀에 없는 키워드가 있다: ${JSON.stringify(missing)}`
  );
}

async function testGateOffIsUnchanged(): Promise<void> {
  const off = await buildPool(false, RUN_260_TRENDS);

  // 2026-11-10 실측: 접힌 그룹은 "젠슨황"(subset) 하나, 접힌 키워드는 "젠슨황 스파이" 하나였다.
  assert(off.foldedGroups.length === 1, `게이트 off는 기존 그룹 1개 그대로: ${off.foldedGroups.length}`);
  assert(off.foldedGroups[0].kind === "subset", "게이트 off에서는 charGram 그룹이 생기지 않는다");
  // 기존 2단계가 보는 것은 "첫 토큰 동일 + 부분집합"이므로 `젠슨황*` 세 건만 한 그룹이고,
  // KEEP=2라 1건만 접힌다. 띄어쓴 `젠슨 황 …`과 `앨리스황`/`엘리스황`은 이 판정 밖이다.
  assert(off.foldedGroups[0].base === "젠슨황", `기존 base는 젠슨황: ${off.foldedGroups[0].base}`);
  assert(off.foldedGroups[0].kept.length === 2, "기존 KEEP은 2다");
  assert(off.foldedGroups[0].dropped.length === 1, "기존 접힘은 1건이다");
  assert(
    [...off.foldedGroups[0].kept, ...off.foldedGroups[0].dropped].every((keyword) =>
      keyword.startsWith("젠슨황")
    ),
    "기존 그룹 멤버는 첫 토큰이 같은 젠슨황* 세 건뿐이다"
  );

  // 토큰 판정이 못 본 것들이 **그대로 남아 있어야** 한다 - 그게 2026-11-10의 동작이다.
  const survived = keywordsOf(off.entries);
  for (const keyword of ["젠슨 황 불륜", "젠슨 황 불륜 인정", "앨리스황", "엘리스황"]) {
    assert(survived.includes(keyword), `게이트 off에서는 "${keyword}"가 남아야 한다(기존 동작)`);
  }
  assert(off.entries.length === RUN_260_TRENDS.length - 1, `게이트 off: 10건 중 1건만 접힘`);
  assertKeptIsInPool(off);
  console.log("✅ 게이트 off = 2026-11-10 동작 그대로(그룹 1개·접힘 1건, 젠슨/앨리스 변형 전부 생존)");
}

async function testGateOnFoldsObservedVariants(): Promise<void> {
  const on = await buildPool(true, RUN_260_TRENDS);
  const survived = keywordsOf(on.entries);
  const charGramGroups = on.foldedGroups.filter((group) => group.kind === "charGram");

  assert(charGramGroups.length > 0, "게이트 on이면 charGram 그룹이 생겨야 한다");

  // ① 띄어쓰기 차이: 젠슨황 계열과 "젠슨 황 …"이 한 그룹이 된다.
  const jensen = charGramGroups.find((group) => charBigrams(group.base).has("젠슨"));
  assert(jensen, "젠슨 계열이 한 그룹으로 묶여야 한다");
  const jensenSurvivors = [
    "젠슨황",
    "젠슨황 와이프",
    "젠슨황 스파이",
    "젠슨 황 불륜",
    "젠슨 황 불륜 인정",
  ].filter((keyword) => survived.includes(keyword));
  assert(
    jensenSurvivors.length === 2,
    `젠슨 계열은 그룹 크기 4 → 대표 2건만 남아야 한다: ${JSON.stringify(jensenSurvivors)}`
  );

  // ② 한 글자 표기 차이: 앨리스황 / 엘리스황.
  const aliceSurvivors = ["앨리스황", "엘리스황"].filter((keyword) => survived.includes(keyword));
  assert(
    aliceSurvivors.length === 1,
    `앨리스황/엘리스황은 1건만 남아야 한다: ${JSON.stringify(aliceSurvivors)}`
  );
  console.log("✅ 게이트 on: 띄어쓰기(젠슨황↔젠슨 황)·한 글자 표기(앨리스황↔엘리스황) 접힘");

  // ③ 과접기 가드: 서로 다른 이슈는 그대로.
  assert(survived.includes("김지원 닥터X"), "서로 다른 이슈(김지원 닥터X)를 죽이면 안 된다");
  assert(survived.includes("김지원 광고"), "서로 다른 이슈(김지원 광고)를 죽이면 안 된다");
  assert(survived.includes("이세계아이돌"), "관련 없는 후보를 건드리면 안 된다");
  assertKeptIsInPool(on);
  console.log("✅ 과접기 가드: 김지원 닥터X / 김지원 광고 / 이세계아이돌 전부 생존");
}

/**
 * #72 검수에서 찾은 재현 케이스(2026-11-11). 두 단계가 서로의 대표를 떨어뜨려 4건 그룹이
 * 1건만 남고, metadata의 kept에 풀에 없는 키워드가 적혔다. 그 조건을 그대로 고정한다.
 *
 * 조건: 2단계가 2순위 대표를 compareForRank(rank 우선)로 고르는데, 3단계는 compareForBase
 * (토큰 수 우선)로 정렬한다 -> 토큰 수는 적지만 rank가 나쁜 멤버에서 둘의 선택이 갈린다.
 */
async function testStageKeepersAgree(): Promise<void> {
  const trends = [
    makeTrend("젠슨황", 9, 10, "방송"), // 1토큰, rank 최하 -> 두 단계 모두 base
    makeTrend("젠슨황 와이프", 5, 20, "방송"), // 2토큰, rank 중간 -> 3단계만 2순위로 고른다
    makeTrend("젠슨황 와이프 논란", 1, 30, "방송"), // 3토큰, rank 1위 -> 2단계만 2순위로 고른다
    makeTrend("젠슨 황 불륜", 2, 25, "드라마"),
  ];

  const on = await buildPool(true, trends);
  const survived = keywordsOf(on.entries);

  assert(
    on.entries.length === 2,
    `4건 그룹은 charGramKeepCount(4)=2 대로 2건이 남아야 한다 (${on.entries.length}: ${JSON.stringify(survived)})`
  );
  assert(survived.includes("젠슨황"), "두 단계의 base는 반드시 살아남는다");
  assert(
    survived.includes("젠슨황 와이프 논란"),
    "2단계가 고른 2순위 대표를 3단계가 떨어뜨려서는 안 된다"
  );
  assertKeptIsInPool(on);

  const charGram = on.foldedGroups.filter((group) => group.kind === "charGram");
  assert(charGram.length === 1, `charGram 그룹 1개 (${charGram.length})`);
  assert(
    JSON.stringify(charGram[0].kept) === JSON.stringify(["젠슨황", "젠슨황 와이프 논란"]),
    `3단계 대표는 살아 있는 멤버여야 한다: ${JSON.stringify(charGram[0].kept)}`
  );
  console.log("✅ 두 단계가 서로의 대표를 떨어뜨리지 않는다(4건 그룹 → 2건 생존, kept 정합)");
}

async function testTwoMemberGroupFolds(): Promise<void> {
  // 2단계의 `bucket.length <= QUERY_POOL_VARIANT_KEEP` 조기 반환 때문에 영원히 안 접히던 형태.
  const trends = [makeTrend("젠슨 황 불륜", 4, 30), makeTrend("젠슨 황 불륜 인정", 2, 35)];

  const off = await buildPool(false, trends);
  assert(off.entries.length === 2, "게이트 off: 2개짜리 그룹은 기존대로 그대로 남는다");
  assert(off.foldedGroups.length === 0, "게이트 off: 2개짜리 그룹은 기존대로 접히지 않는다");

  const on = await buildPool(true, trends);
  assert(on.entries.length === 1, `게이트 on: 2개짜리 그룹은 1건으로 접힌다 (${on.entries.length})`);
  assert(on.entries[0].keyword === "젠슨 황 불륜", "대표는 짧은 쪽(검색 커버리지가 넓다)");
  console.log("✅ 2개짜리 그룹도 접힌다(KEEP 조기 반환 구멍 해소) — 대표는 짧은 쪽");
}

async function testKeepCountByGroupSize(): Promise<void> {
  // 10/17 나솔사계: 변형 13개. 크기 4 이상이면 대표 2개를 유지한다(QUERY_POOL_VARIANT_KEEP의 근거).
  const variants = ["나솔사계", "나솔사계 현커", "나솔사계 라방", "나솔사계 최종커플", "나솔사계 재방송"];
  const trends = variants.map((keyword, index) => makeTrend(keyword, index + 1, 30 - index));

  const on = await buildPool(true, trends);
  assert(on.entries.length === 2, `크기 5 그룹은 대표 2건을 남긴다 (${on.entries.length})`);
  assert(on.entries.some((entry) => entry.keyword === "나솔사계"), "base(가장 짧은 것)는 남는다");
  console.log("✅ 그룹 크기별 대표 수: 5개 그룹 → 2건 유지(나솔사계 전례 보존)");

  assert(charGramKeepCount(2) === 1, "2개 그룹 → 대표 1");
  assert(charGramKeepCount(3) === 1, "3개 그룹 → 대표 1");
  assert(charGramKeepCount(4) === 2, "4개 그룹 → 대표 2");
  assert(charGramKeepCount(13) === 2, "13개 그룹 → 대표 2");
  console.log("✅ charGramKeepCount: 2~3 → 1, 4 이상 → 2");
}

async function testSeedIsNeverFolded(): Promise<void> {
  // 사람이 큐레이션한 시드는 접지 않는다(기존 2단계와 같은 원칙).
  const on = await buildPool(true, [makeTrend("드라마 공개일", 3, 25)], [makeSeed("드라마 공개")]);
  const keywords = keywordsOf(on.entries);
  assert(keywords.includes("드라마 공개"), "seed는 접히지 않는다");
  console.log("✅ seed_queries는 문자 bigram 접기 대상이 아니다");
}

function testPureJudgements(): void {
  // 접힘 판정 자체.
  assert(isSameCharGramGroup(charBigrams("젠슨황"), charBigrams("젠슨 황 불륜")), "띄어쓰기 변형은 같은 그룹");
  assert(isSameCharGramGroup(charBigrams("앨리스황"), charBigrams("엘리스황")), "한 글자 표기 변형은 같은 그룹");
  assert(
    !isSameCharGramGroup(charBigrams("김지원 닥터X"), charBigrams("김지원 광고")),
    "같은 인물의 다른 이슈는 묶이지 않는다(자카드 0.29)"
  );
  assert(
    !isSameCharGramGroup(charBigrams("신랑"), charBigrams("신곡 발매")),
    "짧은 키워드가 아무 것에나 삼켜지면 안 된다"
  );
  // bigram이 2개 미만(= 공백 제거 후 2글자)인 키워드는 대상에서 뺀다.
  assert(charBigrams("신랑").size === 1, "2글자 키워드의 bigram은 1개");
  assert(!isSameCharGramGroup(charBigrams("신랑"), charBigrams("신랑감 소개")), "bigram 1개짜리는 판정 제외");
  console.log("✅ 판정 가드: 부분집합·자카드 0.5·교집합 2개·최소 bigram 2개");

  // 게이트 해석. **미설정·빈 값은 꺼짐**이다(기존 QUERY_POOL_VARIANT_FOLD와 반대 - 승인 전이므로).
  assert(parseCharGramFoldEnabled(undefined) === false, "미설정은 꺼짐");
  assert(parseCharGramFoldEnabled("") === false, "빈 값은 꺼짐");
  assert(parseCharGramFoldEnabled("false") === false, "false는 꺼짐");
  assert(parseCharGramFoldEnabled("true") === true, "true만 켜짐");
  assert(parseCharGramFoldEnabled(" TRUE ") === true, "공백·대문자 허용");
  console.log("✅ QUERY_POOL_FOLD_CHARGRAM: true일 때만 켜짐(기본 꺼짐)");
}

async function main(): Promise<void> {
  console.log("▶ 문자 bigram 변형 접기 테스트 시작\n");
  testPureJudgements();
  await testGateOffIsUnchanged();
  await testGateOnFoldsObservedVariants();
  await testStageKeepersAgree();
  await testTwoMemberGroupFolds();
  await testKeepCountByGroupSize();
  await testSeedIsNeverFolded();
  console.log("\n✅ 전체 통과");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
