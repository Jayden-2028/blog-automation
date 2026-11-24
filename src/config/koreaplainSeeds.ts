// 사용설명서 트랙(Korea Plain, 개편3 §4.2) 주제 수집의 **시작 시드**.
//
// 시의성 소스(실검·뉴스)가 아니라 해외 독자의 **검색 수요**에서 에버그린 주제를 뽑는다. 시드를 구글 영문
// 자동완성에 넣어 롱테일 질의("how to use t-money card in korea")를 얻고, 그중 아직 쓰지 않은 것을 21:00에
// 제안한다(workflows/koreaplain/runKoreaplainTopicCollection.ts).
//
// ✅ 기획 세션(⑤) **확정본 100개**(라벨당 20, 2026-10-08 반영 - 임시본 60개 전량 유지 + 40개 추가,
// `branding-2026-10/kscene-seeds.md` 스냅샷). 추가 후보가 생기면 그 문서가 아니라 이 배열에 직접 누적한다.
// News in Context 라벨은 공식 축에서 제외 확정(에버그린 수집과 안 맞고 얇은 뉴스 요약은 애드센스 리스크).
//
// 📌 **2026-10-11 실용 축 확장**(KEYWORD-REFRESH-2026-10.md §C): 시드가 "입국 전 문화 소개"에 치중해
// 한국에 **거주·체류 중인 외국인의 실용 정보**(환승·개통·본인인증·전입신고·공과금·분리수거·생활 앱 등)가
// 덜 뽑혔다. 그래서 총 **100 -> 117개**로 늘렸다 - "Living in Korea" 20 -> 32, "Travel & Transit" 20 -> 25,
// 나머지 세 라벨은 20 그대로. 라벨별 **하루 시드 배분은 그대로 균등**하다(pickSeedsForDay가 라벨마다
// 4개씩 번갈아 뽑으므로 pool이 커진 라벨은 한 바퀴가 길어질 뿐 하루 비중은 같다 - Living 8일,
// Travel 7일, 나머지 5일, 전체는 12일 안에 한 바퀴).
// 기존 시드는 하나도 지우지 않았다(기획⑤ 확정본 유지 - 누적만 한다).
// 시드를 DB `seed_queries`에 넣지 않은 이유: track 컬럼 추가가 migration(승인
// 게이트)이고, 영문 시드가 한국 NAVER 수집 경로(seed_queries 전체를 읽는 엔터·사회 job)에 섞이면 안 된다.
//
// 📌 **2026-10-30 로컬 우위 축**(branding-2026-10/kp-native-identity-2026-10.md §C-3): 사이트 43편의 86%가 외국인
// 저자 블로그가 이미 포화시킨 주제라, 한국인은 알지만 외국인 가이드가 잘 못 쓰는 질의를 **47개 추가**했다(117 -> 164).
// 개정안의 4~5단어 질의 50개는 자동완성이 37개나 비어서(롱테일이 너무 길다) 2~3단어로 줄여 실측으로 걸러 남겼다.
// 기존 시드는 하나도 지우지 않았다. 점수 쪽 가산·감점은 koreaplainTopics.ts의 LOCAL_EDGE_TERMS / SATURATED_TOURIST_TERMS가
// 맡는다. 라벨 5개 이름은 그대로다(Blogger 라벨 URL·About·시드 매핑이 묶여 있다).
//
// 📌 **2026-11-09 시드 재설계**(운영 1개월 GSC 실측): 노출/일 1~5위가 전부 "최근 바뀌었고 + 정답이 하나로 떨어지고 + 영어 출처가
// 빈약한" 운영 정보(거래시간·교통 신호·횡단보도 버튼·우버이츠·택시 앱)였고, 의미·호칭·추상 개념(unni·noona·nunchi)과 ARC·팁·식사
// 예절은 노출이 거의 없었다. 그래서 ① 바뀐 숫자·제도(거래시간·휴장일·요금·한도·최저임금·공휴일) ② 글로벌 서비스가 한국에서 되나
// ③ 한국에만 있는 장치·제도 ④ 숫자 하나로 끝나는 비용·시간, 네 틀로 **77개를 추가**했다(164 -> 241). 후보 174개(빈 시드는 말을 바꿔
// 다시 시도한 것 포함)를 자동완성에 넣어(autocompleteQueriesForSeed가 만드는 질의 그대로) **빈 시드 51개를 버렸고**, 사용 가능한
// 후보가 3건 미만이거나 기존 시드·다른 신규 시드와 겹치는 것, 관광 포화 용어를 품은 것(hanbok rental price)도 뺐다 - 목록은 PR 본문.
// 기존 시드는 하나도 지우지 않았다. 라벨 5개 이름은 그대로다. 점수 쪽은 koreaplainTopics.ts의 OPERATIONAL_TERMS(+15) /
// MEANING_SATURATED_TERMS(-10)가 맡는다.
//
// 📌 **2026-11-25 한국 음식 소개로 전환**(docs/ai-handoff/KOREAPLAIN-FOOD-PIVOT-2026-11.md): 2026-11-22 애드센스가 koreaplain을
// "가치 없는 콘텐츠"로 반려했다 - "외국인용 한국 생활 가이드"가 너무 넓고 포화됐다. 사용자 결정으로 **새 주제는 한국 음식(요리·메뉴
// 단위) 소개로 좁힌다** - 지역 향토 음식·길거리 음식·디저트 포함, 혐오 식품·식재료·레시피 제외. 그래서
//   · 위 241개는 지우지 않고 `KOREAPLAIN_LEGACY_SEEDS`로 **비활성 보관**한다(옛 job 라벨 + 되돌리기용).
//   · 수집은 `KOREAPLAIN_FOOD_SEEDS`(하위 라벨 3개)를 쓴다. 되돌리기는 `KSCENE_TOPIC_MODE=legacy` 하나다.
//   · 음식 글은 상위 라벨 "Food & Dining" + 하위 라벨(Korean Dishes / Regional Food / Street Food & Desserts) 두 개를 단다.
//     라벨 5개 이름은 그대로다(기존 글 라벨 URL이 묶여 있다).
// 선정 규칙(음식 게이트·제외 3종·지역 향토 음식 가점)은 koreaplainTopics.ts, 어휘표는 koreaplainFoodTerms.ts.
//
// label은 Blogger 라벨(글 분류)로 쓴다 - CHANNEL-SETUP-2026-10.md B-2의 카테고리 체계와 같다.

