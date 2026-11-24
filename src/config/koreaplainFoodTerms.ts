// 사용설명서 트랙(Korea Plain) **한국 음식 소개 전환**(2026-11-25)의 어휘표. 순수 상수 + 판정 함수 - 네트워크·DB 없음.
//
// 왜 이 파일이 따로 있나: 주제 선정(workflows/koreaplain/koreaplainTopics.ts)과 Blogger 발행 라벨(publishArticleToBlogspot.ts의
// 시드 없는 직접 입력 job)이 같은 판정을 쓴다. 선정 모듈은 사용설명서 수집 밖에서 import 하지 않는다는 규칙이 있어
// (testKoreaplainTopics.ts 트랙 격리 단언) 어휘는 여기 둔다. 결정 배경: docs/ai-handoff/KOREAPLAIN-FOOD-PIVOT-2026-11.md.
//
// **목록은 여기서 고친다.** 특히 AVERSIVE_FOOD_TERMS(혐오 식품)는 사용자 확정 전 초안이다 - 넣고 빼는 것은 이 배열 한 곳이다.
//
// 매칭 규칙(전 목록 공통): 소문자·구두점 제거 후 **토큰 단위 연속 일치**(구는 연속 토큰). korean/koreans/south korea는
// "korea"로 접고, 4글자 이상 토큰의 끝 s를 뗀다(양쪽에 같은 규칙 - "noodles"와 "noodle"이 같다). 로마자 음식명은 붙여 쓰는
// 일이 잦아("kimchijjigae", "hodugwaja") 5글자 이상 로마자 음식명에 한해 토큰 **안 부분 일치**도 본다.

/** 판정용 토큰: 소문자, 구두점 제거, south korea·korean 접기, 단순 복수형 접기. 불용어는 지우지 않는다. */
export function foodMatchTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/-/g, " ")
    .replace(/\bsouth (?=korea)/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => (token.length > 3 && token.endsWith("s") && !token.endsWith("ss") ? token.slice(0, -1) : token))
    .map((token) => (token === "korean" ? "korea" : token));
}

function phraseIn(tokens: readonly string[], phrase: readonly string[]): boolean {
  if (phrase.length === 0 || phrase.length > tokens.length) return false;
  for (let start = 0; start + phrase.length <= tokens.length; start += 1) {
    if (phrase.every((token, offset) => tokens[start + offset] === token)) return true;
  }
  return false;
}

function makeMatcher(terms: readonly string[], options: { substringMinLength?: number } = {}): (text: string) => boolean {
  const phrases = terms.map(foodMatchTokens).filter((phrase) => phrase.length > 0);
  const substringTerms = options.substringMinLength
    ? terms.map((term) => term.toLowerCase().replace(/[^a-z]/g, "")).filter((term) => term.length >= options.substringMinLength! && !term.includes(" "))
    : [];
  return (text: string) => {
    const tokens = foodMatchTokens(text);
    if (phrases.some((phrase) => phraseIn(tokens, phrase))) return true;
    return substringTerms.some((term) => tokens.some((token) => token.length > term.length && token.includes(term)));
  };
}

// ---------- 음식 어휘 ----------

/**
 * 한국 음식 이름(로마자). 요리·메뉴 단위. 표기가 갈리는 것은 흔한 표기를 같이 둔다(jajangmyeon/jjajangmyeon).
 * 붙여 쓴 질의("kimchijjigae")를 잡으려고 5글자 이상은 토큰 안 부분 일치도 본다.
 */
