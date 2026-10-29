// 사용설명서 트랙 주제 후보를 고르는 순수 로직(개편3 §4.2). 네트워크·DB가 없어 tsx 테스트로 검증한다.
//
// 흐름: 시드(날짜로 돌림) -> 자동완성 제안 -> 제외 규칙 -> 후보 병합 -> 점수 -> 기발행/기제안 중복 제거 ->
//      **체류 실용 정보 하한** + 라벨 다양성 상한 선정.
//
// 📌 선정 기준(2026-10-11, KEYWORD-REFRESH-2026-10.md §C): **실제 한국에 체류하며 필요한 실용 정보를
// 입국 전 문화 소개와 동등하게 우선한다.** 라벨 상한(perLabelCap)만 있으면 "쏠리지 않게" 막을 뿐이라,
// 문화 소개 라벨이 셋(Food·Culture·K-Wave)이고 실용 라벨이 하나(Living in Korea)인 구성에서는 실용
// 주제가 매일 0~1건으로 밀렸다. 그래서 상한과 짝이 되는 **하한**을 둔다(practicalFloor).
//
// 📌 보정 3건(2026-10-28, run 173~209 22일치 점검):
//   A. **한국 밖 지역 노이즈 제외.** 자동완성의 gl=us가 사실상 무시되고(us/gb 결과 동일) 질의가 미국 IP의
//      러너에서 나가므로, "korean dessert cafe fort lee"·"korean bbq santa rosa"·"korean funeral customs in
//      america" 같은 교포·로컬 질의가 매일 1~2건씩 8건 안에 들어왔다. 해외 지명이 들어간 후보는 제외한다
//      (isOverseasLocalTopic). 단 "korea vs japan"처럼 **비교 대상**으로 쓰인 국가명은 살린다. 지명은
//      하드코딩 목록이다 - 자동완성이 전부 소문자로 와서 "고유명사형 토큰"을 모양으로 가려낼 수 없다.
//      알파벳 변형 질의("<시드> g")는 지운다가 아니라 **결과에 안내 의도어를 요구**한다(VARIANT_INTENT_TERMS) -
//      실측(10/28, 시드 20개)에서 변형은 "korean breakfast gainesville·gold coast·duluth ga" 같은 지명 노이즈의
//      주공급원이었지만 "korean language learning guide"·"incheon airport layover guide"처럼 기본 질의에 없는
//      롱테일도 냈다. 목록 밖의 작은 도시(deventer류)는 변형 쪽에서 들어오므로 의도어 요구가 2차 그물이 된다.
//   B. **korea/korean 정규화.** topicTokens가 korea·korean·koreans·south korea를 한 토큰("korea")으로 접는다.
//      "korean phone plans for foreigners"(제안)와 "korea phone plans"(기발행)가 0.40으로 중복을 빠져나갔다.
//      seoul은 접지 않는다(서울 글과 전국 글은 다른 주제다). 임계값 0.6은 그대로다.
//   C. **레딧은 교차 신호로만 쓴다.** r/koreatravel·r/Living_in_Korea·r/living_in_korea_now의 최근 질문 제목이
//      자동완성 후보를 뒷받침하면 crossSignal에 가산한다(redditSupport). 제목을 주제로 올리지 않는다 - 제목은
//      "Question about ARC and bank account???" 같은 질문 한 줄이라 글 제목이 안 되고, 레딧의 수요 근거는
//      순위가 아니라 "질문이 있었다"일 뿐이라 자동완성 위치(demand)와 같은 저울에 올릴 수 없다. 후보 집합은
//      계속 자동완성이 정하고 레딧은 그 안에서 실제로 묻는 주제를 앞으로 당기기만 한다(최대 +10점).
//
// 📌 **로컬 우위 축**(2026-10-30, branding-2026-10/kp-native-identity-2026-10.md §C): 사이트 43편 중 86%가 외국인 저자
//   블로그가 이미 포화시킨 주제였다. 점수식을 기본 5 + 수요 35 + 교차 15 + 구체성 15 + 의도 15 + **로컬 우위 15**
//   = 100으로 바꾸고, 관광 포화 용어가 든 후보는 **-10**(하한 0)한다. 감점이지 제외가 아니다 - 수요가 아주 크면
//   여전히 올라온다. 선정에는 실용 하한과 짝으로 **로컬 우위 하한**(localEdgeFloor)을 둔다. 용어 매칭은
//   topicTokens와 같은 korea/korean 접기·복수형 접기를 쓰되 **불용어는 지우지 않는다**("koreans how do you" 같은
//   질문형 구가 불용어만으로 이뤄져 있어서) - matchTokens. 구(句)는 연속 토큰 일치다.
//
// 이 트랙의 선정은 LLM 프롬프트가 아니라 이 파일의 결정 규칙이 전부다 - 기준은 여기 적는다.
// 점수는 한국 키워드 파이프라인의 6-factor가 아니다(그건 뉴스·트렌드 기반이라 에버그린에는 안 맞는다) -
// 같은 이름의 컬럼(keyword_rankings.*_score)에 채워 넣어 Go/Pass 알림·job 생성 경로를 그대로 쓸 뿐이다.