import { classifyFoodSubLabel, isFoodTopic, type KoreaplainFoodSubLabel } from "./koreaplainFoodTerms.js";
export { KOREAPLAIN_FOOD_SUBLABELS, type KoreaplainFoodSubLabel } from "./koreaplainFoodTerms.js";

export const KOREAPLAIN_LABELS = [
  "Travel & Transit",
  "Food & Dining",
  "Culture & Etiquette",
  "Living in Korea",
  "K-Wave Context",
] as const;
export type KoreaplainLabel = (typeof KOREAPLAIN_LABELS)[number];

/**
 * 시드 하나. `subLabel`은 음식 시드에만 있다(2026-11-25) - 발행 시 상위 라벨 "Food & Dining"에 하위 라벨 하나를 더 단다.
 */
export type KoreaplainSeed = { query: string; label: KoreaplainLabel; subLabel?: KoreaplainFoodSubLabel };

const seeds = (label: KoreaplainLabel, queries: readonly string[]): KoreaplainSeed[] => queries.map((query) => ({ query, label }));

/**
 * **이전(생활 가이드 전반) 시드 241개 - 2026-11-25부터 비활성 보관.** 지우지 않는다: ① 이 시드로 만든 옛 job의 Blogger 라벨이
 * KOREAPLAIN_LABEL_BY_SEED로 계속 이 배열에서 정해지고(재발행·수정 때 라벨이 바뀌면 안 된다) ② `KSCENE_TOPIC_MODE=legacy`로
 * 되돌리면 그대로 다시 쓰인다. 수집(KOREAPLAIN_SEEDS)에는 음식 모드에서 쓰이지 않는다.
 */
