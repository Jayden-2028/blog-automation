// 사용설명서 주제 수집 테스트 - 네트워크·DB 없음(전부 주입).
import { KSCENE_LABEL_BY_SEED, KSCENE_LABELS, KSCENE_SEEDS } from "../../config/ksceneSeeds.js";
import { buildAutocompleteUrl, parseAutocompleteResponse } from "../../services/search/providers/googleAutocomplete/fetchAutocomplete.js";
import {
  autocompleteQueriesForSeed,
  buildCandidates,
  isDuplicateTopic,
  isExcludedTopic,
  normalizeTopic,
  pickSeedsForDay,
  scoreTopic,
  selectTopics,
  toRankedKeywords,
  topicSimilarity,
} from "./ksceneTopics.js";
import { dayIndexOf, runKsceneTopicCollection } from "./runKsceneTopicCollection.js";

function assert(c: unknown, m: string): asserts c {
  if (!c) throw new Error(`❌ ${m}`);
}

async function main(): Promise<void> {
  // 시드 구성
  assert(KSCENE_SEEDS.length >= 50, "기본 시드는 50개 이상");
  assert(KSCENE_LABELS.every((label) => KSCENE_SEEDS.some((seed) => seed.label === label)), "모든 라벨에 시드가 있다");
  assert(new Set(KSCENE_SEEDS.map((s) => s.query)).size === KSCENE_SEEDS.length, "시드 중복 없음");
  assert(KSCENE_LABEL_BY_SEED["korean bbq"] === "Food & Dining", "시드 -> 라벨");
  console.log("  ✅ 시드 구성");

  // 자동완성 URL/파서
  assert(buildAutocompleteUrl("korea subway").includes("q=korea+subway") && buildAutocompleteUrl("x").includes("hl=en"), "자동완성 URL");
  assert(JSON.stringify(parseAutocompleteResponse(["q", ["a", " b ", 3, ""]])) === '["a","b"]', "응답 파싱(문자열만)");
  assert(parseAutocompleteResponse({ nope: 1 }).length === 0 && parseAutocompleteResponse(null).length === 0, "모양이 다르면 빈 배열");
  console.log("  ✅ 자동완성 URL·파서");

  // 정규화·유사도·중복
  assert(normalizeTopic("How to Use T-Money Card in Korea?") === "how to use t money card in korea", "정규화");
  assert(topicSimilarity("how to use t-money card in korea", "how to use the t money card in korea") >= 0.8, "관사 차이는 같은 주제");
  assert(topicSimilarity("korean bbq etiquette", "seoul subway map") === 0, "다른 주제는 0");
  assert(isDuplicateTopic("korean bbq etiquette tips", ["korean bbq etiquette"], 0.6), "기발행과 유사하면 중복");
  assert(!isDuplicateTopic("korean bbq sauces explained", ["seoul subway map english"], 0.6), "무관하면 중복 아님");
  console.log("  ✅ 정규화·유사도·중복");

  // 제외 규칙
  for (const bad of ["north korea tourism", "korea casino foreigners", "korean bbq near me", "korea subway map pdf", "korean president news today"]) {
    assert(isExcludedTopic(bad), `제외돼야 함: ${bad}`);
  }
  for (const good of ["how to use t money card in korea", "korean warm soup guide", "korean etiquette for dinner"]) {
    assert(!isExcludedTopic(good), `제외되면 안 됨: ${good}`);
  }
  console.log("  ✅ 제외 규칙(단어 경계 포함 - 'warm'이 'war'로 걸리지 않음)");

  // 시드 선정: 개수·라벨 혼합·날짜로 회전
  const day0 = pickSeedsForDay(KSCENE_SEEDS, 0, 20);
  const day1 = pickSeedsForDay(KSCENE_SEEDS, 1, 20);
  assert(day0.length === 20 && new Set(day0.map((s) => s.query)).size === 20, "20개, 중복 없음");
  assert(new Set(day0.map((s) => s.label)).size === KSCENE_LABELS.length, "라벨이 섞인다");
  assert(day0.map((s) => s.query).join() !== day1.map((s) => s.query).join(), "날짜가 바뀌면 시드가 돈다");
  const covered = new Set<string>();
  for (let d = 0; d < 12; d += 1) pickSeedsForDay(KSCENE_SEEDS, d, 20).forEach((s) => covered.add(s.query));
  assert(covered.size === KSCENE_SEEDS.length, `12일 안에 전체 시드가 한 바퀴(${covered.size}/${KSCENE_SEEDS.length})`);
  assert(autocompleteQueriesForSeed("korea subway", 0)[1] === "korea subway a" && autocompleteQueriesForSeed("x", 27)[1] === "x b", "알파벳 변형");
  console.log("  ✅ 시드 선정(개수·라벨 혼합·회전·한 바퀴)");

  // 후보 구성·점수·선정
  const obs = [
    { suggestion: "how to use t-money card in korea", seed: "t-money card", position: 0 },
    { suggestion: "how to use t-money card in korea", seed: "t-money card", position: 2 }, // 반복 관찰
    { suggestion: "t-money card refund", seed: "t-money card", position: 1 }, // 3단어
    { suggestion: "t-money card near me", seed: "t-money card", position: 3 }, // 제외
    { suggestion: "completely unrelated query about cats", seed: "t-money card", position: 4 }, // 시드 무관
    { suggestion: "korean bbq etiquette for beginners", seed: "korean bbq", position: 0 },
    { suggestion: "korean bbq etiquette tips", seed: "korean bbq", position: 1 }, // 위와 유사 -> 후보 간 중복
  ];
  const candidates = buildCandidates(obs);
  assert(candidates.some((c) => c.topic === "how to use t money card in korea" && c.hits === 2 && c.bestPosition === 0), "반복 관찰 병합");
  assert(!candidates.some((c) => c.topic.includes("near me") || c.topic.includes("cats")), "제외·무관 후보 제거");
  assert(candidates.find((c) => c.topic.startsWith("korean bbq"))?.label === "Food & Dining", "라벨 부여");
  const top = scoreTopic(candidates.find((c) => c.topic === "how to use t money card in korea")!);
  assert(top.total > 60 && top.total <= 100, `좋은 후보 점수(${top.total})`);

  const { selected, droppedAsDuplicate } = selectTopics(candidates, { topN: 5, existingTopics: [], similarity: 0.6 });
  assert(selected.filter((s) => s.topic.startsWith("korean bbq etiquette")).length === 1 && droppedAsDuplicate >= 1, "후보끼리 비슷하면 하나만");
  const withHistory = selectTopics(candidates, { topN: 5, existingTopics: ["how to use t money card in korea"], similarity: 0.6 });
  assert(!withHistory.selected.some((s) => s.topic === "how to use t money card in korea"), "기발행 주제는 다시 제안하지 않는다");
  const ranked = toRankedKeywords(selected);
  assert(ranked[0].rank === 1 && ranked.every((r) => r.category === "kscene" && r.seedQuery && r.scoreBreakdown.total === r.totalScore), "RankedKeyword 변환");
  console.log("  ✅ 후보·점수·중복 제거·변환");

  // 라벨 쏠림 방지: 한 라벨 후보만 20개여도 topN까지 채우되, 다른 라벨이 있으면 먼저 올라온다.
  const many = Array.from({ length: 12 }, (_, i) => ({ topic: `korean food topic number${i} guide`, seed: "korean bbq", label: "Food & Dining" as const, hits: 1, bestPosition: i % 3 }));
  const other = [{ topic: "seoul subway transfer guide tips", seed: "korea subway", label: "Travel & Transit" as const, hits: 1, bestPosition: 8 }];
  const mixed = selectTopics([...many, ...other], { topN: 6, existingTopics: [], similarity: 0.95 });
  assert(mixed.selected.some((s) => s.label === "Travel & Transit"), "점수가 낮아도 다른 라벨이 상한 덕에 들어온다");
  assert(mixed.selected.length === 6, "모자라면 남은 후보로 채운다");
  console.log("  ✅ 라벨 다양성 상한");

  // 전체 실행(주입): 저장·알림 호출 계약
  const calls: string[] = [];
  const dry = await runKsceneTopicCollection({
    now: new Date("2026-10-07T12:00:00Z"),
    delayMs: 0,
    seedsPerRun: 4,
    fetchSuggestions: async (q) => [`${q} guide for first time visitors`, `how to ${q} in korea`],
    fetchTrendTerms: async () => ["Korea earthquake drill", "random celebrity", "BTS comeback"],
    loadExistingTopics: async () => [],
    dryRun: true,
  });
  assert(dry.status === "dry_run" && dry.topics.length > 0 && dry.trendSeeds.length === 2, `dry-run(급상승 한국 관련어만 시드로: ${dry.trendSeeds.join("|")})`);

  const full = await runKsceneTopicCollection({
    now: new Date("2026-10-07T12:00:00Z"),
    delayMs: 0,
    seedsPerRun: 4,
    fetchSuggestions: async (q) => {
      if (q.startsWith("korean bbq")) throw new Error("boom");
      return [`${q} guide for first time visitors`];
    },
    fetchTrendTerms: async () => {
      throw new Error("trends down");
    },
    loadExistingTopics: async () => {
      throw new Error("db down");
    },
    save: async (input) => {
      calls.push(`save:${input.source}:${(input.metadata as { kind: string }).kind}:${input.ranked.length}`);
      return { runId: 77, persisted: true };
    },
    notify: async (opts = {}) => {
      calls.push(`notify:${opts.track}:${opts.runId}:${opts.evergreen}`);
      return { sent: true, payload: null, messages: [] };
    },
    log: () => {},
  });
  assert(full.status === "notified" && full.runId === 77, "일부 실패(시드·트렌드·기발행 조회)가 있어도 알림까지 간다");
  assert(calls[0].startsWith("save:google_autocomplete:kscene_topic:") && calls[1] === "notify:kscene:77:true", `저장 -> 사용설명서 봇 알림 (${calls.join(" / ")})`);

  const none = await runKsceneTopicCollection({ now: new Date(), delayMs: 0, seedsPerRun: 2, fetchSuggestions: async () => [], fetchTrendTerms: async () => [], loadExistingTopics: async () => [], log: () => {} });
  assert(none.status === "no_candidates" && none.runId === null, "후보 0이면 no_candidates(저장·알림 없음)");
  const saveFail = await runKsceneTopicCollection({
    now: new Date(), delayMs: 0, seedsPerRun: 2, fetchTrendTerms: async () => [], loadExistingTopics: async () => [], log: () => {},
    fetchSuggestions: async (q) => [`${q} complete guide here`],
    save: async () => ({ runId: null, persisted: false, error: "x" }),
  });
  assert(saveFail.status === "save_failed", "저장 실패는 알림 없이 save_failed");
  assert(dayIndexOf(new Date("2026-10-07T15:00:00Z")) === dayIndexOf(new Date("2026-10-07T14:59:00Z")) + 1, "일 경계는 KST 자정(UTC 15:00)");
  console.log("  ✅ 전체 실행 계약(부분 실패 허용·저장→알림·후보0·저장실패)");

  console.log("\n✅ testKsceneTopics 통과");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
