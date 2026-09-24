// 카테고리별 **어디를 먼저 뒤지는가**(2026-09-24 사용자 지적).
//
// 왜 생겼나: `output-format.md` §8-7에 "작품은 공식 스틸 1순위 → 못 찾으면 키노라이츠"를 적어
// 놨는데, **그 문서를 읽는 건 집필자뿐**이다. 실제로 검색하는 collectWebImages의 프롬프트에는
// 카테고리도 사이트 우선순위도 없었다. 규칙에 실행자가 없었던 것이다.
//
// 실측(2026-09-24, 연애박사):
//
//   추영우 김소현 연애박사        ->  700x1001  star.ytn.co.kr      (기사 사진)
//   site:kinolights.com 연애박사  -> 2747x1920  m.kinolights.com    (공식 스틸)
//   연애박사 키노라이츠           -> 2880x1920  m.kinolights.com    (공식 스틸)
//
// 검색 경로는 이미 닿는다. 새 스크래퍼가 필요한 게 아니라 **어디를 보라고 알려주면** 됐다.

export type ImageSearchPool = {
  /** 사람이 읽는 이름. 프롬프트에 그대로 들어간다. */
  label: string;
  /** 이 풀을 노리는 검색어 만드는 법. `{키워드}`가 원고 주제로 치환된다. */
  patterns: string[];
  /** 왜 이 순서인지. 프롬프트에 근거로 실린다. */
  note?: string;
};

/** 작품(드라마·영화·OTT·시리즈·방송) 서치풀. */
const ARTWORK_POOLS: ImageSearchPool[] = [
  {
    label: "작품 공식 채널",
    patterns: ["{키워드} 스틸컷", "{키워드} 공식 포스터", "{키워드} 제작발표회"],
    note: "방송사·배급사·OTT가 배포한 공식 스틸·포스터가 가장 깨끗하고 크다.",
  },
  {
    label: "키노라이츠",
    patterns: ["{키워드} 키노라이츠", "site:kinolights.com {키워드}"],
    note: "공식 페이지를 못 찾을 때 여기 미디어 섹션에 스틸이 모여 있다(m.kinolights.com).",
  },
  {
    label: "출연자 공식 SNS·소속사",
    patterns: ["{키워드} 인스타그램 공식", "{인물} 프로필"],
    note: "인물 단독 자리는 소속사 프로필·공식 계정이 낫다.",
  },
];

/**
 * 인물(연예인·스타·유명인·선수) 서치풀 — 사용자 규칙 2번(2026-09-24 신설).
 *
 * 규칙 원문:
 *   1. 인물 이름 + 주제 키워드로 검색해 **비교적 최신 + 고화질**을 고른다
 *   2. 프로필 사진은 **네이버 인물검색·나무위키**를 모두 활용한다
 *   3. 결과가 부족하면 **이름만** 검색해 깨끗하고 범용적인 사진을 고른다
 *
 * 실측 사고(오상욱): 이 규칙에 실행자가 없어 `오상욱 펜싱`처럼 이름+종목만 돌았다.
 * 주제 키워드(금메달·시상대)도, 인물검색·나무위키도 한 번도 안 봤다.
 */
const PERSON_POOLS: ImageSearchPool[] = [
  {
    label: "인물 + 주제 키워드",
    patterns: ["{인물} {키워드}", "{키워드}"],
    note: "규칙 1 - 이름과 주제를 함께 넣어 그 사건의 사진을 노린다. 최신·고화질을 고른다.",
  },
  {
    label: "네이버 인물검색·나무위키 프로필",
    patterns: ["{인물} 프로필", "{인물} 네이버 인물검색", "{인물} 나무위키"],
    note: "규칙 2 - 프로필 자리는 이 둘을 모두 본다.",
  },
  {
    label: "이름만",
    patterns: ["{인물}"],
    note: "규칙 3 - 위에서 부족하면 이름만 검색해 깨끗하고 범용적인 사진을 고른다.",
  },
];