export const KOREAPLAIN_LEGACY_SEEDS: readonly KoreaplainSeed[] = [
  ...seeds("Travel & Transit", [
    "korea subway",
    "t-money card",
    "korea airport to seoul",
    "korea itx ktx train",
    "korea taxi app",
    "seoul bus guide",
    "korea sim card esim",
    "korea travel itinerary",
    "jeju island travel",
    "busan travel",
    "korea tax refund",
    "korea visa k-eta",
    "naver map in english",
    "korea intercity bus",
    "seoul day trip",
    "korea cherry blossom season",
    "korea autumn foliage",
    "korea winter travel",
    "korea travel budget",
    "incheon airport layover",
    // 체류 실용 축(2026-10-11, §C) - 관광 동선이 아니라 매일 타는 사람에게 필요한 것들.
    "korea bus subway transfer",
    "t-money card recharge",
    "korea traffic signals",
    "jaywalking in korea",
    "korea rush hour commute",
    // 2026-10-30 로컬 우위 축 - 타는 법이 아니라 타고 나서 한국 사람들이 하는 것. 자동완성 실측으로 2~3단어로 줄인 것만 남겼다.
    "korea ktx standing ticket",
    "korea highway rest stop",
    "priority seat korea",
    "korea bus etiquette",
    "korea taxi surcharge",
    "korea taxi tip",
    "seoul public bike",
    "korea parking rules",
    "korea subway etiquette",
    "korea bus stop button",
    // 2026-11-09 운영 정보 축 - A·B·C·D 틀 - 요금·운행시간·교통법규, 외국 서비스가 한국에서 되는가, 하이패스·따릉이류 장치. 자동완성 실측으로 빈 시드를 버린 것만 남겼다.
    "korea subway fare",
    "korea taxi fare",
    "korea bus fare",
    "incheon airport taxi fare",
    "ktx seoul busan price",
    "korea subway last train",
    "korea subway hours",
    "korea traffic light rules",
    "korea speed camera",
    "korea rental car license",
    "tesla charging korea",
    "google maps korea",
    "uber korea",
    "korea korail pass",
    "korea right turn on red",
    "korea toll",
    "korea hi pass",
    "korea kakao taxi",
  ]),
  ...seeds("Food & Dining", [
    "korean bbq",
    "korean convenience store food",
    "korean street food",
    "korean restaurant ordering",
    "korea vegetarian food",
    "korean fried chicken",
    "korean cafe culture",
    "seoul market food",
    "korean banchan",
    "korean soju drinking",
    "korean fast food chains",
    "traditional korean food",
    "korean food delivery app",
    "korean dessert cafe",
    "korean ramyeon",
    "halal food in korea",
    "korean food spicy level",
    "korean breakfast",
    "korean snacks must try",
    "korea michelin restaurants",
    // 2026-10-30 로컬 우위 축 - 외국인이 식당에서 실제로 막히는 지점. 자동완성 실측으로 2~3단어로 줄인 것만 남겼다.
    "korea restaurant call button",
    "korean side dish refill",
    "korea restaurant break time",
    "korea convenience store meal",
    "korea restaurant payment",
    "korea delivery fee",
    "korea delivery order",
    "korea solo dining",
    "korea study cafe",
    "korea restaurant hours",
    // 2026-11-09 운영 정보 축 - B·D 틀 - 배달 앱이 되는가, 영업시간·휴무, 숫자 하나로 끝나는 가격. 자동완성 실측으로 빈 시드를 버린 것만 남겼다.
    "uber eats korea",
    "doordash korea",
    "baemin foreigner",
    "korea restaurant opening hours",
    "korea cafe closing time",
    "korea coupang eats",
    "korea restaurant reservation",
    "korea restaurant vat",
    "korea convenience store hours",
    "korea soju price",
    "korea restaurant closed",
    "korea late night food",
    "korea chicken price",
  ]),
  ...seeds("Culture & Etiquette", [
    "korean etiquette",
    "korean honorifics",
    "korean age system",
    "korean tipping culture",
    "korean public bath jjimjilbang",
    "korean holidays chuseok seollal",
    "hanbok rental",
    "korean temple stay",
    "korean gift giving",
    "korean dining etiquette",
    "korean drinking culture",
    "korean dating culture",
    "korean wedding guest etiquette",
    "korean funeral etiquette",
    "bowing in korea",
    "korean nunchi",
    "removing shoes in korea",
    "korean superstitions",
    "korean business etiquette",
    "korean school culture",
    // 2026-10-30 로컬 우위 축 - 한국인 다수의 실제 관행. 자동완성 실측으로 2~3단어로 줄인 것만 남겼다.
    "korea gift money amount",
    "what koreans do on chuseok",
    "korea first birthday doljanchi",
    "korea apology culture",
    "korea apartment noise",
    "korea greeting",
    "korea 60th birthday",
    "korea company dinner",
    "korea age question",
    "korea ajumma",
    "korea elevator etiquette",
    // 2026-11-09 운영 정보 축 - A·C 틀 - 공휴일과 휴업, 법이 정한 연령·금지 규칙. 추상 에티켓이 아니라 구체적 금기·행동 규칙만 둔다(MEANING_SATURATED_TERMS 참조). 자동완성 실측으로 빈 시드를 버린 것만 남겼다.
    "korea public holidays",
    "korea chuseok closures",
    "korea childrens day",
    "korea buddha birthday",
    "korea smoking ban",
    "korea smoking age",
    "korea drinking age",
    "korea tattoo legal",
    "korea legal age",
    "korea drone rules",
    "korea unlucky number four",
    "korea chopsticks rules",
    "korea littering fine",
    "korea dress code temple",
  ]),
  ...seeds("Living in Korea", [
    "living in korea foreigner",
    "korea alien registration card",
    "korea bank account foreigner",
    "korea apartment rent jeonse",
    "korea health insurance foreigner",
    "korea delivery apps",
    "korea phone plan",
    "working in korea",
    "korean language learning",
    "korea cost of living",
    "korea recycling rules",
    "korea national pension refund",
    "korea hospital for foreigners",
    "korea pharmacy english",
    "korea driver license exchange",
    "korea income tax foreigner",
    "korea visa extension",
    "korea gym membership",
    "korea apartment utilities",
    "korea emergency numbers",
    // 체류 실용 축(2026-10-11, §C) - 입국 전 소개가 아니라 "지금 살면서 해야 하는 일"들.
    // 기존 시드와 겹치지 않는 축만 골랐다(개통·본인인증·행정 후속 절차·공과금·쓰레기·생활 앱·의료 실무).
    "korea prepaid usim",
    "korea identity verification foreigner",
    "korea resident registration move",
    "korea arc renewal process",
    "korea garbage bag rules",
    "korea food waste disposal",
    "korea utility bill payment",
    "korea internet installation",
    "korea karrot market app",
    "korea mobile banking foreigner",
    "korea clinic appointment foreigner",
    "korea health insurance bill",
    // 2026-10-30 로컬 우위 축 - 창구·동네 실무. 자동완성 실측으로 2~3단어로 줄인 것만 남겼다.
    "korea bank certificate",
    "korea hospital department",
    "korea pharmacy medicine",
    "korea dong office",
    "korea apartment fee",
    "korea gas inspection",
    "korea delivery box",
    "korea ondol",
    "korea moving day",
    // 2026-11-09 운영 정보 축 - A·B·C·D 틀 - 거래시간·휴장일, 최저임금·면세 한도, 외국 결제·배송 서비스, 병원 창구·응급실, 월 이용료. 자동완성 실측으로 빈 시드를 버린 것만 남겼다.
    "korea stock market hours",
    "krx holidays",
    "nxt trading hours",
    "korea minimum wage",
    "korea duty free limit",
    "korea jeonse deposit",
    "korea hospital reception",
    "apple pay korea",
    "venmo korea",
    "wise transfer korea",
    "amazon delivery korea",
    "costco korea membership",
    "airbnb korea legal",
    "esim korea support",
    "korea bank hours",
    "korea post office hours",
    "korea emergency room",
    "korea hospital cost",
    "korea gym fee",
  ]),
  ...seeds("K-Wave Context", [
    "kpop fan culture",
    "korean drama filming locations",
    "kpop concert tickets korea",
    "korean variety show",
    "korean webtoon",
    "kpop idol training system",
    "korean fan club lightstick",
    "korean beauty routine",
    "korean skincare ingredients",
    "korean fashion brands",
    "seoul hongdae gangnam",
    "korean film history",
    "kpop birthday cafe",
    "kpop photocard trading",
    "korean noraebang",
    "kdrama phrases meaning",
    "kpop comeback explained",
    "kpop fandom names",
    "korea music festivals",
    "kdrama food scenes",
    // 2026-10-30 로컬 우위 축 - 드라마 장면의 실제. 자동완성 실측으로 2~3단어로 줄인 것만 남겼다.
    "korean workplace titles",
    "korean office culture",
    "korean school lunch",
    "korean hagwon",
    "korean convenience store",
    "korean rooftop house",
    "korean apartment complex",
    // 2026-11-09 운영 정보 축 - B·D 틀 - 팬이 실제로 묻는 가격·규칙·가용성(공연 반입 규칙, 앨범값, 스트리밍 서비스). 자동완성 실측으로 빈 시드를 버린 것만 남겼다.
    "kpop concert ticket price",
    "kpop store hours",
    "korea photo booth price",
    "olive young tax refund",
    "kpop album price korea",
    "korea concert bag rules",
    "kpop merch korea",
    "korea cinema ticket price",
    "netflix korea",
    "korea fan cafe",
    "korea musical ticket",
    "korea album shop",
    "kpop pop up store",
  ]),
];