export const KOREAN_DISH_NAMES = [
  // 국·찌개·탕·전골
  "jjigae", "chigae", "guk", "gukbap", "tang", "jeongol", "kimchi jjigae", "doenjang jjigae", "sundubu", "budae jjigae",
  "samgyetang", "seolleongtang", "gomtang", "galbitang", "gamjatang", "haejangguk", "miyeokguk", "yukgaejang", "maeuntang",
  "sundaeguk", "tteokguk", "ttukbaegi", "chueotang", "dakhanmari", "dak bokkeumtang", "dakdoritang",
  // 밥·죽·도시락
  "bap", "bibimbap", "bibim", "bokkeumbap", "ssambap", "deopbap", "juk", "jeonbokjuk", "dosirak", "hanjeongsik", "heotjesatbap",
  // 면
  "naengmyeon", "naengmyun", "guksu", "kalguksu", "kongguksu", "makguksu", "milmyeon", "jjolmyeon", "sujebi", "ramyeon", "ramyun",
  "jjajangmyeon", "jajangmyeon", "jjajang", "jjamppong", "champong", "jjapaguri", "japchae",
  // 고기·구이·찜
  "bulgogi", "galbi", "kalbi", "galbijjim", "tteokgalbi", "samgyeopsal", "samgyupsal", "chadolbaegi", "bossam", "jokbal",
  "dakgalbi", "jjimdak", "agujjim", "jjim", "jeyuk", "bokkeum", "gopchang", "makchang", "yukhoe", "hanu", "heukdwaeji",
  "gwamegi", "hoe", "chimaek", "yangnyeom", "anju",
  // 전·만두·김밥·반찬
  "jeon", "pajeon", "buchimgae", "bindaetteok", "mandu", "gimbap", "kimbap", "gimmari", "banchan", "kimchi", "gyeran jjim",
  "sundae", "abai sundae", "tangsuyuk",
  // 길거리 음식·디저트
  "tteokbokki", "topokki", "ddeokbokki", "rabokki", "tteok", "ddeok", "hotteok", "bungeoppang", "gyeranppang", "gyeran ppang",
  "eomuk", "odeng", "twigim", "dakkochi", "dakgangjeong", "sotteok", "hoppang", "jjinppang", "goguma", "bingsu", "patbingsu",
  "yakgwa", "yakbap", "injeolmi", "songpyeon", "gyeongdan", "hangwa", "sikhye", "sujeonggwa", "kkwabaegi", "soboro",
  "gukhwappang", "yeot", "gangjeong", "dalgona", "tanghulu", "gwaja", "hodugwaja", "hodu gwaja", "hwangnam", "omegi",
] as const;

/** 영어 음식 명사(토큰 일치만 - 부분 일치는 안 본다). "korean pancake", "rice cake soup" 같은 영어 질의용. */
export const ENGLISH_DISH_NOUNS = [
  "stew", "soup", "noodle", "noodles", "rice cake", "rice cakes", "rice bowl", "fried rice", "dumpling", "dumplings", "pancake",
  "pancakes", "porridge", "bbq", "barbecue", "pork belly", "short ribs", "ribs", "beef", "pork", "chicken", "fried chicken",
  "fish cake", "fish cakes", "seafood", "raw fish", "sashimi", "skewer", "skewers", "blood sausage", "sausage", "bread", "toast",
  "donut", "donuts", "doughnut", "cake", "cakes", "waffle", "ice cream", "shaved ice", "pastry", "cookie", "cookies", "candy",
  "popsicle", "corn dog", "corn dogs", "side dish", "side dishes", "lunch box", "hot pot", "cold noodles", "black pork", "crab",
  "abalone", "octopus", "squid", "sweet potato", "grilled fish", "fish",
] as const;

/** 음식 일반어 - 음식 이름이 없어도 이 말이 있으면 음식 주제로 본다("what to eat in jeonju", "busan local food"). */
export const FOOD_GENERIC_TERMS = [
  "food", "foods", "cuisine", "dish", "dishes", "meal", "meals", "menu", "eat", "eating", "restaurant", "restaurants",
  "street food", "breakfast", "lunch", "dinner", "snack", "snacks", "dessert", "desserts", "bakery", "market food",
  "night market", "pojangmacha", "specialty",
] as const;

const hasDishName = makeMatcher(KOREAN_DISH_NAMES, { substringMinLength: 5 });
const hasEnglishDish = makeMatcher(ENGLISH_DISH_NOUNS);
const hasFoodGeneric = makeMatcher(FOOD_GENERIC_TERMS);

/** 요리·메뉴 이름(로마자 또는 영어)이 들어 있는가. 식재료 판정에서 "음식 이름이 있으면 살린다"의 기준이다. */
export function hasDishTerm(topic: string): boolean {
  return hasDishName(topic) || hasEnglishDish(topic);
}

/** 음식 주제인가 - 음식 이름이나 음식 일반어가 하나라도 있어야 한다(2026-11-25 음식 게이트). */
export function isFoodTopic(topic: string): boolean {
  return hasDishTerm(topic) || hasFoodGeneric(topic);
}