/**
 * 어느 서치풀을 쓰나.
 *
 * **브리프 유형을 category보다 먼저 본다**(2026-09-24). 실측에서
 * `오상욱·추가은 금메달 황선우 은메달`이 `category=living`으로 분류돼 행사 서치풀
 * (주최·판매 공식 페이지)을 탔다. 인물이 주인공인 원고인데 인물 서치풀에 닿을 방법이 없었다 -
 * category만 보면 스포츠 선수·화제 인물이 영원히 living에 갇힌다.
 */
export function searchPoolsFor(
  category: string | null | undefined,
  briefType?: string | null
): ImageSearchPool[] {
  if (briefType === "celebrity") return PERSON_POOLS;
  if (briefType === "drama") return ARTWORK_POOLS;

  switch (category) {
    case "entertainment":
    case "ott":
      return ARTWORK_POOLS;
    case "living":
    case "community":
      return [
        {
          label: "주최·판매 측 공식 페이지",
          patterns: ["{키워드} 공식", "{키워드} 안내", "{키워드} 홈페이지"],
          note: "행사·제품은 주최·판매자가 올린 자료가 1차다.",
        },
      ];
    case "incident":
      return [
        {
          label: "언론 보도 화면",
          patterns: ["{키워드}"],
          note: "인물 사진은 피한다(피의자·피해자·미성년자). 기사 헤드라인 화면을 쓴다.",
        },
      ];
    default:
      return [];
  }
}

/** 프롬프트에 넣을 블록. 풀이 없으면 빈 배열이라 프롬프트가 예전과 같아진다. */
export function describeSearchPools(
  keyword: string,
  category: string | null | undefined,
  briefType?: string | null
): string[] {
  const pools = searchPoolsFor(category, briefType);
  if (pools.length === 0) return [];

  const lines = [
    "## 어디를 먼저 뒤지나 (이 순서를 지킨다)",
    "",
    "**일반 이미지 검색만 돌리면 기사 사진과 재가공 썸네일이 올라온다.** 아래 풀을 위에서부터",
    "실제로 시도하고, 위에서 쓸 만한 것이 나오면 거기서 멈춘다.",
    "",
  ];
  pools.forEach((pool, i) => {
    lines.push(`${i + 1}. **${pool.label}**`);
    if (pool.note) lines.push(`   ${pool.note}`);
    // `{인물}`은 자리마다 달라 여기서는 못 채운다 - 읽을 수 있는 말로 바꿔 둔다.
    const queries = pool.patterns
      .map((p) => `"${p.replace("{키워드}", keyword).replace("{인물}", "<그 인물 이름>")}"`)
      .join(", ");
    lines.push(`   검색어 예: ${queries}`);
  });
  lines.push("");
  lines.push("실측(2026-09-24 연애박사): 일반 검색은 700px 기사 사진을 줬고, 키노라이츠를 지정하니");
  lines.push("2747x1920 공식 스틸이 나왔다. **같은 자리에 쓸 수 있는 사진의 질이 이만큼 갈린다.**");
  return lines;
}

/**
 * 검색 API로 후보를 미리 받을 때 쓸 질의들(에이전트가 아니라 **코드**가 도는 경로).
 *
 * 원고가 준 검색어를 먼저 쓰고, 그다음 서치풀 질의를 붙인다. 앞에서 좋은 게 나오면 뒤는 덜 쓰인다.
 */
export function expandQueriesForPools(
  query: string,
  keyword: string,
  category: string | null | undefined,
  briefType?: string | null
): string[] {
  const pools = searchPoolsFor(category, briefType);
  if (pools.length === 0) return [query];

  const extra = pools
    .flatMap((pool) => pool.patterns)
    .map((pattern) => pattern.replace("{키워드}", keyword).replace("{인물}", query))
    .filter((q) => q !== query);

  return [query, ...new Set(extra)];
}