// ---------- 2026-11-25 한국 음식 소개 시드 ----------

/** 음식 글의 상위 Blogger 라벨. 기존 5개 라벨 중 하나다(이름을 바꾸면 라벨 URL이 바뀐다). */
export const KOREAPLAIN_FOOD_LABEL: KoreaplainLabel = "Food & Dining";

const foodSeeds = (subLabel: KoreaplainFoodSubLabel, queries: readonly string[]): KoreaplainSeed[] =>
  queries.map((query) => ({ query, label: KOREAPLAIN_FOOD_LABEL, subLabel }));

/**
 * **음식 시드**(2026-11-25 사용자 결정 - 애드센스 "가치 없는 콘텐츠" 반려 후 주제를 '한국 음식 소개'로 좁힌다).
 * 하위 라벨 3개(Korean Dishes / Regional Food / Street Food & Desserts)에 나눠 둔다. 2~3단어 영어 질의다 - 자동완성이
 * 잘 붙는 꼴. 후보 203개를 구글 영문 자동완성에 넣어(autocompleteQueriesForSeed가 만드는 질의 그대로, 2026-11-25 실측) **새 음식
 * 규칙을 통과하는 후보가 2건 미만인 시드 12개를 버렸고**, 후보가 포장 제품·재료·해외 마트로만 새는 시드 20개도 뺐다(목록은
 * KOREAPLAIN-FOOD-PIVOT-2026-11.md) → 171개. 이전 시드와 같은 문구는 두지 않는다(옛 job 라벨이 바뀌지 않게 - testKoreaplainFoodTopics.ts 단언).
 */