/**
 * 시드와 후보가 "같은 음식"인지 볼 때 빼는 범용 낱말(2026-11-25). 시드 "sokcho food"의 변형 질의가 "what happens if a mosquito lands
 * on your food"를, "soboro bread"가 "can undercooked bread make you sick"을 냈다 - food·bread 같은 범용어 하나로 이어진 것이다.
 * 이 낱말들을 뺀 시드 고유 낱말(sokcho·soboro)이 후보에 있어야 한다. 시드가 범용어뿐이면("korean desserts") 원래대로 본다.
 */
export const FOOD_SEED_GENERIC_WORDS: readonly string[] = [
  ...ENGLISH_DISH_NOUNS, ...FOOD_GENERIC_TERMS,
  "korea", "korean", "traditional", "street", "local", "regional", "market", "famous", "what", "is", "types", "type", "of",
];

// ---------- 지역 향토 음식(로컬 우위) ----------

/**
 * 한국 지역명 - 음식 주제에 붙으면 "지역 향토 음식"으로 본다(+15, Regional Food). 서울(seoul)은 넣지 않는다 - "seoul food"는
 * 관광 일반어라 향토성이 없다. 대신 음식으로 이름난 서울 동네·시장(신당동·장충동·광장시장)은 넣는다.
 */
export const KOREAN_FOOD_REGIONS = [
  // 시·군
  "jeonju", "chuncheon", "andong", "busan", "tongyeong", "chungmu", "gangneung", "chodang", "jeju", "uijeongbu", "suwon", "naju",
  "gwangju", "damyang", "sokcho", "masan", "changwon", "pyongyang", "pyeongyang", "hamhung", "hamheung", "cheonan", "gyeongju",
  "daegu", "jinju", "yeosu", "mokpo", "pohang", "incheon", "ulsan", "eonyang", "gwangyang", "daejeon", "gongju", "namwon",
  "hoengseong", "yeongdeok", "uljin", "pocheon", "idong", "geoje", "gimhae", "cheongju", "boseong", "hadong",
  // 도·권역
  "jeolla", "jeonla", "gyeongsang", "chungcheong", "gangwon", "gyeonggi",
  // 음식으로 이름난 동네·시장
  "sindang dong", "sindangdong", "jangchung dong", "jangchungdong", "gwangjang market", "jagalchi", "nampo dong", "seomun market",
  "dongnae", "tongin market", "mangwon market",
  // 지역성 자체를 말하는 말
  "regional", "local specialty", "hyangto",
] as const;

/** 지역명이 없어도 그 자체로 특정 지역 향토 음식인 이름(천안 호두과자, 경주 황남빵, 포항 과메기, 부산 밀면·돼지국밥 등). */
export const REGIONAL_DISH_NAMES = [
  "hodu gwaja", "hodugwaja", "hwangnam", "gyeongju bread", "gwamegi", "milmyeon", "dwaeji gukbap", "chungmu gimbap", "makguksu",
  "ssiat hotteok", "abai sundae", "omegi tteok", "gogi guksu", "heukdwaeji", "black pork", "chodang sundubu", "eonyang bulgogi",
] as const;

const hasRegion = makeMatcher(KOREAN_FOOD_REGIONS);
const hasRegionalDish = makeMatcher(REGIONAL_DISH_NAMES);

/** 지역 향토 음식인가(지역명 또는 지역 고유 음식명). */
export function isRegionalFoodTopic(topic: string): boolean {
  return hasRegion(topic) || hasRegionalDish(topic);
}

// ---------- 제외 3종 ----------

/**
 * ① 혐오 식품 - 소개하지 않는다(애드센스·브랜드 리스크, "이상한 음식" 낚시 각도). **사용자 확정 전 초안**(2026-11-25).
 * 넣고 빼는 것은 이 배열 한 곳이다. 음식 모드에서만 쓴다 - "gross"·"bug" 같은 말이 이전(생활) 모드의 "gross salary"·"bed bugs"를
 * 잡으면 안 된다(음식 모드는 음식 게이트를 먼저 통과한 후보만 보므로 이 말들이 음식 맥락에서만 걸린다).
 */
