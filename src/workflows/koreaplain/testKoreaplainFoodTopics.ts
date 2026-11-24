// 사용설명서 트랙 **한국 음식 소개 모드**(2026-11-25) 테스트 - 네트워크·DB 없음(전부 주입).
// 결정 배경: docs/ai-handoff/KOREAPLAIN-FOOD-PIVOT-2026-11.md. 이전(생활 가이드) 모드·공용 기계는 testKoreaplainTopics.ts가 본다.
// 모드는 전부 `food`로 **명시해서** 부른다 - KSCENE_TOPIC_MODE 환경변수와 무관하게 같은 결과가 나와야 한다.
import {
  KOREAPLAIN_FOOD_LABEL,
  KOREAPLAIN_FOOD_SEEDS,
  KOREAPLAIN_FOOD_SUBLABELS,
  KOREAPLAIN_LABEL_BY_SEED,
  KOREAPLAIN_LABELS,
  KOREAPLAIN_LEGACY_SEEDS,
  KOREAPLAIN_SEEDS,
  KOREAPLAIN_SUBLABEL_BY_SEED,
  KOREAPLAIN_TOPIC_MODE,
  koreaplainLabelsFor,
} from "../../config/koreaplainSeeds.js";
import {
  AVERSIVE_FOOD_TERMS,
  classifyFoodSubLabel,
  foodTopicRejection,
  isRegionalFoodTopic,
  isSaturatedFoodTopic,
} from "../../config/koreaplainFoodTerms.js";
import { buildAllGuidesHtml } from "../publish/tkmPostStructure.js";
import {
  buildCandidates,
  defaultRegionalFoodFloor,
  hasIntentSignal,
  hasUsableShape,
  isExcludedTopic,
  isOverseasLocalTopic,
  passesFoodTopicRules,
  pickSeedsForDay,
  scoreTopic,
  selectTopics,
  toRankedKeywords,
  type TopicCandidate,
} from "./koreaplainTopics.js";
import { runKoreaplainTopicCollection } from "./runKoreaplainTopicCollection.js";

function assert(c: unknown, m: string): asserts c {
  if (!c) throw new Error(`❌ ${m}`);
}