export const KOREAPLAIN_FOOD_SEEDS: readonly KoreaplainSeed[] = [
  // 대표 요리 - 국·찌개·탕, 면, 고기·구이·찜, 전·만두·김밥, 한상·사찰·궁중 음식, 그리고 "종류"를 묻는 묶음 질의.
  ...foodSeeds("Korean Dishes", [
    "kimchi jjigae", "doenjang jjigae", "sundubu jjigae", "budae jjigae", "samgyetang", "galbitang", "seolleongtang",
    "gamjatang", "haejangguk", "miyeokguk", "yukgaejang", "kalguksu", "japchae", "jjajangmyeon", "jjamppong",
    "what is naengmyeon", "mul naengmyeon", "bibim naengmyeon", "kongguksu", "samgyeopsal", "korean galbi", "bossam", "jokbal",
    "dakgalbi", "jjimdak", "bulgogi vs galbi", "chimaek", "gimbap", "korean mandu", "haemul pajeon", "korean juk",
    "dolsot bibimbap", "what is bibimbap", "gyeran jjim", "nakji bokkeum", "ojingeo bokkeum", "jeyuk bokkeum",
    "kimchi fried rice", "gomtang", "korean sundae", "sundaeguk", "korean raw fish", "hanjeongsik", "korean temple food",
    "korean royal cuisine", "jjapaguri", "chadolbaegi", "hanu beef", "gopchang", "yukhoe", "maeuntang", "korean grilled fish",
    "jjolmyeon", "bibim guksu", "janchi guksu", "sujebi", "dakhanmari", "dosirak", "korean anju", "korean chinese food",
    "tangsuyuk", "haemul tang", "types of kimchi", "ssambap", "tteokguk", "kimchi jjim", "korean cold noodles",
    "korean hangover soup", "korean bbq cuts", "korean stew types", "korean soup types", "korean noodle dishes",
    "korean pork dishes", "korean beef dishes", "korean seafood dishes",
  ]),
  // 지역 향토 음식 - 지역명 + 음식, 지역 고유 음식명, 음식으로 이름난 동네·시장, "<도시> food" 묶음.
  ...foodSeeds("Regional Food", [
    "jeonju bibimbap", "chuncheon dakgalbi", "andong jjimdak", "busan dwaeji gukbap", "busan milmyeon", "chungmu gimbap",
    "chodang sundubu", "jeju gogi guksu", "jeju black pork", "uijeongbu budae jjigae", "suwon galbi", "naju gomtang",
    "gwangju tteokgalbi", "abai sundae", "masan agujjim", "pyongyang naengmyeon", "hamhung naengmyeon", "hodu gwaja",
    "hwangnam bread", "daegu makchang", "chuncheon makguksu", "jeonju kongnamul gukbap", "busan eomuk", "ssiat hotteok",
    "jeonbokjuk", "haemul ttukbaegi", "pohang gwamegi", "jinju bibimbap", "jinju naengmyeon", "incheon jjajangmyeon",
    "hoengseong hanu", "yeongdeok crab", "pocheon galbi", "sindang dong tteokbokki", "jangchung dong jokbal", "busan food",
    "jeonju food", "jeju food", "daegu food", "gyeongju food", "jeolla food", "gangneung food", "sokcho food", "andong food",
    "eonyang bulgogi", "gwangyang bulgogi", "jeju abalone", "dongnae pajeon", "omegi tteok", "korean regional food",
    "jeonju street food", "jeju street food", "busan street food", "daegu street food", "gangneung sundubu", "chuncheon food",
    "suwon food",
  ]),
  // 길거리 음식·디저트 - 포장마차·시장 간식, 떡·한과·전통 음료, 빙수.
  ...foodSeeds("Street Food & Desserts", [
    "what is tteokbokki", "hotteok", "bungeoppang", "gyeran ppang", "korean corn dog", "korean fish cake", "korean street toast",
    "dalgona candy", "patbingsu", "yakgwa", "injeolmi", "types of tteok", "songpyeon", "twigim", "gimmari", "mayak gimbap",
    "bindaetteok", "gwangjang market food", "myeongdong street food", "bamdokkaebi night market", "dakkochi", "hoppang",
    "korean shaved ice", "hangwa", "sikhye", "sujeonggwa", "kkwabaegi", "soboro bread", "dakgangjeong", "tteok kkochi",
    "sotteok sotteok", "rabokki", "jjinppang", "chapssal donut", "korean rice cake", "korean traditional dessert",
    "korean desserts", "gyeongdan", "korean street snacks",
  ]),
];