import { KSCENE_DEFAULT_LABEL, KSCENE_LABEL_BY_SEED, KSCENE_LABELS, type KsceneLabel, type KsceneSeed } from "../../config/ksceneSeeds.js";
import type { RankedKeyword } from "../../types/keywordScoring.js";

const STOPWORDS = new Set([
  "a", "an", "the", "in", "on", "at", "to", "for", "of", "and", "or", "is", "are", "do", "does", "can", "i", "my", "you", "your",
  "how", "what", "why", "when", "where", "which", "with", "from", "by", "it", "be", "there", "vs",
]);

/** 소문자, 구두점 제거, 공백 정리. 비교·중복 판정용 정규형. */
export function normalizeTopic(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** korea·korean(s)·south korea를 접은 토큰(2026-10-28, B). seoul 같은 지명은 접지 않는다. */
const KOREA_TOKEN = "korea";
const KOREA_FORMS = new Set(["korea", "korean"]);

/** 의미 있는 토큰(불용어 제거, 단순 복수형 정규화, korea/korean 접기). */
export function topicTokens(text: string): string[] {
  return normalizeTopic(text)
    .replace(/\bsouth (?=korea)/g, "")
    .split(" ")
    .filter((token) => token.length > 1 && !STOPWORDS.has(token))
    .map((token) => (token.length > 3 && token.endsWith("s") && !token.endsWith("ss") ? token.slice(0, -1) : token))
    .map((token) => (KOREA_FORMS.has(token) ? KOREA_TOKEN : token));
}

/** 토큰 집합 자카드 유사도(0~1). */
export function topicSimilarity(a: string, b: string): number {
  const setA = new Set(topicTokens(a));
  const setB = new Set(topicTokens(b));
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const token of setA) if (setB.has(token)) shared += 1;
  return shared / (setA.size + setB.size - shared);
}

/** 후보가 이미 쓴/제안한 주제와 같은 주제인가. */
export function isDuplicateTopic(topic: string, existing: readonly string[], threshold: number): boolean {
  const normalized = normalizeTopic(topic);
  return existing.some((other) => normalizeTopic(other) === normalized || topicSimilarity(topic, other) >= threshold);
}

// ---------- 로컬 우위·관광 포화 용어(2026-10-30) ----------

/** 용어 매칭용 토큰: normalizeTopic + south korea·korea/korean 접기 + 복수형 접기. 불용어는 남긴다. */
function matchTokens(text: string): string[] {
  return normalizeTopic(text)
    .replace(/\bsouth (?=korea)/g, "")
    .split(" ")
    .filter(Boolean)
    .map((token) => (token.length > 3 && token.endsWith("s") && !token.endsWith("ss") ? token.slice(0, -1) : token))
    .map((token) => (KOREA_FORMS.has(token) ? KOREA_TOKEN : token));
}

/** 토큰열 안에 구(phrase)가 연속으로 들어 있는가. */
function containsTokenPhrase(tokens: readonly string[], phrase: readonly string[]): boolean {
  if (phrase.length === 0 || phrase.length > tokens.length) return false;
  for (let start = 0; start + phrase.length <= tokens.length; start += 1) {
    if (phrase.every((token, offset) => tokens[start + offset] === token)) return true;
  }
  return false;
}

/** 로컬 우위: 한국인은 알지만 외국인 가이드가 잘 못 쓰는 영역어(+15, 하나라도 포함). §C-1. */
export const LOCAL_EDGE_TERMS = [
  // 행정·금융·의료 창구
  "gu office", "dong office", "community center", "minwon", "bank teller", "bankbook", "certificate",
  "which hospital department", "internal medicine", "ent clinic", "pharmacy without prescription", "health checkup",
  // 주거·동네
  "apartment management office", "management fee", "gas inspection", "neighbor noise", "recycling day", "moving day",
  "security guard", "delivery box",
  // 식당·가게 관행
  "call button", "table bell", "self service water", "refill", "pay at counter", "break time", "last order", "solo dining",
  // 명절·가족·세대
  "what koreans do", "koreans actually", "do koreans", "chuseok at home", "seollal", "hwangap", "doljanchi",
  "first birthday", "100 days", "hoesik", "company dinner",
  // 호칭·관계
  "how to address", "ajumma", "ajeossi", "sajangnim", "title at work",
  // 질문형 로컬 신호(레딧 교차용)
  "koreans how do you", "do locals", "is it rude in korea", "is it normal in korea",
] as const;

/** 관광 포화: 외국인 저자 블로그가 이미 다 쓴 영역어(-10). korea·seoul은 넣지 않는다. §C-1. */
export const SATURATED_TOURIST_TERMS = [
  "itinerary", "day trip", "things to do", "best places", "top 10", "must try", "must visit", "cherry blossom",
  "autumn foliage", "hanbok rental", "palace", "jeju", "busan travel", "travel budget", "layover", "k eta", "michelin",
] as const;

