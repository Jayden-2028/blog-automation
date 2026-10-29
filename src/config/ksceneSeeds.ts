// 사용설명서 트랙(Korea Plain, 개편3 §4.2) 주제 수집의 **시작 시드**.
//
// 시의성 소스(실검·뉴스)가 아니라 해외 독자의 **검색 수요**에서 에버그린 주제를 뽑는다. 시드를 구글 영문
// 자동완성에 넣어 롱테일 질의("how to use t-money card in korea")를 얻고, 그중 아직 쓰지 않은 것을 21:00에
// 제안한다(workflows/kscene/runKsceneTopicCollection.ts).
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
// 저자 블로그가 이미 포화시킨 주제라, 한국인은 알지만 외국인 가이드가 잘 못 쓰는 질의를 라벨별 10개씩 **50개 추가**했다
// (117 -> 167). 기존 시드는 하나도 지우지 않았다. 점수 쪽 가산·감점은 ksceneTopics.ts의 LOCAL_EDGE_TERMS /
// SATURATED_TOURIST_TERMS가 맡는다. 라벨 5개 이름은 그대로다(Blogger 라벨 URL·About·시드 매핑이 묶여 있다).
// 새 시드의 자동완성 빈 결과는 dry-run으로 걸러 팀장이 제거를 결정한다.
//
// label은 Blogger 라벨(글 분류)로 쓴다 - CHANNEL-SETUP-2026-10.md B-2의 카테고리 체계와 같다.

export const KSCENE_LABELS = [
  "Travel & Transit",
  "Food & Dining",
  "Culture & Etiquette",
  "Living in Korea",
  "K-Wave Context",
] as const;
export type KsceneLabel = (typeof KSCENE_LABELS)[number];

export type KsceneSeed = { query: string; label: KsceneLabel };

const seeds = (label: KsceneLabel, queries: readonly string[]): KsceneSeed[] => queries.map((query) => ({ query, label }));

export const KSCENE_SEEDS: readonly KsceneSeed[] = [
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
    // 2026-10-30 로컬 우위 축 - 타는 법이 아니라 타고 나서 한국 사람들이 하는 것.
    "korea subway priority seat",
    "korea bus back door exit",
    "korea taxi late night surcharge",
    "korea ktx standing ticket",
    "korea highway rest stop",
    "korea subway bike rules",
    "seoul public bike ttareungyi",
    "korea apartment visitor parking",
    "korea subway elevator etiquette",
    "korea bus stop bell when",
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
    // 2026-10-30 로컬 우위 축 - 외국인이 식당에서 실제로 막히는 지점.
    "korea restaurant call button",
    "korea restaurant self service water",
    "korean side dish refill",
    "korea restaurant break time",
    "korea pay at counter",
    "korean delivery minimum order",
    "korea convenience store meal",
    "korea solo dining honbap",
    "korea cafe study seat rules",
    "korea restaurant last order",
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
    // 2026-10-30 로컬 우위 축 - 한국인 다수의 실제 관행.
    "korea apartment noise neighbors",
    "korea elevator greeting",
    "korea gift money amount",
    "what koreans do on chuseok",
    "korea 60th birthday hwangap",
    "korea first birthday doljanchi",
    "korea company dinner hoesik",
    "korea asking age first meeting",
    "korea addressing strangers",
    "korea apology culture",
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
    // 2026-10-30 로컬 우위 축 - 창구·동네 실무.
    "korea which hospital department",
    "korea pharmacy without prescription",
    "korea gu office vs dong office",
    "korea bank certificate",
    "korea apartment management fee",
    "korea gas safety inspection visit",
    "korea apartment delivery box",
    "korea civil complaint minwon",
    "korea seasonal home checklist",
    "korea moving day rules",
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
    // 2026-10-30 로컬 우위 축 - 드라마 장면의 실제.
    "kdrama office culture real life",
    "kdrama apartment real life",
    "korean school lunch real",
    "korea hagwon cram school explained",
    "korean military service explained",
    "korean workplace titles",
    "kdrama convenience store real",
    "korean variety show terms",
    "kdrama rooftop house real",
    "korea apartment complex kdrama",
  ]),
];

/** 시드 문구 -> 라벨. 자동완성 결과가 어느 시드에서 나왔는지로 글 라벨을 정한다. */
export const KSCENE_LABEL_BY_SEED: Readonly<Record<string, KsceneLabel>> = Object.fromEntries(
  KSCENE_SEEDS.map((seed) => [seed.query, seed.label])
);

/** 라벨을 못 찾을 때(시드가 바뀐 옛 job 등)의 기본 라벨. */
export const KSCENE_DEFAULT_LABEL: KsceneLabel = "Living in Korea";

function intEnv(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? NaN : Number.parseInt(value, 10);
  return Number.isNaN(parsed) || parsed <= 0 ? fallback : parsed;
}

export const KSCENE_TOPIC_CONFIG = {
  /** 한 번에 자동완성을 돌릴 시드 수. 날짜로 돌려 가며 고른다(전체가 며칠 안에 한 바퀴). */
  seedsPerRun: intEnv(process.env.KSCENE_SEEDS_PER_RUN, 20),
  /** 알림으로 제안할 주제 수(§4.2: 5~10건). */
  topicsPerRun: intEnv(process.env.KSCENE_TOPICS_PER_RUN, 8),
  /** 자동완성 요청 사이 간격(ms) - 공개 엔드포인트라 부드럽게 쓴다. */
  requestDelayMs: intEnv(process.env.KSCENE_AUTOCOMPLETE_DELAY_MS, 250),
  /** 기발행·기제안 주제와 이 값 이상 겹치면 같은 주제로 본다(토큰 자카드, 0~1). */
  duplicateSimilarity: 0.6,
  /** 이미 제안했던 주제를 다시 제안하지 않는 기간(일). */
  proposalMemoryDays: 60,
  /**
   * 레딧 보조 관찰(2026-10-28, ksceneTopics.ts 상단 C). 기본 꺼짐 - `KSCENE_REDDIT_ENABLED=true`일 때만 호출한다.
   * 레딧은 후보를 만들지 않고 자동완성 후보의 교차 신호로만 쓴다.
   */
  redditEnabled: process.env.KSCENE_REDDIT_ENABLED?.trim().toLowerCase() === "true",
  /** 레딧 요청 간격(ms). 1초 아래로는 내리지 않는다(공개 엔드포인트 예의). */
  redditDelayMs: Math.max(1000, intEnv(process.env.KSCENE_REDDIT_DELAY_MS, 1500)),
} as const;