/**
 * 주제 선정 모드(2026-11-25). 기본 `food`(음식 시드 + 음식 규칙). `KSCENE_TOPIC_MODE=legacy`면 이전 시드·규칙으로 되돌린다
 * (워크플로 kscene-topic.yml이 저장소 변수 KSCENE_TOPIC_MODE를 넘긴다). 되돌리기는 변수 하나다.
 */
export type KoreaplainTopicMode = "food" | "legacy";
export const KOREAPLAIN_TOPIC_MODE: KoreaplainTopicMode = process.env.KSCENE_TOPIC_MODE?.trim().toLowerCase() === "legacy" ? "legacy" : "food";

/** 수집에 쓰는 시드(모드가 정한다). 음식 모드에서 이전 시드는 수집에 쓰이지 않는다. */
export const KOREAPLAIN_SEEDS: readonly KoreaplainSeed[] = KOREAPLAIN_TOPIC_MODE === "food" ? KOREAPLAIN_FOOD_SEEDS : KOREAPLAIN_LEGACY_SEEDS;

/**
 * 시드 문구 -> 라벨. 자동완성 결과가 어느 시드에서 나왔는지로 글 라벨을 정한다. **이전 시드와 음식 시드를 둘 다** 싣는다 -
 * 모드와 무관하게 옛 job(이전 시드)의 라벨이 그대로 나와야 한다.
 */
