// 사용설명서 주제 수집 테스트 - 네트워크·DB 없음(전부 주입).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { KOREAPLAIN_LABEL_BY_SEED, KOREAPLAIN_LABELS, KOREAPLAIN_SEEDS, KOREAPLAIN_TOPIC_CONFIG } from "../../config/koreaplainSeeds.js";
import { buildAutocompleteUrl, parseAutocompleteResponse } from "../../services/search/providers/googleAutocomplete/fetchAutocomplete.js";
import {
  KOREAPLAIN_SUBREDDITS,
  REDDIT_USER_AGENT,
  RedditBlockedError,
  buildRedditNewUrl,
  buildRedditSearchUrl,
  parseRedditListing,
  parseRedditAtom,
  buildTokenRequest,
  redditCredentialsFromEnv,
  toOauthUrl,
} from "../../services/search/providers/reddit/fetchRedditTitles.js";
import {
  LOCAL_EDGE_TERMS,
  MEANING_SATURATED_TERMS,
  OPERATIONAL_TERMS,
  SATURATED_TOURIST_TERMS,
  SCORE_WEIGHTS,
  attachRedditSupport,
  defaultLocalEdgeFloor,
  hasLocalEdge,
  hasOperationalEdge,
  isLocalQuestionTitle,
  isMeaningSaturated,
  isTouristSaturated,
  autocompleteQueriesForSeed,
  buildCandidates,
  hasIntentSignal,
  isOverseasLocalTopic,
  redditTitleSupports,
  defaultPracticalFloor,
  isDuplicateTopic,
  isExcludedTopic,
  isPracticalTopic,
  normalizeTopic,
  pickSeedsForDay,
  scoreTopic,
  selectTopics,
  toRankedKeywords,
  topicContainment,
  topicSimilarity,
} from "./koreaplainTopics.js";
import { KOREAPLAIN_RUN_KIND, koreaplainJobTopics, koreaplainProposalRuns } from "./koreaplainExistingTopics.js";
import { KOREAPLAIN_JOB_KIND, dayIndexOf, redditQueryForSeed, runKoreaplainTopicCollection } from "./runKoreaplainTopicCollection.js";

function assert(c: unknown, m: string): asserts c {
  if (!c) throw new Error(`❌ ${m}`);
}