const LOCAL_EDGE_PHRASES = LOCAL_EDGE_TERMS.map(matchTokens);
const SATURATED_PHRASES = SATURATED_TOURIST_TERMS.map(matchTokens);

/** 후보가 로컬 우위 용어를 품었는가. */
export function hasLocalEdge(topic: string): boolean {
  const tokens = matchTokens(topic);
  return LOCAL_EDGE_PHRASES.some((phrase) => containsTokenPhrase(tokens, phrase));
}

/** 후보가 관광 포화 용어를 품었는가. */
export function isTouristSaturated(topic: string): boolean {
  const tokens = matchTokens(topic);
  return SATURATED_PHRASES.some((phrase) => containsTokenPhrase(tokens, phrase));
}

// ---------- 제외 규칙 ----------

/** 정치·안보·성인·도박·약물 등 이 블로그가 다루지 않는 주제(애드센스 정책 + 정체성). */
const EXCLUDED_TERMS = [
  "north korea", "nuclear", "war", "military", "president", "election", "politic", "protest", "yoon", "lee jae",
  "porn", "sex", "escort", "nude", "adult", "casino", "gambling", "betting", "bet365", "drug", "weed", "cannabis", "marijuana",
  "scandal", "suicide", "death", "dies", "murder", "crime", "arrest", "lawsuit",
];

/** 글이 될 수 없는 내비게이션·로컬·시의성 질의. */
const LOW_VALUE_TERMS = [
  "near me", "reddit", "youtube", "tiktok", "instagram", "login", "log in", "pdf", "download", "torrent", "free online",
  "today", "tonight", "live", "news", "stock", "price chart", "meaning in english", "lyrics", "mp3", "wallpaper", "twitter",
  // 해외 한글학교·한인 문화학교(2026-10-28, A) - "aiea korean culture school"처럼 지명 없이 학교 이름으로 온다.
  "culture school", "heritage school", "saturday school",
];

function containsTerm(normalized: string, term: string): boolean {
  // 단어 경계로 본다("war"가 "warm"을 잡지 않게). 구(phrase)는 그대로 포함 검사.
  return new RegExp(`(^| )${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( |$)`).test(normalized) ||
    (term.length > 5 && normalized.includes(term));
}

/**
 * **체류 실용 정보** 신호(2026-10-11, §C). 라벨이 "Living in Korea"면 그것만으로 실용으로 보고,
 * 다른 라벨(특히 Travel & Transit)에서도 환승·개통·납부·행정 절차처럼 "살면서 해야 하는 일"이면 센다.
 *
 * 문화 소개(축제·예절·역사)는 여기 들어오지 않는다 - 그쪽은 이미 충분히 뽑히고 있어 하한이 필요 없다.
 */
const PRACTICAL_TERMS = [
  "transfer", "transit card", "t money", "tmoney", "recharge", "top up", "commute", "rush hour",
  "traffic", "jaywalking", "crosswalk", "driver license", "driving",
  "sim", "usim", "esim", "phone plan", "phone number", "activation", "verification", "mobile banking",
  "bank account", "atm", "remittance", "wire transfer", "tax", "pension", "payroll",
  "registration", "arc", "alien registration", "visa extension", "immigration office", "report",
  "insurance", "hospital", "clinic", "pharmacy", "prescription", "appointment", "emergency",
  "recycling", "garbage", "trash", "food waste", "utility", "utilities", "bill", "bills", "payment",
  "rent", "jeonse", "deposit", "lease", "contract", "internet installation", "wifi",
  "delivery app", "karrot", "secondhand", "apartment", "gym membership", "post office", "parcel",
  "renewal", "refund", "documents", "paperwork",
  // "rules"·"how to"·"apply" 같은 범용 의도어는 넣지 않는다 - 문화 소개 주제("korean dining etiquette
  // rules")까지 실용으로 세어 하한이 의미를 잃는다. 생활 행정·교통·통신·의료·주거 **영역어**만 둔다.
] as const;

/** 이 후보가 체류 실용 정보인가. 라벨 또는 문구로 판정한다. */
export function isPracticalTopic(topic: string, label: KsceneLabel): boolean {
  if (label === "Living in Korea") return true;
  const normalized = normalizeTopic(topic);
  return PRACTICAL_TERMS.some((term) => containsTerm(normalized, term));
}

/**
 * 한국 밖 지명(2026-10-28, A). 교포·로컬 질의("korean bbq santa rosa", "korean funeral customs in america")를
 * 거른다. 22일치 실측 노이즈와 10/28 자동완성 실측에서 나온 곳 + 한인 밀집 지역 + 주요 국가·도시다.
 *
 * - 국가는 **명사형만** 둔다. "american"·"canadian"·"japanese" 같은 형용사는 넣지 않는다 - "korea visa for
 *   canadian citizens"(방문자 국적)나 "korean chinese food"(짜장면)처럼 한국 안의 주제가 걸린다.
 * - 보통 영어 단어와 겹치는 지명(mobile·reading·nice·bath·phoenix·orange)은 넣지 않는다 - "mobile banking"을
 *   지명으로 잡는 쪽이 노이즈를 놓치는 쪽보다 손해다. 목록 밖의 작은 도시는 변형 질의 의도어 요구가 받는다.
 * - "us"는 넣지 않는다("korea visa for us citizens"는 유효하다). "usa"·"america"는 넣는다.
 */
