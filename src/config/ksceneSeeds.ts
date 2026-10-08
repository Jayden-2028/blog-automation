// 사용설명서 트랙(The Korea Manual, 개편3 §4.2) 주제 수집의 **시작 시드**.
//
// 시의성 소스(실검·뉴스)가 아니라 해외 독자의 **검색 수요**에서 에버그린 주제를 뽑는다. 시드를 구글 영문
// 자동완성에 넣어 롱테일 질의("how to use t-money card in korea")를 얻고, 그중 아직 쓰지 않은 것을 21:00에
// 제안한다(workflows/kscene/runKsceneTopicCollection.ts).
//
// ✅ 기획 세션(⑤) **확정본 100개**(라벨당 20, 2026-10-08 반영 - 임시본 60개 전량 유지 + 40개 추가,
// `branding-2026-10/kscene-seeds.md` 스냅샷). 추가 후보가 생기면 그 문서가 아니라 이 배열에 직접 누적한다.
// News in Context 라벨은 공식 축에서 제외 확정(에버그린 수집과 안 맞고 얇은 뉴스 요약은 애드센스 리스크).
// 시드를 DB `seed_queries`에 넣지 않은 이유: track 컬럼 추가가 migration(승인
// 게이트)이고, 영문 시드가 한국 NAVER 수집 경로(seed_queries 전체를 읽는 엔터·사회 job)에 섞이면 안 된다.
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
} as const;