async function main(): Promise<void> {
  // 시드 구성
  assert(KOREAPLAIN_SEEDS.length >= 50, "기본 시드는 50개 이상");
  assert(KOREAPLAIN_LABELS.every((label) => KOREAPLAIN_SEEDS.some((seed) => seed.label === label)), "모든 라벨에 시드가 있다");
  assert(new Set(KOREAPLAIN_SEEDS.map((s) => s.query)).size === KOREAPLAIN_SEEDS.length, "시드 중복 없음");
  assert(KOREAPLAIN_LABEL_BY_SEED["korean bbq"] === "Food & Dining", "시드 -> 라벨");

  // 체류 실용 축(2026-10-11, §C): 기획⑤ 확정본 100개를 지우지 않고 누적했고, 실용 시드가 들어와 있다.
  assert(KOREAPLAIN_SEEDS.length === 241, `시드 총량 241개(기획⑤ 100 + 실용 17 + 로컬 우위 47 + 운영 정보 77, 실제 ${KOREAPLAIN_SEEDS.length})`);
  const seedsByLabel = new Map<string, number>();
  for (const seed of KOREAPLAIN_SEEDS) seedsByLabel.set(seed.label, (seedsByLabel.get(seed.label) ?? 0) + 1);
  assert(seedsByLabel.get("Living in Korea") === 60 && seedsByLabel.get("Travel & Transit") === 53, `라벨별 시드 수: ${JSON.stringify([...seedsByLabel])}`);
  // 로컬 우위 시드(2026-10-30): 자동완성이 비는 긴 질의는 걸러 라벨마다 개수가 다르다.
  for (const [label, count] of [["Food & Dining", 43], ["Culture & Etiquette", 45], ["K-Wave Context", 40]] as const) {
    assert(seedsByLabel.get(label) === count, `${label}는 기획⑤ 확정본 20개 + 로컬 우위·운영 정보 ${count - 20}개(실제 ${seedsByLabel.get(label)})`);
  }
  for (const practical of ["korea prepaid usim", "korea resident registration move", "korea utility bill payment", "korea garbage bag rules", "korea bus subway transfer", "korea traffic signals"]) {
    assert(KOREAPLAIN_SEEDS.some((seed) => seed.query === practical), `실용 시드가 있어야 한다: ${practical}`);
  }
  // 실용 시드에서 나오는 주제가 제외 규칙(정치·성인·저가치)에 걸리지 않아야 한다 - 걸리면 시드가 헛돈다.
  for (const topic of ["korea prepaid usim activation guide", "korea resident registration move report", "how to pay korea utility bill online", "jaywalking rules in korea"]) {
    assert(!isExcludedTopic(topic), `실용 주제가 제외되면 안 된다: ${topic}`);
  }
  console.log("  ✅ 시드 구성 + 체류 실용 축(117개, 라벨별 분포)");

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

  // ---------- A. 한국 밖 지역 노이즈(2026-10-28, run 173~209 실측) ----------
  const overseasNoise = [
    "korean dessert cafe fort lee", "korean karaoke fort worth", "korean bbq santa rosa", "seoul street food deventer",
    "korean michelin star boston", "korean funeral customs in america", "korean driver s license exchange canada",
    "korean dessert cafe vancouver",
    // 10/28 자동완성 실측(변형 "korean breakfast g" 등)
    "korean breakfast gainesville", "korean breakfast gold coast", "korean breakfast duluth ga", "korean language course glasgow",
    "korea travel budget philippines", "korean michelin restaurants nyc",
    "aiea korean culture school", "green mountain korean culture school", // 지명 없이 오는 해외 한글학교
  ];
  for (const noise of overseasNoise.slice(0, 8)) assert(isOverseasLocalTopic(noise), `실측 8건은 지명 규칙으로 걸린다: ${noise}`);
  for (const noise of overseasNoise) {
    assert(isExcludedTopic(noise), `해외 지역 노이즈는 제외: ${noise}`);
  }
  const domesticOrComparison = [
    "bowing in korea vs japan angles", "jeju island trip cost", "incheon airport to seoul with luggage", "korean driver license exchange",
    // 한국 지명·비교·국적 형용사·한국 안의 고유명사는 살린다
    "korean breakfast gangnam", "busan travel itinerary 3 days", "hongdae myeongdong shopping guide", "korea cost of living vs canada",
    "korea visa for american citizens", "korean chinese food jajangmyeon", "paris baguette korea menu", "london bagel museum seoul",
    "korea mobile banking for foreigners",
  ];
  for (const ok of domesticOrComparison) {
    assert(!isOverseasLocalTopic(ok) && !isExcludedTopic(ok), `한국 주제·비교는 살린다: ${ok}`);
  }
  // 시드 자체가 지명 규칙에 걸리면 그 시드는 헛돈다.
  for (const seed of KOREAPLAIN_SEEDS) assert(!isOverseasLocalTopic(seed.query), `시드가 해외 지명 규칙에 걸리면 안 된다: ${seed.query}`);
  console.log(`  ✅ 해외 지명 노이즈 제외(실측 ${overseasNoise.length}건) · 한국 지명·비교 주제 유지(${domesticOrComparison.length}건)`);

  // 변형 질의 결과는 안내 의도어가 있어야 후보가 된다(목록 밖 작은 도시를 받는 2차 그물).
  assert(!hasIntentSignal("korean breakfast tulsa") && hasIntentSignal("korean language learning guide") && hasIntentSignal("incheon airport layover what to do"), "의도어 판정");
  const variantObs = [
    { suggestion: "korean breakfast tulsa", seed: "korean breakfast", position: 0, source: "autocomplete_variant" as const }, // 목록 밖 도시
    { suggestion: "korean breakfast to go", seed: "korean breakfast", position: 1, source: "autocomplete_variant" as const }, // 의도 없음
    { suggestion: "korean breakfast foods list", seed: "korean breakfast", position: 2, source: "autocomplete_variant" as const },
    { suggestion: "korean breakfast toast", seed: "korean breakfast", position: 3, source: "autocomplete" as const }, // 기본 질의는 그대로
    // 10/28 dry-run 실측: 시드 낱말(culture)은 의도어로 치지 않는다
    { suggestion: "green mountain korean culture school", seed: "korean school culture", position: 0, source: "autocomplete_variant" as const },
  ];
  const variantCandidates = buildCandidates(variantObs).map((c) => c.topic);
  assert(
    JSON.stringify(variantCandidates.sort()) === JSON.stringify(["korean breakfast foods list", "korean breakfast toast"]),
    `변형 결과는 의도어가 있어야 한다: ${variantCandidates.join(" / ")}`
  );
  console.log("  ✅ 변형 질의 결과에 안내 의도어 요구(기본 질의는 그대로)");

  // ---------- B. korea/korean 정규화(2026-10-28) ----------
  const phonePair = topicSimilarity("korean phone plans for foreigners", "korea phone plans");
  assert(phonePair >= 0.6, `korea/korean을 접으면 중복이다(전 0.40, 지금 ${phonePair.toFixed(2)})`);
  assert(isDuplicateTopic("korean phone plans for foreigners", ["korea phone plans"], 0.6), "기발행 korea phone plans와 중복");
  assert(topicSimilarity("south korea cost of living", "korean cost of living") === 1, "south korea = korean");
  const tmoneyPair = topicSimilarity("t money card cost", "t money card where to buy");
  assert(tmoneyPair < 0.6 && Math.abs(tmoneyPair - 0.5) < 1e-9, `다른 글은 임계값 0.6 아래로 남는다(${tmoneyPair})`);
  assert(topicSimilarity("seoul subway guide", "korea subway guide") < 0.6, "seoul은 korea로 접지 않는다");
  // 학생 보험과 일반 외국인 보험(번호 안내)은 다른 글로 둔다 - 정규화 후에도 0.43.
  const insurancePair = topicSimilarity("korean health insurance for foreign students", "korean health insurance for foreigners number");
  assert(insurancePair < 0.6, `foreign/foreigner는 접지 않는다(${insurancePair.toFixed(2)})`);
  console.log(`  ✅ korea/korean 정규화(phone ${phonePair.toFixed(2)} 중복 · t money ${tmoneyPair.toFixed(2)} 비중복 · seoul 별개)`);

  // ---------- C. 레딧 교차 신호(2026-10-28) ----------
  assert(buildRedditNewUrl(KOREAPLAIN_SUBREDDITS).startsWith("https://www.reddit.com/r/koreatravel+Living_in_Korea+living_in_korea_now/new.json?"), "레딧 묶음 new URL");
  assert(buildRedditNewUrl(["koreatravel"], 100, "rss").startsWith("https://www.reddit.com/r/koreatravel/new.rss?limit=100"), "레딧 RSS new URL");
  assert(JSON.stringify(parseRedditAtom('<feed><title>newest</title><entry><title>Do taxis charge for luggage?</title></entry><entry><title>Renting &amp; goshiwon &#39;tips&#39;</title></entry><entry><link/></entry></feed>')) === '["Do taxis charge for luggage?","Renting & goshiwon \'tips\'"]', "Atom 제목 파싱(피드 제목 제외·엔티티 복원)");
  const searchUrl = buildRedditSearchUrl(KOREAPLAIN_SUBREDDITS, "phone plan");
  assert(searchUrl.includes("/search.json?") && searchUrl.includes("q=phone+plan") && searchUrl.includes("restrict_sr=1") && searchUrl.includes("sort=new"), "레딧 검색 URL");
  assert(!/mozilla|chrome|safari/i.test(REDDIT_USER_AGENT) && REDDIT_USER_AGENT.startsWith("blog-automation-kscene/"), "User-Agent는 위장하지 않는다");
  assert(JSON.stringify(parseRedditListing({ data: { children: [{ data: { title: " Q about ARC " } }, { data: {} }, null] } })) === '["Q about ARC"]', "레딧 Listing 파싱");
  assert(parseRedditListing({ nope: 1 }).length === 0 && parseRedditListing(null).length === 0, "레딧 모양이 다르면 빈 배열");
  assert(redditQueryForSeed("korea phone plan") === "phone plan" && redditQueryForSeed("south korea") === "", "레딧 검색어는 korea를 뺀다");

  assert(redditTitleSupports("korea bank account for foreigners", "Question about ARC and bank account???"), "질문 제목이 후보를 뒷받침");
  assert(!redditTitleSupports("korea bank account for foreigners", "Best bank in Seoul?"), "한 단어 일치는 뒷받침이 아니다");
  assert(!redditTitleSupports("korea winter guide", "Winter in Korea"), "핵심 토큰 1개짜리 후보는 뒷받침을 받지 않는다");
  const baseCandidate = { topic: "korea bank account for foreigners", seed: "korea bank account foreigner", label: "Living in Korea" as const, hits: 1, bestPosition: 5 };
  const [supported] = attachRedditSupport([baseCandidate], ["Question about ARC and bank account???", "Opening a bank account without ARC", "Best kimchi?"]);
  assert(supported.redditHits === 2 && supported.redditExample === "Question about ARC and bank account???", "뒷받침 수·예시");
  assert(scoreTopic(supported).crossSignal === 10 && scoreTopic(baseCandidate).crossSignal === 0, "레딧 2건 = 교차 신호 +10");
  assert(scoreTopic({ ...supported, hits: 3 }).crossSignal === 15, "교차 신호 상한 15");
  assert(attachRedditSupport([baseCandidate], ["How do I open a bank account in Korea as a foreigner"]).length === 1, "레딧은 후보를 새로 만들지 않는다");
  const rankedReddit = toRankedKeywords([{ ...supported, score: scoreTopic(supported) }]);
  assert(rankedReddit[0].sources.includes("reddit") && rankedReddit[0].reason.includes("레딧 질문 2건"), "출처·사유에 레딧 표시");
  console.log("  ✅ 레딧 교차 신호(URL·UA·파싱·포함률 매칭·+10 가산·후보 미생성·출처 표시)");

  // OAuth(app-only) 경로(2026-10-28 저녁): 자격증명이 둘 다 있을 때만 켜지고, URL은 호스트만 바뀐다.
  assert(redditCredentialsFromEnv({}) === null && redditCredentialsFromEnv({ REDDIT_CLIENT_ID: "id" }) === null, "자격증명이 하나라도 없으면 공개 경로");
  assert(JSON.stringify(redditCredentialsFromEnv({ REDDIT_CLIENT_ID: " id ", REDDIT_CLIENT_SECRET: "sec" })) === '{"clientId":"id","clientSecret":"sec"}', "자격증명 trim");
  assert(toOauthUrl(buildRedditNewUrl(KOREAPLAIN_SUBREDDITS)).startsWith("https://oauth.reddit.com/r/koreatravel+Living_in_Korea+living_in_korea_now/new.json?"), "OAuth 호스트로 교체");
  assert(toOauthUrl("https://example.com/x") === "https://example.com/x", "레딧 밖 주소는 그대로");
  const tokenReq = buildTokenRequest({ clientId: "id", clientSecret: "sec" });
  assert(tokenReq.headers.Authorization === `Basic ${Buffer.from("id:sec").toString("base64")}` && tokenReq.body === "grant_type=client_credentials" && tokenReq.headers["User-Agent"].startsWith("blog-automation-kscene/"), "토큰 요청 모양");
  console.log("  ✅ 레딧 OAuth 경로(자격증명 판정·호스트 교체·토큰 요청)");

  // 시드 선정: 개수·라벨 혼합·날짜로 회전
  const day0 = pickSeedsForDay(KOREAPLAIN_SEEDS, 0, 20);
  const day1 = pickSeedsForDay(KOREAPLAIN_SEEDS, 1, 20);
  assert(day0.length === 20 && new Set(day0.map((s) => s.query)).size === 20, "20개, 중복 없음");
  assert(new Set(day0.map((s) => s.label)).size === KOREAPLAIN_LABELS.length, "라벨이 섞인다");
  assert(day0.map((s) => s.query).join() !== day1.map((s) => s.query).join(), "날짜가 바뀌면 시드가 돈다");
  const covered = new Set<string>();
  for (let d = 0; d < 15; d += 1) pickSeedsForDay(KOREAPLAIN_SEEDS, d, 20).forEach((s) => covered.add(s.query));
  assert(covered.size === KOREAPLAIN_SEEDS.length, `15일 안에 전체 시드가 한 바퀴(Living 60개 ÷ 하루 4개, ${covered.size}/${KOREAPLAIN_SEEDS.length})`);
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
  // 서로 다른 주제 12개여야 한다(2026-11-14): 전에는 `... number${i} guide`로 찍어 냈는데, 토큰 5개 중 4개가
  // 같아 포함 관계 중복 규칙에 걸린다 - 라벨 상한을 보려던 fixture가 중복 제거를 보게 된다.
  const manyFoodTopics = [
    "korean bbq grill order", "kimchi fridge rental price", "banchan refill rules", "soju bottle cap game",
    "convenience store lunch box", "korean bakery opening hours", "street toast vendor payment", "jokbal delivery minimum",
    "temple food reservation", "makgeolli brewery tour", "hangover soup late night", "halal butcher itaewon",
  ];
  const many = manyFoodTopics.map((topic, i) => ({ topic, seed: "korean bbq", label: "Food & Dining" as const, hits: 1, bestPosition: i % 3 }));
  const other = [{ topic: "seoul subway transfer guide tips", seed: "korea subway", label: "Travel & Transit" as const, hits: 1, bestPosition: 8 }];
  const mixed = selectTopics([...many, ...other], { topN: 6, existingTopics: [], similarity: 0.95 });
  assert(mixed.selected.some((s) => s.label === "Travel & Transit"), "점수가 낮아도 다른 라벨이 상한 덕에 들어온다");
  assert(mixed.selected.length === 6, "모자라면 남은 후보로 채운다");
  console.log("  ✅ 라벨 다양성 상한");

  // ---------- 체류 실용 정보 하한(2026-10-11, §C) ----------
  assert(isPracticalTopic("how to use t money card in korea", "Travel & Transit"), "환승·교통카드는 실용");
  assert(isPracticalTopic("korea arc renewal documents", "Living in Korea"), "Living in Korea 라벨은 그 자체로 실용");
  assert(isPracticalTopic("korea hospital appointment for foreigners", "Culture & Etiquette"), "라벨이 달라도 의료 실무는 실용");
  assert(!isPracticalTopic("korean dining etiquette rules for guests", "Culture & Etiquette"), "문화 소개는 실용으로 세지 않는다(범용 의도어 'rules'에 걸리면 안 된다)");
  assert(!isPracticalTopic("korea cherry blossom season best spots", "Travel & Transit"), "관광 시즌 주제는 실용 아님");
  assert(defaultPracticalFloor(8) === 3 && defaultPracticalFloor(1) === 1, `하한 기본값(${defaultPracticalFloor(8)})`);

  // 문화 후보가 점수를 독점해도 실용 주제가 하한만큼 올라온다(개편 전에는 0~1건으로 밀렸다).
  // 서로 다른 문화 후보 10개(2026-11-14 - 복제 fixture는 포함 관계 중복 규칙에 걸린다. 위 라벨 상한 fixture와 같은 이유).
  const culturalTopics = [
    "seollal bow money custom", "chuseok ancestral rite table", "wedding cash gift amount", "funeral dress code rules",
    "housewarming gift tissue", "name stamp dojang making", "red ink name taboo", "fan death belief origin",
    "first birthday doljanchi table", "lunar calendar age counting",
  ];
  const cultural = culturalTopics.map((topic) => ({ topic, seed: "korean etiquette", label: "Culture & Etiquette" as const, hits: 3, bestPosition: 0 }));
  const practicalCandidates = [
    { topic: "how to pay korea utility bill online", seed: "korea utility bill payment", label: "Living in Korea" as const, hits: 1, bestPosition: 9 },
    { topic: "korea bus subway transfer discount rules", seed: "korea bus subway transfer", label: "Travel & Transit" as const, hits: 1, bestPosition: 9 },
    { topic: "korea prepaid usim activation for foreigners", seed: "korea prepaid usim", label: "Living in Korea" as const, hits: 1, bestPosition: 9 },
  ];
  const withFloor = selectTopics([...cultural, ...practicalCandidates], { topN: 8, existingTopics: [], similarity: 0.95 });
  const practicalPicked = withFloor.selected.filter((s) => isPracticalTopic(s.topic, s.label));
  assert(practicalPicked.length >= 3, `실용 하한 3건이 보장돼야 한다 (실제 ${practicalPicked.length}건: ${withFloor.selected.map((s) => s.topic).join(" / ")})`);
  assert(withFloor.selected.length === 8, "하한을 적용하고도 topN을 채운다");
  // 하한이 라벨 상한을 무너뜨려 한 라벨을 독점하지 않는다.
  const livingCount = withFloor.selected.filter((s) => s.label === "Living in Korea").length;
  assert(livingCount <= Math.max(2, Math.ceil(8 / 3)), `하한도 라벨 상한을 지켜야 한다 (Living ${livingCount}건)`);

  // 실용 후보가 하한보다 적으면 있는 만큼만 - 억지로 채우지 않는다.
  const scarce = selectTopics([...cultural, practicalCandidates[0]], { topN: 8, existingTopics: [], similarity: 0.95 });
  assert(scarce.selected.filter((s) => isPracticalTopic(s.topic, s.label)).length === 1, "실용 후보가 1건이면 1건만");
  assert(scarce.selected.length === 8, "실용이 모자라도 topN은 채운다");

  // 하한을 끄면 옛 동작(라벨 상한만)
  const noFloor = selectTopics([...cultural, ...practicalCandidates], { topN: 3, existingTopics: [], similarity: 0.95, practicalFloor: 0 });
  assert(noFloor.selected.every((s) => s.label === "Culture & Etiquette") === false || noFloor.selected.length === 3, "practicalFloor=0은 하한 없음");
  console.log("  ✅ 체류 실용 정보 하한(문화 쏠림에도 3건 보장 · 후보 부족이면 있는 만큼 · 라벨 상한 유지)");

  // 전체 실행(주입): 저장·알림 호출 계약
  const calls: string[] = [];
  const dry = await runKoreaplainTopicCollection({
    now: new Date("2026-10-07T12:00:00Z"),
    delayMs: 0,
    seedsPerRun: 4,
    fetchSuggestions: async (q) => [`${q} guide for first time visitors`, `how to ${q} in korea`],
    fetchTrendTerms: async () => ["Korea earthquake drill", "random celebrity", "BTS comeback"],
    loadExistingTopics: async () => [],
    dryRun: true,
  });
  assert(dry.status === "dry_run" && dry.topics.length > 0 && dry.trendSeeds.length === 2, `dry-run(급상승 한국 관련어만 시드로: ${dry.trendSeeds.join("|")})`);

  const full = await runKoreaplainTopicCollection({
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

  const none = await runKoreaplainTopicCollection({ now: new Date(), delayMs: 0, seedsPerRun: 2, fetchSuggestions: async () => [], fetchTrendTerms: async () => [], loadExistingTopics: async () => [], log: () => {} });
  assert(none.status === "no_candidates" && none.runId === null, "후보 0이면 no_candidates(저장·알림 없음)");
  const saveFail = await runKoreaplainTopicCollection({
    now: new Date(), delayMs: 0, seedsPerRun: 2, fetchTrendTerms: async () => [], loadExistingTopics: async () => [], log: () => {},
    fetchSuggestions: async (q) => [`${q} complete guide here`],
    save: async () => ({ runId: null, persisted: false, error: "x" }),
  });
  assert(saveFail.status === "save_failed", "저장 실패는 알림 없이 save_failed");
  // 레딧 스위치: 꺼짐이면 호출 0회, 켜짐이면 묶음 new + 시드별 search, 403·429면 그 자리에서 멈추고 진행.
  const redditUrls: string[] = [];
  const redditBase = {
    now: new Date("2026-10-07T12:00:00Z"), delayMs: 0, redditDelayMs: 0, seedsPerRun: 3, dryRun: true, log: () => {},
    fetchTrendTerms: async () => [], loadExistingTopics: async () => [],
    fetchSuggestions: async (q: string) => [`${q} guide for first time visitors`],
  };
  const redditOff = await runKoreaplainTopicCollection({ ...redditBase, redditEnabled: false, fetchRedditTitles: async (url) => { redditUrls.push(url); return []; } });
  assert(redditOff.reddit.status === "disabled" && redditUrls.length === 0, "레딧 꺼짐이면 호출 없음");
  const redditOn = await runKoreaplainTopicCollection({ ...redditBase, redditEnabled: true, redditCredentials: { clientId: "id", clientSecret: "sec" }, fetchRedditTitles: async (url) => { redditUrls.push(url); return ["Any guide for first time visitors?"]; } });
  assert(redditOn.status === "dry_run" && redditOn.reddit.status === "ok" && redditOn.reddit.requests === redditUrls.length && redditUrls[0].includes("/new.json") && redditUrls.some((u) => u.includes("/search.json")), `레딧 OAuth 모드(${redditOn.reddit.requests}회)`);
  const rssUrls: string[] = [];
  const redditRss = await runKoreaplainTopicCollection({ ...redditBase, redditEnabled: true, redditCredentials: null, fetchRedditTitles: async (url) => { rssUrls.push(url); return []; } });
  assert(redditRss.reddit.requests === 3 && rssUrls.every((u) => u.includes("/new.rss?")) && rssUrls[0].includes("/r/koreatravel/"), `레딧 RSS 모드는 서브레딧별 new.rss 3회(${rssUrls.length})`);
  let blockedCalls = 0;
  const redditBlocked = await runKoreaplainTopicCollection({ ...redditBase, redditEnabled: true, fetchRedditTitles: async () => { blockedCalls += 1; throw new RedditBlockedError(429); } });
  assert(redditBlocked.status === "dry_run" && redditBlocked.reddit.status === "blocked" && blockedCalls === 1 && redditBlocked.topics.length > 0, "429면 레딧만 건너뛰고 제안은 나간다");
  const redditFailed = await runKoreaplainTopicCollection({ ...redditBase, redditEnabled: true, fetchRedditTitles: async () => { throw new Error("ECONNRESET"); } });
  assert(redditFailed.status === "dry_run" && redditFailed.reddit.status === "failed", "레딧 전부 실패도 비치명적");
  console.log("  ✅ 레딧 스위치·OAuth/RSS 모드·차단·실패(비치명적)");

  assert(dayIndexOf(new Date("2026-10-07T15:00:00Z")) === dayIndexOf(new Date("2026-10-07T14:59:00Z")) + 1, "일 경계는 KST 자정(UTC 15:00)");
  console.log("  ✅ 전체 실행 계약(부분 실패 허용·저장→알림·후보0·저장실패)");

  // ---------- 로컬 우위 축(2026-10-30, §C) ----------
  const mk = (topic: string, over: Partial<{ label: (typeof KOREAPLAIN_LABELS)[number]; hits: number; bestPosition: number; redditHits: number; redditLocalQuestion: boolean }> = {}) => ({
    topic, seed: "x", label: over.label ?? ("Culture & Etiquette" as const), hits: over.hits ?? 1, bestPosition: over.bestPosition ?? 3,
    ...(over.redditHits !== undefined ? { redditHits: over.redditHits } : {}),
    ...(over.redditLocalQuestion ? { redditLocalQuestion: true } : {}),
  });

  // 새 시드 47개(개정안 50개 중 자동완성이 비는 긴 질의를 2~3단어로 줄여 실측 통과분만), 기존 117개 유지
  const newSeedQueries = ["priority seat korea", "korea restaurant call button", "korea apartment noise", "korea hospital department", "korean office culture"];
  for (const query of newSeedQueries) assert(KOREAPLAIN_SEEDS.some((seed) => seed.query === query), `로컬 우위 시드가 있어야 한다: ${query}`);
  assert(KOREAPLAIN_LABEL_BY_SEED["korea dong office"] === "Living in Korea" && KOREAPLAIN_LABEL_BY_SEED["korean side dish refill"] === "Food & Dining", "새 시드의 라벨 매핑");
  assert(KOREAPLAIN_SEEDS.slice(0, 117).some((seed) => seed.query === "korea subway") && KOREAPLAIN_SEEDS.some((seed) => seed.query === "korean bbq"), "기존 시드 유지");

  // (a) 로컬 우위 +15
  const plain = mk("korea apartment recycling info");
  const local = mk("korea apartment management office hours");
  assert(hasLocalEdge(local.topic) && !hasLocalEdge(plain.topic), "로컬 우위 용어 판정");
  assert(scoreTopic(local).localEdge === 15 && scoreTopic(plain).localEdge === 0, "로컬 우위 후보 +15");
  assert(scoreTopic(local).total - scoreTopic({ ...local, topic: "korea apartment management hours" }).total === 15, "같은 조건에서 용어 유무 차이는 정확히 15");
  // 정규화: korean/koreans 접기·복수형 접기·불용어를 지우지 않는 구 매칭
  assert(hasLocalEdge("what koreans do on chuseok") && !hasLocalEdge("what korea does on chuseok") && !hasLocalEdge("last minute order"), "구는 연속 토큰 일치");
  assert(hasLocalEdge("korean restaurant refills explained") && hasLocalEdge("do koreans tip"), "복수형·korea 접기 매칭");
  assert(hasLocalEdge("koreans how do you handle noise") && hasLocalEdge("is it rude in south korea to stare"), "질문형 구 매칭");
  assert(!hasLocalEdge("korea travel guide") && !hasLocalEdge("how to use the korea bank"), "일반어만으로는 로컬 우위가 아니다");
  assert(LOCAL_EDGE_TERMS.length === 48 && SATURATED_TOURIST_TERMS.length === 18, "§C-1 용어 전부(로컬 48 · 포화 18)");

  // (b) 포화 -10, 하한 0
  const saturated = mk("korea seoul itinerary 3 days");
  assert(isTouristSaturated(saturated.topic) && !isTouristSaturated("korea seoul subway card"), "포화 용어 판정(korea·seoul은 포화 아님)");
  assert(scoreTopic(saturated).saturation === 10, "포화 감점 10");
  assert(scoreTopic(saturated).total === Math.max(0, SCORE_WEIGHTS.base + scoreTopic(saturated).demand + scoreTopic(saturated).crossSignal + scoreTopic(saturated).specificity + scoreTopic(saturated).intent - 10), "포화는 total에서 10을 뺀다");
  const bottom = scoreTopic({ ...mk("korea itinerary", { bestPosition: 9 }) });
  assert(bottom.total >= 0 && bottom.saturation === 10, "하한 0");
  const floored = scoreTopic(mk("itinerary", { bestPosition: 99 }));
  assert(floored.total === 0 && floored.saturation === 10, `하한 0이 실제로 작동(실제 ${floored.total})`);
  const both = scoreTopic(mk("jeju itinerary for koreans how do you"));
  assert(both.localEdge === 15 && both.saturation === 10, "로컬 우위와 포화가 같이 걸리면 +15 -10");
  assert((SATURATED_TOURIST_TERMS as readonly string[]).every((term) => term !== "korea" && term !== "seoul"), "포화 목록에 korea·seoul 없음");

  // (c) 합계 100
  const maxed = scoreTopic(mk("how to address a boss at work in korea", { hits: 3, bestPosition: 0, redditHits: 2 }));
  assert(maxed.total === 100 || maxed.total === SCORE_WEIGHTS.base + maxed.demand + maxed.crossSignal + maxed.specificity + maxed.intent + maxed.localEdge, "점수 분해 합계");
  assert(SCORE_WEIGHTS.base + SCORE_WEIGHTS.demand + SCORE_WEIGHTS.crossSignal + SCORE_WEIGHTS.specificity + SCORE_WEIGHTS.intent + SCORE_WEIGHTS.localEdge === 100, "가중치 합계 100");
  const ceiling = scoreTopic(mk("how to address a sajangnim in korea", { hits: 3, bestPosition: 0, redditHits: 2 }));
  assert(ceiling.total === 100 && ceiling.demand === 35 && ceiling.crossSignal === 15 && ceiling.specificity === 15 && ceiling.intent === 15 && ceiling.localEdge === 15, `만점 후보가 정확히 100(실제 ${JSON.stringify(ceiling)})`);
  const rankedLocal = toRankedKeywords([{ ...mk("korea gu office vs dong office", { hits: 2 }), score: scoreTopic(mk("korea gu office vs dong office", { hits: 2 })) }]);
  assert(Object.keys(rankedLocal[0].scoreBreakdown).sort().join() === "clickPotential,contentDemand,crossSourceSignal,freshness,newsVelocity,total,trendMomentum", "DB scoreBreakdown 모양 불변");
  assert(rankedLocal[0].reason.includes("로컬 우위 +15"), "사유에 로컬 우위 표기");

  // (d) 레딧 제목 보정
  for (const title of ["Koreans, how do you handle noisy neighbors in apartments?", "Do Koreans really bow to elders at work", "Is it rude in Korea to refuse a drink", "Is it normal in Korea to share a room"]) {
    assert(isLocalQuestionTitle(title), `로컬 질문형 제목: ${title}`);
  }
  assert(!isLocalQuestionTitle("What do Koreans eat on chuseok") && !isLocalQuestionTitle("Question about koreans how do you say hello"), "접두 일치만");
  const noisy = mk("korea apartment noise neighbors");
  const [boosted] = attachRedditSupport([noisy], ["Koreans, how do you handle apartment noise and neighbors?"]);
  const [ordinary] = attachRedditSupport([noisy], ["How to complain about apartment noise from neighbors in Korea"]);
  assert(boosted.redditHits === 1 && boosted.redditLocalQuestion === true && !ordinary.redditLocalQuestion, "로컬 질문형만 표시");
  assert(scoreTopic(boosted).crossSignal === 10 && scoreTopic(ordinary).crossSignal === 5, "로컬 질문형 1건 = 2건으로 센다(+10), 일반 1건 +5");
  assert(scoreTopic({ ...boosted, hits: 3 }).crossSignal === 15, "상한 15 그대로");

  // (e) 로컬 우위 하한
  assert(defaultLocalEdgeFloor(8) === 2 && defaultLocalEdgeFloor(1) === 1, "기본 하한: topN=8이면 2");
  const touristy = ["korea travel guide first time", "korea best food guide", "korea cafe tour guide", "korea shopping guide tips", "korea palace visit guide", "korea nightlife guide tips", "korea hiking trails guide", "korea tea house guide"]
    .map((topic, i) => mk(topic, { label: KOREAPLAIN_LABELS[i % 5], bestPosition: 0, hits: 3 }));
  const localOnes = [mk("korea restaurant call button etiquette", { label: "Food & Dining", bestPosition: 8 }), mk("korea gu office vs dong office", { label: "Living in Korea", bestPosition: 8 })];
  const withLocalFloor = selectTopics([...touristy, ...localOnes], { topN: 4, existingTopics: [], similarity: 0.95, practicalFloor: 0, localEdgeFloor: 2 });
  assert(withLocalFloor.selected.filter((item) => item.score.localEdge > 0).length === 2, "로컬 우위 하한이 점수가 낮은 로컬 후보를 끌어올린다");
  const withoutLocalFloor = selectTopics([...touristy, ...localOnes], { topN: 4, existingTopics: [], similarity: 0.95, practicalFloor: 0, localEdgeFloor: 0 });
  assert(withoutLocalFloor.selected.filter((item) => item.score.localEdge > 0).length === 0, "하한을 끄면 점수순(대조군)");
  const oneLocal = selectTopics([...touristy, localOnes[0]], { topN: 4, existingTopics: [], similarity: 0.95, practicalFloor: 0, localEdgeFloor: 2 });
  assert(oneLocal.selected.length === 4 && oneLocal.selected.filter((item) => item.score.localEdge > 0).length === 1, "후보가 하나뿐이면 있는 만큼만(억지로 채우지 않음)");
  const noLocal = selectTopics(touristy, { topN: 4, existingTopics: [], similarity: 0.95, localEdgeFloor: 2 });
  assert(noLocal.selected.length === 4 && noLocal.selected.every((item) => item.score.localEdge === 0), "로컬 후보가 없으면 그냥 점수순");
  // 실용 하한과 겹침: gu office(Living) 하나가 둘 다 만족 -> 둘 다로 센다
  const overlap = selectTopics([...touristy.filter((item) => item.label !== "Living in Korea"), localOnes[1], mk("apartment management fee breakdown", { label: "Living in Korea", bestPosition: 9 })], { topN: 4, existingTopics: [], similarity: 0.95, practicalFloor: 1, localEdgeFloor: 2 });
  assert(overlap.selected.filter((item) => item.score.localEdge > 0).length === 2, "실용 하한과 겹쳐도 로컬 하한 충족");
  const capped = selectTopics([...touristy.slice(0, 2), ...[1, 2, 3, 4].map((n) => mk(`korea ${n} neighbor noise rules`, { label: "Culture & Etiquette", bestPosition: 8 }))], { topN: 4, existingTopics: [], similarity: 0.95, practicalFloor: 0, localEdgeFloor: 4, perLabelCap: 2 });
  assert(capped.selected.filter((item) => item.label === "Culture & Etiquette").length <= 4, "라벨 상한 로직은 유지(하한이 상한을 깨지 않는 단계)");
  console.log("  ✅ 로컬 우위 +15·포화 -10(하한 0)·합계 100·레딧 로컬 질문 보정·로컬 하한(후보 없으면 안 채움)·시드 241개");

  // ---------- 운영 정보 축·의미 포화·제외 규칙 좁히기(2026-11-09, GSC 실측) ----------
  // 제외 규칙: 1등 글의 주제가 `stock`에 걸려 파이프라인에서 나올 수 없던 사고.
  assert(!isExcludedTopic("korea stock market trading hours"), "거래시간 질의는 제외되지 않는다(1등 글 주제)");
  assert(!isExcludedTopic("is korea stock market open today") && !isExcludedTopic("krx holidays korea stock market"), "제도·거래시간·휴장일 질의도 통과");
  assert(isExcludedTopic("korea stock price chart"), "시세 차트 질의는 여전히 제외");
  for (const q of ["korea stock price", "samsung stock chart", "korea stock forecast", "kospi stock quote", "samsung share price"]) assert(isExcludedTopic(q), `시세 조회 질의 제외: ${q}`);
  for (const q of ["korea news today", "kospi price today", "seoul weather today", "korea news", "korea live"]) assert(isExcludedTopic(q), `시의성 질의 제외: ${q}`);

  // 운영 정보 +15 / 의미 포화 -10
  // 실제 GSC 5+5(2026-11-09 팀장 실측). 수요 위치·관찰 횟수를 같게 두고 질의 문구만 비교한다.
  const winners = ["korea stock market trading hours", "korea traffic lights", "do you need to press crosswalk button", "does uber eats work in korea", "what taxi app does korea use"];
  const losers = ["what does unni mean in korean", "korean honorifics", "is tipping customary in korea", "korean dining etiquette", "what is nunchi in korean"];
  const score = (topic: string) => scoreTopic(mk(topic, { bestPosition: 3, hits: 2 }));
  for (const topic of winners) assert(hasOperationalEdge(topic) && score(topic).operational === 15, `실측 승자는 운영 정보 축에 걸린다: ${topic}`);
  for (const topic of losers) assert(!hasOperationalEdge(topic) && score(topic).operational === 0, `실측 패자는 운영 정보 축에 안 걸린다: ${topic}`);
  // 대소 관계로만 단언한다(가중치를 조정해도 안 깨진다). 최저 승자가 최고 패자보다 높아야 한다 - 역전이 다시 생기면 여기서 깨진다.
  const winnerScores = winners.map((topic) => score(topic).total);
  const loserScores = losers.map((topic) => score(topic).total);
  assert(Math.min(...winnerScores) > Math.max(...loserScores), `최저 승자 > 최고 패자(승자 ${winnerScores.join("/")} · 패자 ${loserScores.join("/")})`);
  assert(isTouristSaturated("is tipping customary in korea") && !isMeaningSaturated("is tipping customary in korea"), "팁 문화는 관광 포화(의미 포화 아님)");
  assert(score("does uber eats work in korea").total > score("what does unni mean in korean").total, "같은 질문형인데 우버이츠가 unni 의미보다 높다(전엔 동점)");

  // 의미 포화: 추상 개념만 -10, 구체적 금기는 살린다
  assert(isMeaningSaturated("what does oppa mean in korean") && isMeaningSaturated("korean honorifics explained") && isMeaningSaturated("korea culture shock tips") && isMeaningSaturated("how to say sorry in korean"), "의미·호칭·추상 개념 판정");
  assert(!isMeaningSaturated("why you shouldnt write names in red ink") && !isMeaningSaturated("korean superstitions about the number four"), "구체적 금기는 의미 포화가 아니다(superstition 미포함)");
  assert((MEANING_SATURATED_TERMS as readonly string[]).every((term) => !term.includes("superstition")), "의미 포화 목록에 superstition 없음");
  assert(score("what does unni mean in korean").meaningSaturation === 10 && score("why you shouldnt write names in red ink").meaningSaturation === 0, "의미 포화 감점 10 / 금기 0");
  assert(score("korea work etiquette hours").total === Math.max(0, SCORE_WEIGHTS.base + score("korea work etiquette hours").demand + score("korea work etiquette hours").crossSignal + score("korea work etiquette hours").specificity + score("korea work etiquette hours").intent + 15 - 10), "가점 15와 의미 감점 10이 같이 걸리면 +15 -10");
  const doubleHit = scoreTopic(mk("korea itinerary meaning", { bestPosition: 99 }));
  assert(doubleHit.saturation === 10 && doubleHit.meaningSaturation === 10 && doubleHit.total === 0, "감점 두 축이 겹쳐도 하한 0");
  assert(OPERATIONAL_TERMS.length === 33 && MEANING_SATURATED_TERMS.length === 14, "용어 수(운영 31+실측 보강 2 · 의미 14)");
  assert(SCORE_WEIGHTS.operational === 15 && SCORE_WEIGHTS.meaningSaturation === 10, "새 가중치");
  const rankedOp = toRankedKeywords([{ ...mk("does uber eats work in korea"), score: score("does uber eats work in korea") }, { ...mk("what does unni mean in korean"), score: score("what does unni mean in korean") }]);
  assert(rankedOp[0].reason.includes("운영 정보 +15") && rankedOp[1].reason.includes("의미 포화 -10"), "사유에 운영 정보·의미 포화 표기");
  assert(Object.keys(rankedOp[0].scoreBreakdown).sort().join() === "clickPotential,contentDemand,crossSourceSignal,freshness,newsVelocity,total,trendMomentum", "DB scoreBreakdown 모양 불변(운영 정보 포함)");

  // 시드: 2026-11-09 추가분(기존 164 유지, 라벨 5개 그대로). 새 시드는 각 라벨 배열 끝에 붙어 있어 라벨별 총량으로 본다.
  const countOf = (label: (typeof KOREAPLAIN_LABELS)[number]) => KOREAPLAIN_SEEDS.filter((seed) => seed.label === label).length;
  const oldCounts = { "Travel & Transit": 35, "Food & Dining": 30, "Culture & Etiquette": 31, "Living in Korea": 41, "K-Wave Context": 27 } as const;
  const addedByLabel = KOREAPLAIN_LABELS.map((label) => countOf(label) - oldCounts[label]);
  const added = addedByLabel.reduce((sum, n) => sum + n, 0);
  assert(added >= 60 && added <= 80, `신규 시드 60~80개(실제 ${added})`);
  assert(addedByLabel.every((n) => n >= 10), `신규 시드가 라벨 5개에 고르게 있다(각 10개 이상, 실제 ${addedByLabel.join("/")})`);
  assert(new Set(KOREAPLAIN_SEEDS.map((seed) => seed.query)).size === KOREAPLAIN_SEEDS.length, "시드 중복 없음");
  for (const query of ["korea subway etiquette", "korea ondol", "korean bbq", "korea delivery apps"]) assert(KOREAPLAIN_SEEDS.some((seed) => seed.query === query), `기존 시드 유지: ${query}`);
  for (const query of ["korea stock market hours", "krx holidays", "uber eats korea", "korea traffic light rules"]) assert(KOREAPLAIN_SEEDS.some((seed) => seed.query === query), `운영 정보 시드: ${query}`);
  console.log("  ✅ 제외 규칙 좁히기(stock·today)·운영 정보 +15·의미 포화 -10(superstition 제외)·승자>패자 대소 단언·신규 시드");

  // ---------- 하루 5건 + 중복 없음(2026-11-14 사용자 요청) ----------
  // 왜 이 절이 있나: 제안이 하루 8건이었고, 중복 판정이 자카드 0.6 하나뿐이라 **한 알림 안에서**
  // 같은 주제가 두 번 나갔다. 실측(run 2026-11-13): "korea stock exchange hours"와 "korea stock market
  // hours in est"가 같은 run에 같이 나갔다(자카드 0.50 - 임계값 아래라 통과). 날짜를 넘는 쪽도 같다:
  // "korean food delivery app"(10/12 제안) 뒤에 "korean food delivery app without phone number"(11/06)가 나갔다.
  assert(KOREAPLAIN_TOPIC_CONFIG.topicsPerRun === 5, `하루 제안은 5건(실제 ${KOREAPLAIN_TOPIC_CONFIG.topicsPerRun})`);
  // 하한·상한은 공식 그대로 두고 topN만 줄인다 - 5건이면 실용 2(40%)·로컬 1(20%)·라벨 상한 2(40%)다.
  assert(defaultPracticalFloor(5) === 2 && defaultLocalEdgeFloor(5) === 1, `topN=5의 하한(실용 ${defaultPracticalFloor(5)} · 로컬 ${defaultLocalEdgeFloor(5)})`);
  assert(defaultPracticalFloor(8) === 3 && defaultLocalEdgeFloor(8) === 2, "topN=8의 하한은 그대로(공식 불변)");

  // 포함 관계 중복(2026-11-14): 토큰 집합이 상대에 거의 들어가면 같은 주제다. 자카드는 긴 쪽의 수식어가
  // 분모를 키워 이걸 못 잡는다. 실측 쌍으로 단언한다.
  const dupPairs: readonly [string, string][] = [
    ["korea stock market hours in est", "korea stock exchange hours"],
    ["korean food delivery app without phone number", "korean food delivery app"],
    ["living in korea as a foreign woman", "living in korea as foreigner"],
    ["olive young tax refund minimum amount", "korea tax refund olive young"],
    ["korean skincare routine day and night", "korean skincare routine order"],
    ["korea autumn foliage forecast 2026", "korea autumn foliage map"],
    ["hong kong vs korea cost of living", "korea cost of living vs us"],
  ];
  for (const [topic, existing] of dupPairs) {
    assert(topicSimilarity(topic, existing) < KOREAPLAIN_TOPIC_CONFIG.duplicateSimilarity, `자카드만으로는 못 잡는 쌍이어야 재현이 된다: ${topic}`);
    assert(isDuplicateTopic(topic, [existing], KOREAPLAIN_TOPIC_CONFIG.duplicateSimilarity), `포함 관계면 중복: "${topic}" ← "${existing}"`);
  }
  // 짧은 시드가 모든 롱테일을 삼키면 안 된다 - 의미 토큰 3개 미만은 포함 판정에서 뺀다.
  assert(!isDuplicateTopic("korea subway etiquette guide", ["korea subway"], 0.6), "토큰 2개짜리는 포함 판정을 걸지 않는다");
  assert(!isDuplicateTopic("korea garbage bag rules", ["korea traffic signal rules"], 0.6), "겹치는 토큰이 적으면 중복 아님");
  assert(topicContainment("korean food delivery app", "korean food delivery app without phone number") === 1, "포함률은 작은 쪽 기준");

  // 같은 알림 안 중복: 한 run에 같은 주제 두 건이 들어오면 한 건만 나간다(날짜를 넘는 쪽과 같은 규칙).
  const sameRun = selectTopics(
    [
      mk("korea stock market hours in est", { label: "Living in Korea", bestPosition: 0 }),
      mk("korea stock exchange hours", { label: "Living in Korea", bestPosition: 1 }),
      mk("korea garbage bag rules guide", { label: "Living in Korea", bestPosition: 2 }),
    ],
    { topN: 5, existingTopics: [], similarity: KOREAPLAIN_TOPIC_CONFIG.duplicateSimilarity, practicalFloor: 0, localEdgeFloor: 0 }
  );
  assert(sameRun.selected.length === 2 && sameRun.droppedAsDuplicate === 1, `한 알림 안 중복 제거(실제 ${sameRun.selected.map((i) => i.topic).join(" | ")})`);

  // 기억 재료: 트랙이 섞이지 않는다. 사용설명서 job·run만 본다.
  const jobRows = [
    { keyword: "korea taxi app guide", status: "published", metadata: { track: "kscene" } },
    { keyword: "손흥민 결혼", status: "published", metadata: { track: "entertainment" } },
    { keyword: "전세사기 판결", status: "published", metadata: { track: "social" } },
    { keyword: "korea trash rules rejected", status: "rejected", metadata: { track: "kscene" } },
    { keyword: "korea old job no track", status: "published", metadata: {} },
  ];
  const jobTopics = koreaplainJobTopics(jobRows);
  assert(jobTopics.length === 1 && jobTopics[0] === "korea taxi app guide", `사용설명서 job만 기억한다(실제 ${jobTopics.join(" | ")})`);

  // 두 곳에 같은 kind 문자열이 있다(순수 모듈이 수집 모듈을 import 하지 않게 하려고) - 갈라지면 제안 기억이 통째로 빈다.
  assert(KOREAPLAIN_RUN_KIND === KOREAPLAIN_JOB_KIND, `run kind 상수가 같아야 한다(${KOREAPLAIN_RUN_KIND} vs ${KOREAPLAIN_JOB_KIND})`);
  const cutoff = Date.parse("2026-09-15T12:00:00Z");
  const runRows = [
    { id: 3, started_at: "2026-11-14T12:00:00Z", metadata: { kind: "kscene_topic" } },
    { id: 2, started_at: "2026-11-14T11:00:00Z", metadata: { kind: "social-issue" } },
    { id: 1, started_at: "2026-09-01T12:00:00Z", metadata: { kind: "kscene_topic" } },
  ];
  const picked = koreaplainProposalRuns(runRows, cutoff, 10);
  assert(picked.runIds.join() === "3", `기억 기간 안의 사용설명서 run만(실제 ${picked.runIds.join()})`);
  assert(picked.warnings.length === 0, "창이 안 잘렸으면 경고 없음");
  // 창이 잘리면 조용히 넘기지 않는다 - 읽은 만큼이 상한에 닿았고 가장 오래된 run이 기억 기간 안이면 더 있다.
  const truncated = koreaplainProposalRuns(runRows.slice(0, 2), cutoff, 2);
  assert(truncated.warnings.length === 1 && truncated.warnings[0].includes("중복 기억"), `창 잘림 경고(실제 ${truncated.warnings.join(" / ")})`);
  // 트랙 격리: 이 중복 규칙은 사용설명서 밖으로 새지 않는다(엔터·사회의 제안 수·중복 판정은 그대로여야 한다).
  const srcRoot = fileURLToPath(new URL("../..", import.meta.url));
  const importers = readdirSync(srcRoot, { recursive: true, encoding: "utf-8" })
    .filter((file) => file.endsWith(".ts"))
    .filter((file) => readFileSync(join(srcRoot, file), "utf-8").includes("koreaplainTopics.js"));
  assert(
    importers.every((file) => file.replace(/\\/g, "/").startsWith("workflows/koreaplain/")),
    `koreaplainTopics를 읽는 파일은 사용설명서 트랙뿐(실제 ${importers.join(" | ")})`
  );
  console.log("  ✅ 하루 5건 · 포함 관계 중복(같은 알림 안·날짜 넘김) · 기억 재료 트랙 분리 · 창 잘림 경고");

  // ---------- 모자란 날·중복 제거 실패를 알림에 적는다 ----------
  const notes: (string | undefined)[] = [];
  const shortDay = await runKoreaplainTopicCollection({
    now: new Date("2026-10-07T12:00:00Z"), delayMs: 0, seedsPerRun: 2, topicsPerRun: 5, log: () => {},
    fetchSuggestions: async (q) => [`${q} complete guide for residents`],
    fetchTrendTerms: async () => [],
    loadExistingTopics: async () => [],
    save: async () => ({ runId: 101, persisted: true }),
    notify: async (opts = {}) => {
      notes.push(opts.headerNote);
      return { sent: true, payload: null, messages: [] };
    },
  });
  assert(shortDay.status === "notified" && shortDay.topics.length < 5, `시드가 모자라면 적게 나간다(${shortDay.topics.length}건)`);
  assert((notes[0] ?? "").includes(`오늘은 ${shortDay.topics.length}건`), `모자란 날은 알림에 적는다(실제 ${notes[0] ?? "(없음)"})`);

  const failNotes: (string | undefined)[] = [];
  const dedupeDown = await runKoreaplainTopicCollection({
    now: new Date("2026-10-07T12:00:00Z"), delayMs: 0, seedsPerRun: 6, topicsPerRun: 5, log: () => {},
    fetchSuggestions: async (q) => [`${q} complete guide for residents`, `how to ${q} in korea step by step`],
    fetchTrendTerms: async () => [],
    loadExistingTopics: async () => {
      throw new Error("db down");
    },
    save: async () => ({ runId: 102, persisted: true }),
    notify: async (opts = {}) => {
      failNotes.push(opts.headerNote);
      return { sent: true, payload: null, messages: [] };
    },
  });
  assert(dedupeDown.status === "notified", "기발행 목록을 못 읽어도 알림은 간다");
  assert((failNotes[0] ?? "").includes("중복 제거"), `중복 제거를 건너뛴 날은 알림에 적는다(실제 ${failNotes[0] ?? "(없음)"})`);
  console.log("  ✅ 모자란 날 \"오늘은 N건\" · 중복 제거 생략 경고가 알림 헤더로 간다");

  console.log("\n✅ testKoreaplainTopics 통과");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