export const AVERSIVE_FOOD_TERMS = [
  // 개고기
  "dog meat", "dog soup", "dog stew", "eat dog", "eating dog", "eat dogs", "boshintang", "bosintang", "gaejang", "gaesoju",
  "yeongyangtang",
  // 번데기·곤충
  "beondegi", "bundaegi", "beondaegi", "silkworm", "pupa", "pupae", "insect", "insects", "bug", "bugs", "cricket", "crickets",
  "grasshopper",
  // 산낙지·개불·홍어
  "sannakji", "san nakji", "live octopus", "gaebul", "penis fish", "spoon worm", "hongeo", "hongeohoe", "fermented skate",
  "skate fish",
  // 뱀·자라
  "snake", "snakes", "snake wine", "baemsul", "turtle", "soft shell turtle", "jara",
  // "이상한 음식" 각도
  "weird", "bizarre", "strange food", "strange foods", "strange korean food", "disgusting", "gross",
  "worst food", "worst foods",
] as const;

/**
 * ② 식재료·양념 - '음식'이 아니라 재료다. 두 갈래:
 *  - 제품·양념 명사(INGREDIENT_PRODUCT_TERMS): 음식 이름이 있어도 제외("tteokbokki sauce", "bulgogi marinade", "sesame oil").
 *  - 재료 이름(INGREDIENT_NAME_TERMS): **음식 이름이 없을 때만** 제외("gochujang"은 제외, "doenjang jjigae"는 통과).
 */
export const INGREDIENT_PRODUCT_TERMS = [
  "sauce", "sauces", "paste", "powder", "seasoning", "marinade", "oil", "seeds", "flakes", "gochugaru", "spice", "spices",
  "substitute", "brand", "brands", "where to buy", "buy", "grocery", "supermarket", "amazon", "costco", "walmart", "h mart",
  "hmart", "trader joe", "trader joes", "aldi", "frozen", "meal kit",
  // 포장 제품·조리 도구(2026-11-25 자동완성 실측: "jjamppong instant noodles", "samgyetang kit", "hodu gwaja pan", "bingsu machine").
  "instant", "instant noodles", "kit", "herb pack", "package", "packet", "in a can", "in can", "machine", "maker", "pan", "mold",
  "mix", "beads", "slime", "bibigo", "tous les jours", "paris baguette",
] as const;

export const INGREDIENT_NAME_TERMS = [
  "gochujang", "doenjang", "ganjang", "jang", "meju", "nuruk", "perilla", "kkaennip", "sesame", "korean pear", "asian pear",
  "napa cabbage", "cabbage", "radish", "garlic", "scallion", "green onion", "anchovy", "anchovies", "seaweed", "laver", "gim",
  "short grain rice", "sticky rice", "glutinous rice", "rice flour", "rice variety", "rice varieties", "korean rice", "mung bean",
  "soybean", "soybeans", "tofu", "chili pepper", "chili", "pepper", "gochu", "ginseng", "jujube", "yuja", "citron", "omija",
  "persimmon", "chamoe", "korean melon", "hallabong", "msg", "dasida",
] as const;

/** ③ 레시피 의도 - 이 사이트는 레시피 블로그가 아니다. */
export const RECIPE_INTENT_TERMS = [
  "recipe", "recipes", "how to make", "how do you make", "how to cook", "make at home", "at home", "homemade", "home made",
  "from scratch", "ingredient", "ingredients", "easy", "instant pot", "air fryer", "slow cooker", "crock pot", "crockpot",
  "oven", "microwave", "calorie", "calories", "nutrition", "keto", "cookbook", "cooking class", "cooking",
  // 레시피 채널·조리 단계(2026-11-25 실측: "gamjatang maangchi", "korean street toast chef john", "dongnae pajeon batter").
  "maangchi", "chef john", "bon appetit", "receta", "dough", "batter", "filling", "fillings", "ideas", "how long to cook",
] as const;

/** 음식 소개와 무관한 서비스 질의(배달·케이터링·프랜차이즈) - 음식 모드에서만 제외. */
export const FOOD_SERVICE_TERMS = ["delivery", "catering", "franchise"] as const;

/**
 * 글이 안 되는 잡음(음식 모드만, 2026-11-25 자동완성 실측): 발음·외국어 뜻 질의, 낱말 퍼즐, 방송·게임, 가게 리뷰·사진 페이지,
 * 회사·박람회, 해외 지명(공용 OVERSEAS_PLACES에 없는 것 - "naju gomtang flushing", "busan korean street food chennai").
 * 공용 해외 지명 목록에 넣지 않은 이유: "flushing" 같은 말이 생활 모드의 다른 주제(화장실)를 잡으면 안 된다.
 */