async function main(): Promise<void> {
  // ---------- 1. 시드 ----------
  assert(KOREAPLAIN_FOOD_SEEDS.length >= 120, `음식 시드 120개 이상(실제 ${KOREAPLAIN_FOOD_SEEDS.length})`);
  assert(KOREAPLAIN_FOOD_SEEDS.every((seed) => seed.label === KOREAPLAIN_FOOD_LABEL && seed.subLabel), "음식 시드는 전부 Food & Dining + 하위 라벨");
  const bySub = new Map<string, number>();
  for (const seed of KOREAPLAIN_FOOD_SEEDS) bySub.set(seed.subLabel!, (bySub.get(seed.subLabel!) ?? 0) + 1);
  assert(KOREAPLAIN_FOOD_SUBLABELS.every((sub) => (bySub.get(sub) ?? 0) >= 30), `하위 라벨마다 30개 이상(${JSON.stringify([...bySub])})`);
  assert(new Set(KOREAPLAIN_FOOD_SEEDS.map((seed) => seed.query)).size === KOREAPLAIN_FOOD_SEEDS.length, "음식 시드 중복 없음");
  const legacyQueries = new Set(KOREAPLAIN_LEGACY_SEEDS.map((seed) => seed.query));
  assert(KOREAPLAIN_FOOD_SEEDS.every((seed) => !legacyQueries.has(seed.query)), "음식 시드는 이전 시드 문구와 겹치지 않는다(옛 job 라벨 보존)");
  for (const seed of KOREAPLAIN_FOOD_SEEDS) {
    assert(seed.query.split(" ").length <= 4, `시드는 짧은 질의(${seed.query})`);
    assert(passesFoodTopicRules(seed.query), `시드가 자기 음식 규칙에 걸리면 헛돈다: ${seed.query} (${foodTopicRejection(seed.query)})`);
    assert(!isExcludedTopic(seed.query) && !isOverseasLocalTopic(seed.query), `시드가 공용 제외 규칙에 걸리면 안 된다: ${seed.query}`);
  }
  for (const query of ["jeonju bibimbap", "chuncheon dakgalbi", "andong jjimdak", "busan dwaeji gukbap", "busan milmyeon", "chungmu gimbap", "chodang sundubu", "jeju gogi guksu", "uijeongbu budae jjigae", "suwon galbi", "naju gomtang", "abai sundae", "masan agujjim", "pyongyang naengmyeon", "hamhung naengmyeon", "hodu gwaja", "hwangnam bread", "daegu makchang"]) {
    assert(KOREAPLAIN_SUBLABEL_BY_SEED[query] === "Regional Food", `지역 향토 음식 시드: ${query}`);
  }
  // 이전 시드 241개는 비활성 보관 - 지우지 않았고 라벨 매핑에 남아 있다.
  assert(KOREAPLAIN_LEGACY_SEEDS.length === 241, `이전 시드 241개 보관(실제 ${KOREAPLAIN_LEGACY_SEEDS.length})`);
  assert(KOREAPLAIN_LABEL_BY_SEED["korean bbq"] === "Food & Dining" && KOREAPLAIN_LABEL_BY_SEED["korea dong office"] === "Living in Korea", "옛 job 라벨 매핑 유지");
  assert(KOREAPLAIN_LABEL_BY_SEED["jeonju bibimbap"] === "Food & Dining", "음식 시드 라벨 매핑");
  // 수집 시드는 모드가 정한다(기본 food, KSCENE_TOPIC_MODE=legacy면 이전 시드).
  assert(KOREAPLAIN_SEEDS === (KOREAPLAIN_TOPIC_MODE === "food" ? KOREAPLAIN_FOOD_SEEDS : KOREAPLAIN_LEGACY_SEEDS), `수집 시드 = 모드(${KOREAPLAIN_TOPIC_MODE})`);
  if (!process.env.KSCENE_TOPIC_MODE) assert(KOREAPLAIN_TOPIC_MODE === "food", "환경변수가 없으면 음식 모드");
  console.log(`  ✅ 음식 시드 ${KOREAPLAIN_FOOD_SEEDS.length}개(${[...bySub].map(([k, v]) => `${k} ${v}`).join(" · ")}) · 이전 241개 보관 · 라벨 매핑`);

  // ---------- 2. 라벨(Blogger) ----------
  assert(koreaplainLabelsFor({ seedQuery: "andong jjimdak" }).join("|") === "Food & Dining|Regional Food", "음식 시드 = 상위 + 하위 라벨(상위가 먼저)");
  assert(koreaplainLabelsFor({ seedQuery: "kimchi jjigae" }).join("|") === "Food & Dining|Korean Dishes", "대표 요리 하위 라벨");
  assert(koreaplainLabelsFor({ seedQuery: "korean bbq" }).join("|") === "Food & Dining", "이전 음식 시드 글은 라벨 하나 그대로");
  assert(koreaplainLabelsFor({ seedQuery: "korea dong office" }).join("|") === "Living in Korea", "이전 생활 시드 글 라벨 불변");
  assert(koreaplainLabelsFor({ seedQuery: null, keyword: "jeonju bibimbap history" }).join("|") === "Living in Korea", "직접 입력 표시가 없으면 기본 라벨(옛 글 라벨을 바꾸지 않는다)");
  if (KOREAPLAIN_TOPIC_MODE === "food") {
    assert(koreaplainLabelsFor({ seedQuery: null, keyword: "jeonju bibimbap history", directInput: true }).join("|") === "Food & Dining|Regional Food", "봇 직접 입력 음식 글 = 문구로 하위 라벨");
    assert(koreaplainLabelsFor({ seedQuery: null, keyword: "what is hotteok", directInput: true }).join("|") === "Food & Dining|Street Food & Desserts", "직접 입력 길거리 음식");
    assert(koreaplainLabelsFor({ seedQuery: null, keyword: "korea subway fare", directInput: true }).join("|") === "Living in Korea", "직접 입력이어도 음식이 아니면 기본 라벨");
  }
  assert(classifyFoodSubLabel("busan milmyeon") === "Regional Food" && classifyFoodSubLabel("bungeoppang vs taiyaki") === "Street Food & Desserts" && classifyFoodSubLabel("galbitang vs seolleongtang") === "Korean Dishes", "하위 라벨 분류");
  // All Guides는 상위 라벨로 묶는다 - Blogger가 하위 라벨을 먼저 돌려줘도.
  const guides = buildAllGuidesHtml([
    { url: "https://www.koreaplain.com/2026/11/a.html", title: "Andong Jjimdak", labels: ["Regional Food", "Food & Dining"], published: "2026-11-26T10:00:00+09:00" },
    { url: "https://www.koreaplain.com/2026/10/b.html", title: "Korean BBQ", labels: ["Food & Dining"], published: "2026-10-26T10:00:00+09:00" },
  ]);
  assert(guides.includes(">Food &amp; Dining</h2>") && !guides.includes(">Regional Food</h2>") && guides.includes("2 guides in total"), "All Guides는 하위 라벨로 새 묶음을 만들지 않는다");
  console.log("  ✅ 라벨: 음식 시드 상위+하위 · 옛 글 불변 · 직접 입력 분류 · All Guides 상위 라벨 묶음");

  // ---------- 3. 제외 3종 + 음식 게이트 ----------
  const rejects: [string, string][] = [
    // 혐오 식품
    ["dog meat soup korea", "aversive"], ["boshintang", "aversive"], ["beondegi silkworm pupae", "aversive"], ["sannakji live octopus", "aversive"],
    ["gaebul penis fish", "aversive"], ["hongeo fermented skate", "aversive"], ["korean snake wine", "aversive"], ["weird korean food", "aversive"],
    // 음식이 아님
    ["jeonju hanok village", "not_food"], ["busan haeundae beach", "not_food"], ["chuncheon nami island", "not_food"],
    // 식재료·양념·포장 제품·도구
    ["gochujang substitute", "ingredient"], ["korean perilla leaves", "ingredient"], ["korean sesame oil", "ingredient"], ["korean pear", "ingredient"],
    ["tteokbokki sauce", "ingredient"], ["bulgogi marinade", "ingredient"], ["jjamppong instant noodles", "ingredient"], ["samgyetang kit", "ingredient"],
    ["hodu gwaja pan", "ingredient"], ["korean short grain rice", "ingredient"], ["where to buy gochugaru", "ingredient"],
    // 레시피 의도
    ["kimchi jjigae recipe", "recipe"], ["how to make tteokbokki", "recipe"], ["japchae ingredients", "recipe"], ["bibimbap at home", "recipe"],
    ["gamjatang maangchi", "recipe"], ["easy korean side dishes", "recipe"],
    // 서비스·잡음
    ["korean fried chicken delivery", "service"], ["samgyeopsal pronunciation", "noise"], ["naju gomtang flushing", "noise"], ["andong jjimdak reviews", "noise"],
  ];
  for (const [topic, reason] of rejects) assert(foodTopicRejection(topic) === reason, `${topic} -> ${reason} (실제 ${foodTopicRejection(topic)})`);
  // 재료 이름이 든 요리는 살린다 - 재료가 아니라 음식이다.
  for (const ok of ["doenjang jjigae", "korean seaweed soup", "sundubu jjigae vs kimchi jjigae", "gochujang chicken", "korean rice cake soup", "kimchi jjigae is it spicy", "what to eat in jeonju", "busan food specialties", "korean hangover soup"]) {
    assert(foodTopicRejection(ok) === null, `음식으로 살아야 한다: ${ok} (실제 ${foodTopicRejection(ok)})`);
  }
  assert((AVERSIVE_FOOD_TERMS as readonly string[]).includes("dog meat") && (AVERSIVE_FOOD_TERMS as readonly string[]).includes("beondegi"), "혐오 식품 목록은 상수 한 곳");
  // 모양: 음식 이름이 든 2단어는 받고, 아닌 2단어는 버린다(생활 모드는 3단어 이상 그대로).
  assert(hasUsableShape("busan milmyeon", "food") && hasUsableShape("andong jjimdak", "food") && !hasUsableShape("busan food", "food"), "음식 모드 2단어");
  assert(!hasUsableShape("busan milmyeon", "legacy"), "생활 모드는 2단어 불가 그대로");
  console.log(`  ✅ 제외 3종(혐오·식재료·레시피)+서비스·잡음 ${rejects.length}건 · 재료 이름 든 요리는 통과 · 2단어 음식`);

  // ---------- 4. 후보 구성(실측 모양 fixture, 2026-11-25 자동완성) ----------
  const obs = [
    { suggestion: "chuncheon dakgalbi", seed: "chuncheon dakgalbi", position: 0 },
    { suggestion: "chuncheon dakgalbi street", seed: "chuncheon dakgalbi", position: 1 },
    { suggestion: "chuncheon dakgalbi recipe", seed: "chuncheon dakgalbi", position: 2 },
    { suggestion: "chuncheon nami island", seed: "chuncheon dakgalbi", position: 3 },
    { suggestion: "chuncheon dakgalbi near me", seed: "chuncheon dakgalbi", position: 4 },
    { suggestion: "what happens if a mosquito lands on your food", seed: "sokcho food", position: 0, source: "autocomplete_variant" as const },
    { suggestion: "sokcho food market", seed: "sokcho food", position: 1 },
    { suggestion: "can undercooked bread make you sick", seed: "soboro bread", position: 0, source: "autocomplete_variant" as const },
    { suggestion: "soboro bread origin", seed: "soboro bread", position: 1, source: "autocomplete_variant" as const },
    { suggestion: "hotteok tulsa", seed: "hotteok", position: 0, source: "autocomplete_variant" as const },
    { suggestion: "hotteok ice cream", seed: "hotteok", position: 1, source: "autocomplete_variant" as const },
  ];
  const candidates = buildCandidates(obs, KOREAPLAIN_LABEL_BY_SEED, { mode: "food" });
  const topics = candidates.map((c) => c.topic).sort();
  assert(
    JSON.stringify(topics) === JSON.stringify(["chuncheon dakgalbi", "chuncheon dakgalbi street", "hotteok ice cream", "soboro bread origin", "sokcho food market"]),
    `음식 후보(레시피·비음식·near me·범용어로 샌 질의·의도 없는 변형 제외): ${topics.join(" / ")}`
  );
  assert(candidates.find((c) => c.topic === "chuncheon dakgalbi")?.subLabel === "Regional Food" && candidates.find((c) => c.topic === "hotteok ice cream")?.subLabel === "Street Food & Desserts", "후보에 하위 라벨");
  assert(hasIntentSignal("jeonju bibimbap history", "jeonju bibimbap", "food") && !hasIntentSignal("hotteok tulsa", "hotteok", "food"), "음식 모드 변형 의도어");
  // 생활 모드였다면 2단어·비음식이 다르게 걸린다 - 모드가 실제로 갈린다.
  assert(!buildCandidates(obs, KOREAPLAIN_LABEL_BY_SEED, { mode: "legacy" }).some((c) => c.topic === "chuncheon dakgalbi"), "생활 모드는 2단어 후보를 받지 않는다");
  console.log("  ✅ 후보: 음식 게이트·시드 고유어 요구·변형 의도어·하위 라벨");

  // ---------- 5. 점수 ----------
  const mk = (topic: string, over: Partial<TopicCandidate> = {}): TopicCandidate => ({
    topic, seed: "x", label: "Food & Dining", subLabel: "Korean Dishes", hits: 1, bestPosition: 3, ...over,
  });
  const regional = scoreTopic(mk("jeonju bibimbap vs bibimbap"), "food");
  const generic = scoreTopic(mk("bibimbap vs dolsot bowl"), "food");
  assert(isRegionalFoodTopic("jeonju bibimbap vs bibimbap") && regional.localEdge === 15 && regional.saturation === 0, "지역 변형 = 향토 +15, 초포화 감점 없음");
  assert(isSaturatedFoodTopic("what is bibimbap") && !isSaturatedFoodTopic("kimchi jjigae vs soondubu") && !isSaturatedFoodTopic("bulgogi vs galbi"), "초포화는 일반형만(다른 요리 이름이 있으면 아니다)");
  assert(regional.total > generic.total, `지역 변형 > 일반형(${regional.total} vs ${generic.total})`);
  const spicy = scoreTopic(mk("is andong jjimdak spicy"), "food");
  assert(spicy.foodAngle === 15 && spicy.operational === 0 && spicy.localEdge === 15, "음식 각도 +15 · 운영 정보 축 꺼짐 · 향토 +15");
  assert(scoreTopic(mk("korean hangover soup is it spicy"), "food").localEdge === 15, "한국인의 먹는 때(hangover)도 로컬 우위");
  assert(scoreTopic(mk("korean bus fare how much"), "food").operational === 0 && scoreTopic(mk("korean bus fare how much"), "legacy").operational === 15, "운영 정보 축은 생활 모드에만");
  assert(scoreTopic(mk("busan milmyeon", { bestPosition: 0 }), "food").specificity === 8, "2단어 구체성 8");
  const capped = scoreTopic(mk("what is jeonju bibimbap made of", { hits: 3, bestPosition: 0 }), "food");
  assert(capped.total === 100, `총점 상한 100(실제 ${capped.total})`);
  const ranked = toRankedKeywords([{ ...mk("is andong jjimdak spicy", { subLabel: "Regional Food" }), score: spicy }]);
  assert(ranked[0].reason.startsWith("Food & Dining › Regional Food") && ranked[0].reason.includes("향토·로컬 +15") && ranked[0].reason.includes("음식 각도 +15"), `사유 표기(${ranked[0].reason})`);
  assert(Object.keys(ranked[0].scoreBreakdown).sort().join() === "clickPotential,contentDemand,crossSourceSignal,freshness,newsVelocity,total,trendMomentum", "DB scoreBreakdown 모양 불변");
  assert(toRankedKeywords([{ ...mk("what is bibimbap"), score: scoreTopic(mk("what is bibimbap"), "food") }])[0].reason.includes("초포화 음식 -10"), "초포화 사유 표기");
  console.log(`  ✅ 점수: 향토 +15 · 음식 각도 +15 · 초포화 일반형 -10(지역 변형 면제) · 운영 축 꺼짐 · 상한 100`);

  // ---------- 6. 선정 ----------
  assert(defaultRegionalFoodFloor(5) === 2, "향토 하한 topN=5면 2건");
  const dishes = ["galbitang vs seolleongtang", "kimchi jjigae vs soondubu", "haejangguk is it spicy", "jjolmyeon vs naengmyeon", "sujebi vs kalguksu"]
    .map((topic) => mk(topic, { subLabel: "Korean Dishes", bestPosition: 0, hits: 3 }));
  const streets = ["bungeoppang vs taiyaki", "hoppang vs jjinppang"].map((topic) => mk(topic, { subLabel: "Street Food & Desserts", bestPosition: 1, hits: 2 }));
  const regionals = ["busan milmyeon restaurant", "naju gomtang history"].map((topic) => mk(topic, { subLabel: "Regional Food", bestPosition: 9 }));
  const picked = selectTopics([...dishes, ...streets, ...regionals], { topN: 5, existingTopics: [], similarity: 0.6, mode: "food" });
  const subCount = (sub: string) => picked.selected.filter((item) => item.subLabel === sub).length;
  assert(picked.selected.length === 5, "5건 채움");
  assert(subCount("Regional Food") === 2, `점수가 낮아도 향토 하한 2건(실제 ${subCount("Regional Food")})`);
  assert(subCount("Korean Dishes") <= 2 && subCount("Street Food & Desserts") >= 1, `하위 라벨 상한 2(대표 요리 ${subCount("Korean Dishes")} · 길거리 ${subCount("Street Food & Desserts")})`);
  // 실용 하한은 꺼져 있다 - 음식 후보만 있어도 Living in Korea를 찾지 않는다.
  assert(picked.selected.every((item) => item.label === "Food & Dining"), "실용 하한 없음");
  // 기발행 중복은 그대로 걸린다.
  const withHistory = selectTopics(regionals, { topN: 5, existingTopics: ["busan milmyeon restaurant guide"], similarity: 0.6, mode: "food" });
  assert(!withHistory.selected.some((item) => item.topic === "busan milmyeon restaurant"), "기발행과 포함 관계면 중복");
  console.log("  ✅ 선정: 향토 하한 2 · 하위 라벨 상한 2 · 실용 하한 꺼짐 · 중복 제거 그대로");

  // ---------- 7. 시드 회전 ----------
  const day = pickSeedsForDay(KOREAPLAIN_FOOD_SEEDS, 20782, 20);
  const daySubs = new Set(day.map((seed) => seed.subLabel));
  assert(day.length === 20 && daySubs.size === 3, `하루 20개가 하위 라벨 3개에 섞인다(${[...daySubs].join(",")})`);
  const covered = new Set<string>();
  for (let d = 0; d < 12; d += 1) pickSeedsForDay(KOREAPLAIN_FOOD_SEEDS, d, 20).forEach((seed) => covered.add(seed.query));
  assert(covered.size === KOREAPLAIN_FOOD_SEEDS.length, `12일 안에 음식 시드 한 바퀴(${covered.size}/${KOREAPLAIN_FOOD_SEEDS.length})`);
  console.log("  ✅ 시드 회전(하위 라벨 혼합·12일 한 바퀴)");

  // ---------- 8. 전체 실행(음식 모드) ----------
  let trendCalls = 0;
  const headers: string[] = [];
  const saved: string[] = [];
  const result = await runKoreaplainTopicCollection({
    mode: "food",
    now: new Date("2026-11-25T12:00:00Z"),
    delayMs: 0,
    seedsPerRun: 6,
    log: () => {},
    fetchSuggestions: async (q) => [`${q}`, `${q} recipe`, `is ${q} spicy`, `${q} history`],
    fetchTrendTerms: async () => {
      trendCalls += 1;
      return ["BTS comeback"];
    },
    loadExistingTopics: async () => [],
    save: async (input) => {
      saved.push(...input.ranked.map((item) => `${item.keyword}|${item.reason.split(" · ")[0]}`));
      return { runId: 5, persisted: true };
    },
    notify: async (opts = {}) => {
      headers.push(opts.headerTitle ?? "");
      return { sent: true, payload: null, messages: [] };
    },
  });
  assert(result.status === "notified" && trendCalls === 0 && result.trendSeeds.length === 0, "음식 모드는 급상승어 시드를 쓰지 않는다");
  assert(result.seedsUsed.every((seed) => KOREAPLAIN_SUBLABEL_BY_SEED[seed]), "음식 시드만 돈다");
  assert(!result.topics.some((topic) => topic.includes("recipe")), "레시피 질의는 제안되지 않는다");
  assert(headers[0].includes("한국 음식"), `알림 헤더(${headers[0]})`);
  assert(saved.every((line) => line.split("|")[1].startsWith("Food & Dining › ")), `저장 사유에 하위 라벨(${saved.join(" / ")})`);
  console.log(`  ✅ 전체 실행: 급상승어 끔 · 음식 시드만 · 레시피 제외 · 헤더 · 사유 하위 라벨(${result.topics.length}건)`);

  assert(KOREAPLAIN_LABELS.length === 5, "상위 라벨 5개 이름 그대로");
  console.log("\n✅ testKoreaplainFoodTopics 통과");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