const OVERSEAS_PLACES = [
  // 국가·지역
  "america", "usa", "united states", "canada", "australia", "new zealand", "uk", "united kingdom", "england", "scotland",
  "ireland", "philippines", "netherlands", "germany", "france", "italy", "spain", "india", "pakistan", "bangladesh",
  "nepal", "sri lanka", "malaysia", "indonesia", "singapore", "thailand", "vietnam", "japan", "china", "taiwan",
  "hong kong", "mongolia", "uzbekistan", "kazakhstan", "russia", "dubai", "uae", "saudi arabia", "nigeria", "kenya",
  "south africa", "mexico", "brazil", "argentina", "peru", "chile", "colombia",
  // 미국 주(일반어와 겹치는 이름 제외) + 약칭
  "california", "texas", "new york", "new jersey", "virginia", "georgia", "illinois", "washington state", "hawaii",
  "nevada", "florida", "massachusetts", "pennsylvania", "maryland", "michigan", "ohio", "minnesota", "colorado",
  "arizona", "oregon", "north carolina", "tennessee", "alabama", "utah", "nyc", "nj", "socal", "bay area", "dmv",
  // 미국 도시(한인 밀집 지역 포함)
  "los angeles", "koreatown", "ktown", "fort lee", "palisades park", "queens", "manhattan",
  "brooklyn", "bergen county", "flushing ny", "flushing queens", "annandale", "centreville", "fairfax", "ellicott city", "duluth", "suwanee", "atlanta",
  "fullerton", "buena park", "garden grove", "irvine", "torrance", "cerritos", "diamond bar", "rowland heights",
  "orange county", "san diego", "san francisco", "san jose", "oakland", "santa clara", "sacramento", "santa rosa",
  "seattle", "federal way", "lynnwood", "tacoma", "portland", "boston", "chicago", "philadelphia", "houston", "dallas",
  "fort worth", "carrollton", "austin", "san antonio", "denver", "phoenix az", "las vegas", "honolulu", "miami",
  "orlando", "tampa", "charlotte", "raleigh", "nashville", "minneapolis", "detroit", "columbus ohio", "pittsburgh",
  "baltimore", "gainesville", "anchorage", "salt lake city",
  // 캐나다·호주·뉴질랜드·영국·유럽
  "toronto", "vancouver", "burnaby", "coquitlam", "surrey bc", "calgary", "edmonton", "montreal", "ottawa", "winnipeg",
  "sydney", "melbourne", "brisbane", "gold coast", "perth", "adelaide", "auckland", "wellington", "london",
  "new malden", "manchester", "birmingham", "glasgow", "edinburgh", "leeds", "dublin", "amsterdam", "rotterdam",
  "utrecht", "the hague", "deventer", "eindhoven", "berlin", "frankfurt", "munich", "hamburg", "paris", "madrid",
  "barcelona",
  // 아시아·기타
  "manila", "makati", "cebu", "quezon city", "kuala lumpur", "jakarta", "bangkok", "hanoi", "ho chi minh",
  "tokyo", "osaka", "fukuoka", "beijing", "shanghai", "taipei", "ulaanbaatar", "tashkent", "gujranwala", "lahore",
  "karachi", "delhi", "mumbai", "kathmandu", "dhaka",
] as const;

/** 한국 안의 고유명사인데 해외 지명을 품은 것 - 지명 판정 전에 지운다. */
const OVERSEAS_FALSE_FRIENDS = ["paris baguette", "paris croissant", "london bagel", "hong kong banjeom", "hong kong banjum", "phoenix park"] as const;

/** 비교 대상으로 쓰인 국가명은 글 주제로 유효하다("korea vs japan", "cost of living compared to canada"). */
const COMPARISON_TERMS = ["vs", "versus", "compared", "compare", "comparison", "difference", "differences", "than"] as const;

/** 단어 경계로만 본다. containsTerm의 긴 낱말 부분 일치를 쓰면 "america"가 "american"을 잡는다. */
function containsWord(normalized: string, term: string): boolean {
  return ` ${normalized} `.includes(` ${term} `);
}

/** 해외 지명이 들어간 교포·로컬 질의인가(비교 대상으로 쓰인 국가명은 아니다). */
export function isOverseasLocalTopic(topic: string): boolean {
  let normalized = normalizeTopic(topic);
  for (const phrase of OVERSEAS_FALSE_FRIENDS) normalized = normalized.split(phrase).join(" ");
  if (!OVERSEAS_PLACES.some((place) => containsWord(normalized, place))) return false;
  return !COMPARISON_TERMS.some((term) => containsWord(normalized, term));
}

