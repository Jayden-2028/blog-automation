// 내부 category + 제목 -> 티스토리 카테고리 **이름**(TISTORY_AUTO_PUBLISH_DESIGN.md §1).
//
// 티스토리 카테고리(2026-11-01 개편, 대분류 3 · 하위 8):
//   이슈 해설   > 사건·사고와 재판 · 정치와 국정 · 국방·외교와 북한
//   생활과 돈   > 생활 혜택과 제도 · 돈과 부동산 · 개인정보 유출과 보안
//   오늘의 화제 > 화제와 발견 · 인물과 스타 이슈
// 발행기는 화면의 카테고리 목록에서 **이름의 글자로** 찾아 누른다. 하위 카테고리는 이름만으로
// 찾히므로 대분류는 쓰지 않는다. 목록에 없는 이름이면 발행기는 카테고리를 건드리지 않고 경고만 남긴다.
//
// **왜 내부 category로 못 고르는가**(2026-11-01 실측). 사회 트랙 수집 라벨은 incident/living/
// community 셋뿐인데, 발행본 115건 중 `living` 하나에 51건이 몰려 있었고 그 안에 부동산 분양·주가
// 전망·개인정보 유출·방송인 논란·커뮤니티 밈이 전부 섞여 있었다. 라벨은 "어느 수집기가 물어 왔나"를
// 말할 뿐 주제를 말하지 않는다. 그래서 **제목의 낱말로 판정**하고, 아무 규칙도 걸리지 않을 때만
// 내부 category의 기본값으로 떨어진다.
//
// LLM을 쓰지 않는다 - `koreaplainTopics.ts`와 같은 선택이다. 카테고리는 틀려도 일괄 변경으로 고칠 수
// 있는 표시값이고, 발행 경로에 LLM 호출을 하나 더 두는 비용이 그보다 크다.

export const TISTORY_CATEGORIES = [
  "사건·사고와 재판",
  "정치와 국정",
  "국방·외교와 북한",
  "생활 혜택과 제도",
  "돈과 부동산",
  "개인정보 유출과 보안",
  "화제와 발견",
  "인물과 스타 이슈",
] as const;

export type TistoryCategory = (typeof TISTORY_CATEGORIES)[number];

/**
 * 아무 규칙도 걸리지 않을 때 내부 category가 주는 기본값.
 *
 * `living`은 **화제와 발견**으로 떨어진다(2026-11-01 실측). 생활 라벨 안에서 진짜 "혜택·제도"는
 * 아래 §제도 규칙이 낱말로 먼저 집어 가고, 거기 안 걸리고 남는 `living`은 소비 체험·동물·과학·
 * 커뮤니티 화제 쪽이 더 많았다. `living` 기본값을 "생활 혜택과 제도"로 두면 그것들이 전부
 * 혜택 칸으로 빨려 들어간다.
 */
export const TISTORY_CATEGORY_BY_INTERNAL: Readonly<Record<string, TistoryCategory>> = {
  incident: "사건·사고와 재판",
  community: "화제와 발견",
  living: "화제와 발견",
  parenting: "생활 혜택과 제도",
  entertainment: "인물과 스타 이슈",
  ott: "인물과 스타 이슈",
  person: "인물과 스타 이슈",
};

export const TISTORY_FALLBACK_CATEGORY: TistoryCategory = "화제와 발견";

/**
 * 판정 규칙. **위에서부터 먼저 걸린 것이 이긴다** - 순서가 규칙의 일부다.
 *
 * 순서를 이렇게 둔 이유(2026-11-01 실측 129건으로 맞췄다):
 *   - 유출·해킹이 가장 먼저다. 기업 이름과 함께 와서 돈·생활 규칙에 먼저 걸리기 쉽다.
 *   - **제도·혜택이 재판보다 먼저다.** "육아휴직 불이익, 기소는 2.5%뿐"은 `기소`가 들어 있지만
 *     독자가 찾는 것은 육아휴직 제도다. "비브리오패혈증 주의, 3명 중 2명 사망"도 `사망`보다
 *     `주의`가 글의 용건이다.
 *   - **국방·북한이 재판보다 먼저다.** "김정은 사망설"은 `사망`이 들어 있지만 사건이 아니다.
 *   - **동물·과학 발견이 재판보다 먼저다.** "멸종위기종" 같은 말은 사고 기사와 어휘가 겹친다.
 *   - 재판·수사가 정치보다 먼저다. "김건희 추가 구속영장"은 정치 인물이지만 용건은 영장이다.
 *   - 정치가 돈보다 먼저다. "국민연금 성과급 300억"은 성과급이지만 국정감사 이야기다.
 *   - 인물은 뒤쪽이다. 인물 이름은 어느 주제에나 붙으므로, 다른 규칙이 다 빗나간 뒤에 본다.
 */