export const FOOD_NOISE_TERMS = [
  "pronunciation", "pronounce", "adalah", "que es", "rasa apa", "itu apa", "artinya", "ayam", "in hindi", "meaning in",
  "crossword", "crossword clue", "cast", "song", "drama", "cookie run", "reviews", "review", "photos", "health inspection", "yelp",
  "nearby", "co ltd", "corporation", "sdn bhd", "expo", "industry", "college",
  "flushing", "glenview", "chennai", "vizag", "kuching", "pekalongan", "kings cross", "brussels", "bonchon",
] as const;

const hasAversive = makeMatcher(AVERSIVE_FOOD_TERMS);
const hasIngredientProduct = makeMatcher(INGREDIENT_PRODUCT_TERMS);
const hasIngredientName = makeMatcher(INGREDIENT_NAME_TERMS);
const hasRecipeIntent = makeMatcher(RECIPE_INTENT_TERMS);
const hasFoodService = makeMatcher(FOOD_SERVICE_TERMS);
const hasFoodNoise = makeMatcher(FOOD_NOISE_TERMS);

export function isAversiveFoodTopic(topic: string): boolean {
  return hasAversive(topic);
}

export function isIngredientTopic(topic: string): boolean {
  if (hasIngredientProduct(topic)) return true;
  return hasIngredientName(topic) && !hasDishTerm(topic);
}

export function isRecipeTopic(topic: string): boolean {
  return hasRecipeIntent(topic);
}

export function isFoodNoiseTopic(topic: string): boolean {
  return hasFoodNoise(topic);
}

export function isFoodServiceTopic(topic: string): boolean {
  return hasFoodService(topic);
}

// ---------- 초포화 음식·로컬 먹는 때·음식 각도(점수) ----------

/**
 * 초포화 음식(-10): 외국인 저자 블로그·대형 매체가 이미 다 쓴 **일반형**. 지역 변형("jeonju bibimbap")이나 다른 요리 이름이 같이 있으면
 * ("kimchi jjigae", "bulgogi vs galbi") 감점하지 않는다 - 그건 일반형이 아니라 구체적인 요리다.
 */
export const SATURATED_FOOD_TERMS = [
  "kimchi", "bibimbap", "bulgogi", "korean bbq", "korean barbecue", "korean fried chicken", "tteokbokki", "topokki", "ramyeon",
  "ramyun", "ramen", "korean food", "korean dishes", "korean street food", "must try", "top 10", "best korean food", "michelin",
  "mukbang",
] as const;

/** 초포화 판정에서 "다른 요리 이름"으로 치지 않는 것 - 초포화 음식 자신과 그 조각(bibim·bap·tteok 등). */
const SATURATION_SELF_NAMES = new Set([
  "kimchi", "bibimbap", "bibim", "bap", "bulgogi", "tteokbokki", "topokki", "ddeokbokki", "tteok", "ddeok", "ramyeon", "ramyun",
  "yangnyeom", "chimaek",
]);
const hasSaturatedFood = makeMatcher(SATURATED_FOOD_TERMS);
const hasOtherDishName = makeMatcher(
  KOREAN_DISH_NAMES.filter((name) => !SATURATION_SELF_NAMES.has(name)),
  { substringMinLength: 5 }
);

/** 초포화 음식의 일반형인가(지역 변형·다른 요리 이름이 있으면 아니다). */
export function isSaturatedFoodTopic(topic: string): boolean {
  return hasSaturatedFood(topic) && !isRegionalFoodTopic(topic) && !hasOtherDishName(topic);
}

/** 한국인이 먹는 때·자리(로컬 우위 +15, 지역 향토 음식과 같은 축). 외국인 가이드가 잘 못 쓰는 "현지인은 언제 먹나". */
export const FOOD_LOCAL_OCCASION_TERMS = [
  "what koreans eat", "koreans eat", "do koreans", "how koreans", "hangover", "after drinking", "with soju", "with makgeolli",
  "rainy day", "boknal", "birthday", "new year", "chuseok", "seollal", "where locals", "locals eat",
] as const;
const hasLocalOccasion = makeMatcher(FOOD_LOCAL_OCCASION_TERMS);