export function isExcludedTopic(topic: string): boolean {
  const normalized = normalizeTopic(topic);
  return [...EXCLUDED_TERMS, ...LOW_VALUE_TERMS].some((term) => containsTerm(normalized, term)) || isOverseasLocalTopic(normalized);
}

/** 단어 수·길이가 글 주제로 쓸 만한가(너무 짧으면 막연하고 너무 길면 질문 한 줄이다). */
export function hasUsableShape(topic: string): boolean {
  const words = normalizeTopic(topic).split(" ").filter(Boolean);
  return words.length >= 3 && words.length <= 10 && normalizeTopic(topic).length >= 12;
}

// ---------- 시드 선정 ----------

/**
 * 오늘 돌릴 시드를 고른다. 날짜(일 단위 정수)로 시작점을 돌려 전체 시드가 며칠 안에 한 바퀴 돈다.
 * 라벨이 섞이도록 라벨별로 번갈아 뽑는다.
 */
export function pickSeedsForDay(seeds: readonly KsceneSeed[], dayIndex: number, count: number): KsceneSeed[] {
  const byLabel = new Map<KsceneLabel, KsceneSeed[]>();
  for (const seed of seeds) byLabel.set(seed.label, [...(byLabel.get(seed.label) ?? []), seed]);
  const labels = KSCENE_LABELS.filter((label) => byLabel.has(label));
  if (labels.length === 0) return [];

  const picked: KsceneSeed[] = [];
  let round = 0;
  while (picked.length < Math.min(count, seeds.length)) {
    for (const label of labels) {
      const pool = byLabel.get(label)!;
      const seed = pool[(dayIndex * Math.ceil(count / labels.length) + round) % pool.length];
      if (!picked.includes(seed)) picked.push(seed);
      if (picked.length >= count) break;
    }
    round += 1;
    if (round > seeds.length) break; // 안전장치
  }
  return picked;
}

/**
 * 자동완성 변형 질의: 시드 그대로 + 날짜로 돌리는 알파벳 한 글자(롱테일을 다양하게).
 *
 * 변형은 남긴다(2026-10-28, A). 변형 결과는 지명 노이즈의 주공급원이지만("korean breakfast g" -> gainesville·
 * gold coast·duluth ga) 기본 질의에 없는 안내형 롱테일도 같이 낸다. 없애면 하루 제안이 반으로 줄어 이미 68%인
 * 중복 제외율 아래에서 후보가 마른다. 그래서 변형 결과에만 **안내 의도어를 요구**한다(hasIntentSignal) -
 * 지명 목록에 없는 작은 도시가 붙은 질의는 의도어가 없어 여기서 걸린다. 실측 대안으로 "<시드> for foreigners"·
 * "<시드> how" 접미 변형도 봤지만 시드 20개 중 대부분이 빈 결과였다.
 */
export function autocompleteQueriesForSeed(seed: string, dayIndex: number): string[] {
  const letter = String.fromCharCode("a".charCodeAt(0) + (dayIndex % 26));
  return [seed, `${seed} ${letter}`];
}

// ---------- 후보·점수 ----------

export type SuggestionObservation = {
  /** 제안된 질의 원문. */
  suggestion: string;
  /** 제안을 낳은 시드 문구. */
  seed: string;
  /** 제안 목록에서의 위치(0이 맨 앞 = 수요가 가장 크다). */
  position: number;
  /**
   * 출처(2026-10-28). autocomplete = 시드 그대로의 자동완성, autocomplete_variant = 알파벳 변형 질의의 자동완성.
   * 생략하면 autocomplete. 변형 결과에는 안내 의도어를 요구한다(autocompleteQueriesForSeed 주석).
   */
  source?: "autocomplete" | "autocomplete_variant";
};

export type TopicCandidate = {
  topic: string;
  seed: string;
  label: KsceneLabel;
  /** 이 주제가 관찰된 횟수(시드·변형 질의를 가로질러). */
  hits: number;
  /** 관찰된 가장 앞선 위치. */
  bestPosition: number;
  /** 이 후보를 뒷받침한 레딧 질문 제목 수(2026-10-28, C). 레딧을 안 돌렸으면 생략. */
  redditHits?: number;
  /** 뒷받침한 레딧 제목 하나(로그·사유용). */
  redditExample?: string;
  /** 뒷받침 제목 중 "Koreans, how do you…" 류 로컬 질문형이 있다(2026-10-30). 있으면 redditHits를 2로 센다. */
  redditLocalQuestion?: boolean;
};

/** 변형 질의 결과가 글이 될 의도를 품었는가 - 질문형·안내어·체류 실용 영역어·방문자 표현. */
const INTENT_EXTRA_TERMS = [
  "foreigner", "foreigners", "tourist", "tourists", "traveler", "travelers", "meaning", "list", "requirements",
  "process", "fee", "fees", "types", "history", "culture", "customs", "ideas", "rules", "explained", "itinerary",
] as const;

/**
 * 의도어는 **시드 밖의 낱말**에서만 센다(10/28 dry-run: 시드 "korean school culture"의 변형이 낸
 * "green mountain korean culture school"이 시드 낱말 culture로 통과했다 - 미국 한글학교 이름이다).
 */