export const KOREAPLAIN_LABEL_BY_SEED: Readonly<Record<string, KoreaplainLabel>> = Object.fromEntries(
  [...KOREAPLAIN_LEGACY_SEEDS, ...KOREAPLAIN_FOOD_SEEDS].map((seed) => [seed.query, seed.label])
);

/** 시드 문구 -> 음식 하위 라벨(음식 시드만). */
export const KOREAPLAIN_SUBLABEL_BY_SEED: Readonly<Record<string, KoreaplainFoodSubLabel>> = Object.fromEntries(
  KOREAPLAIN_FOOD_SEEDS.flatMap((seed) => (seed.subLabel ? [[seed.query, seed.subLabel]] : []))
);

/** 라벨을 못 찾을 때(시드가 바뀐 옛 job 등)의 기본 라벨. */
export const KOREAPLAIN_DEFAULT_LABEL: KoreaplainLabel = "Living in Korea";

/**
 * Blogger에 다는 라벨 목록. 상위 라벨이 **항상 첫 번째**다(All Guides가 첫 라벨로 묶는다 - tkmPostStructure.ts).
 *  - 시드가 있으면 그 시드의 라벨(+ 음식 시드면 하위 라벨).
 *  - 시드가 없는 봇 직접 입력 job(2026-11-21~)은 음식 모드에서 keyword가 음식 주제면 "Food & Dining" + 문구로 정한 하위 라벨.
 *  - 그 밖(시드가 바뀐 옛 job 등)은 기본 라벨 하나. 옛 글의 라벨은 바뀌지 않는다.
 */
export function koreaplainLabelsFor(job: { seedQuery?: string | null; keyword?: string | null; directInput?: boolean }): string[] {
  const seed = job.seedQuery ?? "";
  const label = KOREAPLAIN_LABEL_BY_SEED[seed];
  if (label) {
    const subLabel = KOREAPLAIN_SUBLABEL_BY_SEED[seed];
    return subLabel ? [label, subLabel] : [label];
  }
  if (job.directInput && KOREAPLAIN_TOPIC_MODE === "food" && job.keyword && isFoodTopic(job.keyword)) {
    return [KOREAPLAIN_FOOD_LABEL, classifyFoodSubLabel(job.keyword)];
  }
  return [KOREAPLAIN_DEFAULT_LABEL];
}