const RULES: ReadonlyArray<{ category: TistoryCategory; pattern: RegExp }> = [
  {
    category: "개인정보 유출과 보안",
    pattern: /개인정보\s*유출|고객정보\s*유출|회원정보|정보\s*유출|유출\s*사고|해킹|랜섬웨어|피싱|보안\s*사고|무단\s*접근/,
  },
  {
    // 제도·혜택의 "강한 낱말"만. 넓은 말(무료·가이드·총정리)은 아래 두 번째 생활 규칙으로 내린다.
    category: "생활 혜택과 제도",
    pattern:
      /수당|지원금|보조금|과태료|쿠폰|혜택|이벤트|예매|로또|복권|당첨|퀴즈|정답|육아휴직|보육|어린이집|출산|임시공휴일|공휴일|연차|셔틀|막차|스쿨존|감면|보험료|지급\s*대상|신청\s*방법|주의|증상|예방|백신|발암|유해물질|검출/,
  },
  {
    category: "국방·외교와 북한",
    pattern:
      /북한|김정은|김여정|대북|확성기|민통선|GOP|철책|지뢰|병역|군면제|예술체육요원|국방부|국방위원장|주한미군|미사일|한미\s*동맹|한·미\s*동맹|우크라|러시아\s*석유|중국산\s*CCTV|비자\s*발급\s*거부/,
  },
  {
    // 동물·자연·과학 발견. 사고 기사와 어휘가 겹쳐(목격·현황) 재판 규칙보다 먼저 본다.
    category: "화제와 발견",
    pattern:
      /천연기념물|멸종위기|야생|수달|상어|판다|고래|동물원|번식|노벨|망원경|유령\s*입자|우주|자격증|가격차|가격\s*차이/,
  },
  {
    category: "사건·사고와 재판",
    pattern:
      /징역|벌금형|무죄|유죄|구속영장|구속|체포|살해|살인|숨진|사망|흉기|성폭행|성착취|강제추행|압수수색|기소|재판부|선고|집행유예|금고\s*\d|피의자|혐의|스토킹|감금|갈취|필로폰|마약|투약|사형|화재|붕괴|식중독|추락|실종|송환|도피|폭행|난동|사기|횡령|배임|공개처형|총살|상품권\s*\d+억/,
  },
  {
    category: "정치와 국정",
    pattern:
      /국정감사|국감|국회|대통령|장관|의원|공수처|중수청|시정명령|과징금|추경|예산|국민청원|선관위|투표지|당기|민주당|국민의힘|정당|지자체|공공기관|진흥원|연구소|국민연금|나라장터|납품\s*가격|파업|임금협상|불법체류|무비자|의전|헌재|위헌|모스크|행정|차단|발언\s*논란/,
  },
  {
    category: "돈과 부동산",
    pattern:
      /주가|증시|코스피|코스닥|시간외|애널리스트|실적|분양|청약|집값|매매가|전세|재건축|지분적립형|타입|평형|견본주택|경매行|환율|금리|성과급|자사주|메모리|반도체|상장|시가총액|폭락|급등|FDA\s*심사/,
  },
  {
    category: "인물과 스타 이슈",
    pattern:
      /배우|가수|아이돌|셰프|유튜버|크리에이터|감독|선수|금메달|은메달|동메달|복귀작|시상식|예능|화보|열애|결혼\s*발표|이혼|해명|저격|오열|출전\s*정지|대기심|A매치|최다골|로카르노|노동\s*착취/,
  },
  {
    // 남은 생활 정보. 넓은 낱말이라 다른 주제를 가로채지 않도록 맨 뒤에 둔다.
    category: "생활 혜택과 제도",
    pattern: /무료|할인|총정리|가이드|통행|개장|재고|예약|단속|요금|개교|국제학교/,
  },
];

export type TistoryCategoryInput = {
  /** 내부 수집 라벨(incident/living/community/…). 규칙이 다 빗나갈 때만 쓴다. */
  category?: string | null;
  /** 발행 제목. 판정의 1순위 재료다. */
  title?: string | null;
  /** 수집 키워드. 제목에 안 남은 낱말이 여기 있을 수 있어 같이 본다. */
  keyword?: string | null;
};

/** 규칙에 걸린 카테고리. 아무것도 안 걸리면 null. */
export function matchTistoryCategoryRule(text: string): TistoryCategory | null {
  for (const rule of RULES) {
    if (rule.pattern.test(text)) return rule.category;
  }
  return null;
}

/**
 * 발행에 쓸 티스토리 카테고리 이름.
 *
 * `TISTORY_DEFAULT_CATEGORY`가 있으면 전부 거기로 몰아넣는다(옛 동작 그대로 - 사고 대응용 스위치).
 */
export function tistoryCategoryName(
  input: TistoryCategoryInput | string | null | undefined,
  env: Record<string, string | undefined> = process.env
): string {
  const forced = env.TISTORY_DEFAULT_CATEGORY?.trim();
  if (forced) return forced;

  // 옛 호출 모양(문자열 하나 = 내부 category)도 받는다.
  const normalized: TistoryCategoryInput = typeof input === "string" || input == null ? { category: input } : input;

  const text = [normalized.title, normalized.keyword].filter(Boolean).join(" ");
  const byRule = text ? matchTistoryCategoryRule(text) : null;
  if (byRule) return byRule;

  const internal = normalized.category?.trim();
  if (internal && TISTORY_CATEGORY_BY_INTERNAL[internal]) return TISTORY_CATEGORY_BY_INTERNAL[internal];
  return TISTORY_FALLBACK_CATEGORY;
}