export function hasFoodLocalOccasion(topic: string): boolean {
  return hasLocalOccasion(topic);
}

/**
 * 음식 각도(+15, 생활 모드의 운영 정보 축 자리): 이 사이트의 글 각도 - 무엇인지·어떻게·무엇과 먹나·어디서·가격·차이·맵기·유래 -
 * 를 묻는 질의. 운영 정보 축처럼 주제어가 아니라 **질문의 모양**을 잡는다.
 */
export const FOOD_ANGLE_TERMS = [
  "what is", "what are", "how to eat", "eat with", "served with", "how to order", "where to eat", "where to try", "what to eat",
  "price", "how much", "cost", "vs", "versus", "difference", "spicy", "taste", "taste like", "origin", "history", "why", "famous",
  "menu", "types", "type of", "kinds", "kind of",
] as const;
const hasAngle = makeMatcher(FOOD_ANGLE_TERMS);

export function hasFoodAngle(topic: string): boolean {
  return hasAngle(topic);
}

// ---------- 하위 라벨 ----------

/** 음식 글의 하위 Blogger 라벨(상위 라벨 "Food & Dining"에 하나 더 붙는다). 이름을 바꾸면 라벨 URL이 바뀐다. */
export const KOREAPLAIN_FOOD_SUBLABELS = ["Korean Dishes", "Regional Food", "Street Food & Desserts"] as const;
export type KoreaplainFoodSubLabel = (typeof KOREAPLAIN_FOOD_SUBLABELS)[number];

/** 길거리 음식·디저트 판정 어휘(하위 라벨 분류용). */
export const STREET_DESSERT_TERMS = [
  "street food", "street snack", "street snacks", "night market", "market food", "pojangmacha", "dessert", "desserts", "snack",
  "snacks", "bakery", "bread", "toast", "donut", "donuts", "cake", "waffle", "ice cream", "shaved ice", "pastry", "cookie",
  "cookies", "candy", "popsicle", "corn dog", "tteokbokki", "topokki", "rabokki", "hotteok", "bungeoppang", "gyeranppang",
  "gyeran ppang", "eomuk", "odeng", "fish cake", "twigim", "gimmari", "dakkochi", "dakgangjeong", "sotteok", "hoppang",
  "jjinppang", "goguma", "sweet potato", "bingsu", "patbingsu", "yakgwa", "injeolmi", "songpyeon", "gyeongdan", "hangwa",
  "sikhye", "sujeonggwa", "kkwabaegi", "soboro", "gukhwappang", "yeot", "gangjeong", "dalgona", "tanghulu", "tteok", "rice cake",
] as const;

const hasStreetDessert = makeMatcher(STREET_DESSERT_TERMS);

/**
 * 시드가 없는 음식 글(봇 직접 입력)의 하위 라벨을 문구로 정한다. 지역 향토 음식 > 길거리·디저트 > 대표 요리 순.
 * 시드가 있는 글은 시드의 하위 라벨을 쓴다(koreaplainSeeds.ts) - 이 함수는 시드 없는 경우의 폴백이다.
 */
export function classifyFoodSubLabel(topic: string): KoreaplainFoodSubLabel {
  if (isRegionalFoodTopic(topic)) return "Regional Food";
  if (hasStreetDessert(topic)) return "Street Food & Desserts";
  return "Korean Dishes";
}

// ---------- 음식 모드 게이트(한 곳) ----------

export type FoodTopicRejection = "aversive" | "not_food" | "ingredient" | "recipe" | "service" | "noise";

/**
 * 음식 모드에서 이 후보를 왜 버리나(통과면 null). 순서: 혐오 식품 → 식재료·양념(포장 제품·도구 포함) → 레시피 → 음식 아님 →
 * 배달 등 서비스 → 잡음.
 * 순서는 사유 집계용일 뿐 결과(버림/통과)는 순서와 무관하다.
 */
export function foodTopicRejection(topic: string): FoodTopicRejection | null {
  if (isAversiveFoodTopic(topic)) return "aversive";
  if (isIngredientTopic(topic)) return "ingredient";
  if (isRecipeTopic(topic)) return "recipe";
  if (!isFoodTopic(topic)) return "not_food";
  if (isFoodServiceTopic(topic)) return "service";
  if (isFoodNoiseTopic(topic)) return "noise";
  return null;
}