function intEnv(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? NaN : Number.parseInt(value, 10);
  return Number.isNaN(parsed) || parsed <= 0 ? fallback : parsed;
}

export const KOREAPLAIN_TOPIC_CONFIG = {
  // 환경변수 이름은 옛 코드명 그대로다(GitHub 시크릿에 등록된 이름이라 바꾸면 발행이 끊긴다).
  /** 한 번에 자동완성을 돌릴 시드 수. 날짜로 돌려 가며 고른다(전체가 며칠 안에 한 바퀴). */
  seedsPerRun: intEnv(process.env.KSCENE_SEEDS_PER_RUN, 20),
  /**
   * 알림으로 제안할 주제 수(§4.2: 5~10건). **2026-11-14 사용자 요청으로 8 -> 5.**
   *
   * 하한·상한 공식(`defaultPracticalFloor`·`defaultLocalEdgeFloor`·`perLabelCap`)은 topN 비례라 그대로 둔다 -
   * 5건이면 실용 하한 2건(40%, 전 37.5%)·로컬 우위 하한 1건(20%, 전 25%)·라벨 상한 2건(40%, 전 37.5%)이다.
   * 라벨 상한 2면 5건이 최소 3개 라벨에 걸쳐 다양성도 유지된다.
   * 공급은 충분하다 - 실측 후보가 하루 100~270건이라 5건을 못 채우는 날은 중복 제외 때문이지 후보 부족이 아니다.
   */
  topicsPerRun: intEnv(process.env.KSCENE_TOPICS_PER_RUN, 5),
  /** 자동완성 요청 사이 간격(ms) - 공개 엔드포인트라 부드럽게 쓴다. */
  requestDelayMs: intEnv(process.env.KSCENE_AUTOCOMPLETE_DELAY_MS, 250),
  /** 기발행·기제안 주제와 이 값 이상 겹치면 같은 주제로 본다(토큰 자카드, 0~1). */
  duplicateSimilarity: 0.6,
  /**
   * **제안만 하고 고르지 않은** 주제를 다시 제안하지 않는 기간(일).
   *
   * job이 된 주제(기발행·집필 중)는 이 기간과 무관하게 **영구히** 다시 제안하지 않는다 - 기간 제한은
   * 제안 기억에만 걸린다(`koreaplainExistingTopics.ts` 머리글). 시드가 241개뿐이라 제안 기억까지
   * 영구로 두면 몇 달 뒤 뽑을 것이 없어진다.
   */
  proposalMemoryDays: 60,
  // 환경변수 이름은 옛 코드명 그대로다(GitHub 시크릿에 등록된 이름이라 바꾸면 발행이 끊긴다).
  /**
   * 레딧 보조 관찰(2026-10-28, koreaplainTopics.ts 상단 C). 기본 꺼짐 - `KSCENE_REDDIT_ENABLED=true`일 때만 호출한다.
   * 레딧은 후보를 만들지 않고 자동완성 후보의 교차 신호로만 쓴다.
   */
  redditEnabled: process.env.KSCENE_REDDIT_ENABLED?.trim().toLowerCase() === "true",
  /** 레딧 요청 간격(ms). 1초 아래로는 내리지 않는다(공개 엔드포인트 예의). */
  redditDelayMs: Math.max(1000, intEnv(process.env.KSCENE_REDDIT_DELAY_MS, 1500)),
  /** 주제 선정 모드(2026-11-25). KOREAPLAIN_TOPIC_MODE 참조. */
  topicMode: KOREAPLAIN_TOPIC_MODE,
} as const;