export function hasIntentSignal(topic: string, seed = ""): boolean {
  const seedWords = new Set(normalizeTopic(seed).split(" "));
  const normalized = normalizeTopic(topic)
    .split(" ")
    .filter((word) => !seedWords.has(word))
    .join(" ");
  const words = new Set(normalized.split(" "));
  if (QUESTION_STARTERS.some((starter) => words.has(starter))) return true;
  return [...GUIDE_WORDS, ...PRACTICAL_TERMS, ...INTENT_EXTRA_TERMS].some((term) => containsTerm(normalized, term));
}

/** 시드와 한 토큰도 안 겹치는 제안(자동완성이 엉뚱한 곳으로 샌 경우)은 버린다. */
function sharesSeedToken(suggestion: string, seed: string): boolean {
  const seedTokens = new Set(topicTokens(seed));
  return topicTokens(suggestion).some((token) => seedTokens.has(token));
}

export function buildCandidates(observations: readonly SuggestionObservation[], labelBySeed: Readonly<Record<string, KsceneLabel>> = KSCENE_LABEL_BY_SEED): TopicCandidate[] {
  const byKey = new Map<string, TopicCandidate>();

  for (const obs of observations) {
    const topic = normalizeTopic(obs.suggestion);
    if (!hasUsableShape(topic) || isExcludedTopic(topic) || !sharesSeedToken(topic, obs.seed)) continue;
    if (obs.source === "autocomplete_variant" && !hasIntentSignal(topic, obs.seed)) continue;

    const existing = byKey.get(topic);
    if (existing) {
      existing.hits += 1;
      existing.bestPosition = Math.min(existing.bestPosition, obs.position);
    } else {
      byKey.set(topic, {
        topic,
        seed: obs.seed,
        label: labelBySeed[obs.seed] ?? KSCENE_DEFAULT_LABEL,
        hits: 1,
        bestPosition: obs.position,
      });
    }
  }
  return [...byKey.values()];
}

const QUESTION_STARTERS = ["how", "what", "why", "when", "where", "which", "can", "do", "does", "is", "are", "should"];
const GUIDE_WORDS = ["guide", "tips", "tip", "explained", "etiquette", "rules", "best", "vs", "difference", "first time", "beginner", "cost", "worth"];

export type TopicScore = {
  total: number;
  demand: number;
  crossSignal: number;
  specificity: number;
  intent: number;
  /** 로컬 우위 가산(0 또는 15). 2026-10-30. */
  localEdge: number;
  /** 관광 포화 감점(0 또는 10, 양수로 기록하고 total에서 뺀다). 2026-10-30. */
  saturation: number;
};

/** 점수 구성(합계 100): 기본 5 + 수요 35 + 교차 15 + 구체성 15 + 의도 15 + 로컬 우위 15. 포화는 -10(하한 0). */
export const SCORE_WEIGHTS = { base: 5, demand: 35, crossSignal: 15, specificity: 15, intent: 15, localEdge: 15, saturation: 10 } as const;

// ---------- 레딧 교차 신호(2026-10-28, C) ----------

/** 레딧 제목과 맞춰 볼 때 빼는 범용어 - 이 서브레딧의 질문은 전부 외국인이 한국에 관해 묻는 것이다. */
const REDDIT_GENERIC_TOKENS = new Set([KOREA_TOKEN, "guide", "tip", "best", "explained", "foreigner", "first", "time"]);

function redditCoreTokens(text: string): Set<string> {
  return new Set(topicTokens(text).filter((token) => !REDDIT_GENERIC_TOKENS.has(token) && !/^\d+$/.test(token)));
}

/**
 * 레딧 제목이 이 후보를 뒷받침하는가. 후보의 핵심 토큰(korea·범용어 제외) 중 2개 이상, 60% 이상이 제목에
 * 있어야 한다. 제목은 길고 후보는 짧아서 자카드(topicSimilarity)로는 거의 안 걸린다 - 포함률로 본다.
 * 핵심 토큰이 하나뿐인 후보는 뒷받침을 받지 않는다(한 단어 일치는 우연이 너무 많다).
 */
export function redditTitleSupports(topic: string, title: string): boolean {
  const core = redditCoreTokens(topic);
  if (core.size < 2) return false;
  const titleTokens = new Set(topicTokens(title));
  let shared = 0;
  for (const token of core) if (titleTokens.has(token)) shared += 1;
  return shared >= 2 && shared / core.size >= 0.6;
}

/** 이 제목으로 시작하면 외국인이 아니라 한국인에게 묻는 질문이다(§C-1). 뒷받침 1건을 2건으로 센다. */
const REDDIT_LOCAL_QUESTION_PREFIXES = ["koreans how do you", "do koreans", "is it rude in korea", "is it normal in korea"].map((p) =>
  matchTokens(p).join(" ")
);

export function isLocalQuestionTitle(title: string): boolean {
  const normalized = matchTokens(title).join(" ");
  return REDDIT_LOCAL_QUESTION_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix} `));
}

/** 후보마다 레딧 뒷받침 수를 붙인다. 레딧 제목은 후보를 만들지 않는다 - 이미 있는 후보에만 붙는다. */
export function attachRedditSupport(candidates: readonly TopicCandidate[], titles: readonly string[]): TopicCandidate[] {
  return candidates.map((candidate) => {
    const supporting = titles.filter((title) => redditTitleSupports(candidate.topic, title));
    return {
      ...candidate,
      redditHits: supporting.length,
      ...(supporting[0] ? { redditExample: supporting[0] } : {}),
      ...(supporting.some(isLocalQuestionTitle) ? { redditLocalQuestion: true } : {}),
    };
  });
}

/**
 * 0~100. 기본 5 + 수요(자동완성 위치) 35 + 교차 신호 15 + 구체성 15 + 안내글 의도 15 + 로컬 우위 15, 관광 포화 -10(하한 0).
 * 교차 신호 = 자동완성 반복 관찰(0/8/15) + 레딧 질문 뒷받침(1건 5, 2건 이상 10), 합쳐 15가 상한이다(C).
 * 로컬 질문형 레딧 제목이 뒷받침하면 그 후보의 레딧 뒷받침을 2건으로 센다(2026-10-30).
 */
export function scoreTopic(candidate: TopicCandidate): TopicScore {
  const demand = Math.round(Math.max(0, 10 - candidate.bestPosition) / 10 * SCORE_WEIGHTS.demand);
  const repeat = Math.round((Math.min(candidate.hits, 3) - 1) / 2 * SCORE_WEIGHTS.crossSignal);
  const redditHits = candidate.redditLocalQuestion ? Math.max(candidate.redditHits ?? 0, 2) : candidate.redditHits ?? 0;
  const crossSignal = Math.min(SCORE_WEIGHTS.crossSignal, repeat + Math.min(redditHits, 2) * 5);

  const wordCount = candidate.topic.split(" ").length;
  const specificity = wordCount >= 4 && wordCount <= 7 ? SCORE_WEIGHTS.specificity : wordCount === 3 || wordCount === 8 ? 8 : 4;

  const normalized = candidate.topic;
  const isQuestion = QUESTION_STARTERS.some((starter) => normalized.startsWith(`${starter} `));
  const hasGuideWord = GUIDE_WORDS.some((word) => containsTerm(normalized, word));
  const intent = isQuestion ? SCORE_WEIGHTS.intent : hasGuideWord ? 10 : 0;

  const localEdge = hasLocalEdge(candidate.topic) ? SCORE_WEIGHTS.localEdge : 0;
  const saturation = isTouristSaturated(candidate.topic) ? SCORE_WEIGHTS.saturation : 0;

  const total = Math.max(0, Math.min(100, SCORE_WEIGHTS.base + demand + crossSignal + specificity + intent + localEdge - saturation));
  return { total, demand, crossSignal, specificity, intent, localEdge, saturation };
}

/** 체류 실용 정보 하한의 기본값(2026-10-11, §C). topN=8이면 3건 - 라벨 상한(3)과 같은 크기다. */
export function defaultPracticalFloor(topN: number): number {
  return Math.min(topN, Math.max(2, Math.round(topN / 3)));
}

/** 로컬 우위 하한의 기본값(2026-10-30). topN=8이면 2건. 실용 하한과 겹쳐도 된다. */
export function defaultLocalEdgeFloor(topN: number): number {
  return Math.min(topN, Math.max(1, Math.round(topN / 4)));
}

/**
 * 후보를 점수순으로 정렬하고 ① 후보끼리 비슷한 것 ② 기발행·기제안과 같은 것을 걷어낸 뒤 topN을 뽑는다.
 *
 * 두 규칙이 함께 작동한다:
 *   · **하한(practicalFloor)** - 체류 실용 정보를 먼저 그 수만큼 채운다(§C, 2026-10-11). 실용 후보가
 *     그보다 적으면 있는 만큼만 - 억지로 만들지 않는다.
 *   · **로컬 우위 하한(localEdgeFloor)** - 로컬 우위 용어가 든 후보를 그 수만큼 확보한다(2026-10-30). 실용 하한으로
 *     이미 뽑힌 후보가 로컬 우위이기도 하면 둘 다로 센다. 후보가 적으면 있는 만큼만 - 억지로 채우지 않는다.
 *   · **상한(perLabelCap)** - 한 라벨로 쏠리지 않게 막는다. 하한으로 먼저 뽑은 것도 이 상한에 포함해
 *     세므로, 실용 하한이 상한을 넘어 한 라벨을 독점하지 않는다.
 * 둘을 적용하고도 자리가 남으면 점수순으로 채운다(상한 무시 - 비우는 쪽이 손해다, 기존 동작).
 */
export function selectTopics(
  candidates: readonly TopicCandidate[],
  options: {
    topN: number;
    existingTopics: readonly string[];
    similarity: number;
    perLabelCap?: number;
    /** 체류 실용 정보 최소 건수. 생략하면 defaultPracticalFloor(topN). 0을 주면 하한을 끈다. */
    practicalFloor?: number;
    /** 로컬 우위 최소 건수. 생략하면 defaultLocalEdgeFloor(topN). 0을 주면 하한을 끈다. */
    localEdgeFloor?: number;
  }
): { selected: (TopicCandidate & { score: TopicScore })[]; droppedAsDuplicate: number } {
  const scored = candidates
    .map((candidate) => ({ ...candidate, score: scoreTopic(candidate) }))
    .sort((a, b) => b.score.total - a.score.total || a.topic.localeCompare(b.topic));

  const kept: typeof scored = [];
  let droppedAsDuplicate = 0;
  for (const candidate of scored) {
    const dup = isDuplicateTopic(candidate.topic, options.existingTopics, options.similarity) ||
      kept.some((other) => topicSimilarity(candidate.topic, other.topic) >= options.similarity);
    if (dup) {
      droppedAsDuplicate += 1;
      continue;
    }
    kept.push(candidate);
  }

  const cap = options.perLabelCap ?? Math.max(2, Math.ceil(options.topN / 3));
  const floor = options.practicalFloor ?? defaultPracticalFloor(options.topN);
  const perLabel = new Map<KsceneLabel, number>();
  const selected: typeof kept = [];

  const take = (candidate: (typeof kept)[number]): void => {
    perLabel.set(candidate.label, (perLabel.get(candidate.label) ?? 0) + 1);
    selected.push(candidate);
  };

  // 1) 실용 하한을 점수순으로 먼저 채운다. 라벨 상한은 여기서도 지킨다.
  for (const candidate of kept) {
    if (selected.length >= Math.min(floor, options.topN)) break;
    if (!isPracticalTopic(candidate.topic, candidate.label)) continue;
    if ((perLabel.get(candidate.label) ?? 0) >= cap) continue;
    take(candidate);
  }

  // 1b) 로컬 우위 하한. 실용 하한으로 이미 뽑힌 로컬 우위 후보도 센다. 라벨 상한은 지킨다.
  const localFloor = Math.min(options.localEdgeFloor ?? defaultLocalEdgeFloor(options.topN), options.topN);
  for (const candidate of kept) {
    if (selected.filter((item) => item.score.localEdge > 0).length >= localFloor) break;
    if (selected.length >= options.topN) break;
    if (candidate.score.localEdge === 0 || selected.includes(candidate)) continue;
    if ((perLabel.get(candidate.label) ?? 0) >= cap) continue;
    take(candidate);
  }

  // 2) 나머지는 기존대로 점수순 + 라벨 상한.
  for (const candidate of kept) {
    if (selected.length >= options.topN) break;
    if (selected.includes(candidate)) continue;
    if ((perLabel.get(candidate.label) ?? 0) >= cap) continue;
    take(candidate);
  }

  // 3) 상한 때문에 자리가 남으면 점수순으로 채운다.
  for (const candidate of kept) {
    if (selected.length >= options.topN) break;
    if (!selected.includes(candidate)) selected.push(candidate);
  }

  return { selected: selected.sort((a, b) => b.score.total - a.score.total), droppedAsDuplicate };
}

/** 선정 결과를 keyword_rankings에 저장하는 RankedKeyword로 바꾼다(Go/Pass 알림·job 생성 경로 재사용). */
export function toRankedKeywords(selected: readonly (TopicCandidate & { score: TopicScore })[]): RankedKeyword[] {
  return selected.map((item, index) => ({
    rank: index + 1,
    keyword: item.topic,
    headline: item.topic,
    // seedQuery = 이 주제를 낳은 시드 문구. 발행 시 Blogger 라벨을 KSCENE_LABEL_BY_SEED[seedQuery]로 정한다.
    seedQuery: item.seed,
    category: "kscene",
    totalScore: item.score.total,
    scoreBreakdown: {
      trendMomentum: 0,
      newsVelocity: 0,
      contentDemand: item.score.demand,
      freshness: 0,
      crossSourceSignal: item.score.crossSignal,
      // keyword_rankings.score_breakdown은 6컬럼 고정(migration 없음) - 로컬 우위는 clickPotential에 합산하고 포화 감점은 reason에 남긴다.
      clickPotential: item.score.intent + item.score.specificity + item.score.localEdge,
      total: item.score.total,
    },
    trendDirection: "unknown",
    relatedCount: item.hits,
    sources: (item.redditHits ?? 0) > 0 ? ["google_autocomplete", "reddit"] : ["google_autocomplete"],
    latestPublishedAt: null,
    reason: `${item.label} · 자동완성 ${item.bestPosition + 1}번째 · ${item.hits}회 관찰${(item.redditHits ?? 0) > 0 ? ` · 레딧 질문 ${item.redditHits}건` : ""}${item.score.localEdge > 0 ? " · 로컬 우위 +15" : ""}${item.score.saturation > 0 ? " · 관광 포화 -10" : ""}`,
  }));
}
