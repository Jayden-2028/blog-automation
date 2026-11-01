// 티스토리 카테고리 판정 테스트(2026-11-01 개편). 네트워크·DB 없음.
//
// 배경: 카테고리를 `왜 지금 이슈일까` · `일상 생활 정보` 둘에서 대분류 3 · 하위 8로 늘렸다.
// 내부 수집 라벨(incident/living/community)로는 8칸을 고를 수 없다 - 발행본 115건 중 `living`
// 하나에 51건이 몰려 있었고 그 안에 부동산·주가·개인정보 유출·방송인·커뮤니티 밈이 섞여 있었다.
// 그래서 제목 낱말로 판정한다.
//
// 아래 "실측 표본"은 2026-11-01에 사람이 직접 배정한 발행본 129건에서 뽑았다. 규칙 순서를 이
// 표본으로 맞췄으므로(인샘플) **새 글 정확도는 이보다 낮다** - 이 테스트가 지키는 것은 정확도
// 숫자가 아니라 **순서 때문에 고쳐 둔 자리가 되돌아가지 않는 것**이다.

import {
  TISTORY_CATEGORIES,
  TISTORY_CATEGORY_BY_INTERNAL,
  TISTORY_FALLBACK_CATEGORY,
  matchTistoryCategoryRule,
  tistoryCategoryName,
} from "./tistoryCategoryMapping.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const NO_ENV: Record<string, string | undefined> = {};
const pick = (title: string, category: string | null = null, keyword = "") =>
  tistoryCategoryName({ title, category, keyword }, NO_ENV);

// ── 1. 카테고리 이름은 티스토리에 만든 8개와 같다 ──────────────────
{
  assert(TISTORY_CATEGORIES.length === 8, "하위 카테고리 8개");
  const names = new Set<string>(TISTORY_CATEGORIES);
  for (const v of Object.values(TISTORY_CATEGORY_BY_INTERNAL)) {
    assert(names.has(v), `내부 기본값이 실제 카테고리여야 한다: ${v}`);
  }
  assert(names.has(TISTORY_FALLBACK_CATEGORY), "폴백도 실제 카테고리");
}

// ── 2. 규칙 순서 — 먼저 걸려야 하는 것들 ───────────────────────────
{
  // 제도·혜택이 재판보다 먼저다: `기소`·`사망`이 들어 있어도 글의 용건은 제도다.
  assert(
    pick("육아휴직 신청했다고 불이익, 신고 2.8배 늘었는데 기소는 2.5%뿐", "living") === "생활 혜택과 제도",
    "육아휴직 글은 `기소`에 끌려가지 않는다"
  );
  assert(
    pick("비브리오패혈증 해산물 날것 주의, 9월 전북 3명 중 2명 사망", "living") === "생활 혜택과 제도",
    "건강 주의 글은 `사망`에 끌려가지 않는다"
  );

  // 국방·북한이 재판보다 먼저다.
  assert(
    pick("김정은 사망설 확산, 출처는 중국 반체제 인사의 X 주장", "incident") === "국방·외교와 북한",
    "김정은 사망설은 사건이 아니다"
  );

  // 동물·과학이 재판보다 먼저다.
  assert(
    pick("부산 온천천 야생 수달 온처니, 2021년에도 목격된 천연기념물", "incident") === "화제와 발견",
    "천연기념물 발견은 사건이 아니다"
  );
  assert(
    pick("부캉이 무태상어 아닌 흑상어, 3m 암컷 멸종위기종이었다", "living") === "화제와 발견",
    "상어 종 확인은 화제·발견이다"
  );

  // 재판이 정치보다 먼저다.
  assert(
    pick("대법원 김건희 추가 구속영장 발부 인멸·도망 우려, 매관매직 사건", "incident") === "사건·사고와 재판",
    "정치 인물이어도 용건이 영장이면 재판이다"
  );

  // 정치가 돈보다 먼저다.
  assert(
    pick("국민연금 성과급 300억 잔치? 308억은 가정에 따른 추산", null) === "정치와 국정",
    "국민연금 성과급은 국정 이야기다"
  );
  assert(
    pick("성과급 최소 30억 삼성전자 메모리 부부, 세후 자사주라는 변수", "living") === "돈과 부동산",
    "기업 성과급은 돈이다"
  );

  // 유출이 가장 먼저다 - 기업 이름이 붙어 돈·생활로 새기 쉽다.
  assert(
    pick("롯데 쿠폰발행사 기프티엘 해킹 개인정보 유출, 환불 계좌번호까지", "living") === "개인정보 유출과 보안",
    "`쿠폰`이 들어 있어도 유출이 이긴다"
  );
}

// ── 3. 넓은 생활 낱말은 맨 뒤라 다른 주제를 가로채지 않는다 ─────────
{
  assert(
    pick("경기도 버스 총파업 30일 임금협상 결렬, 23일 투표·29일 조정", "incident") === "정치와 국정",
    "파업 협상 자체는 정치다"
  );
  assert(
    pick("9월 16일 서울 버스 파업되면? 무료 셔틀·지하철 막차 총정리", null) === "생활 혜택과 제도",
    "같은 파업이라도 독자 행동 안내는 생활이다"
  );
  assert(pick("잠수교 차량 통행 영구 중단, 10월 26일부터 보행자 전용", "living") === "생활 혜택과 제도", "통행 변경 안내");
}

// ── 4. 규칙이 다 빗나가면 내부 category의 기본값 ───────────────────
{
  assert(matchTistoryCategoryRule("특별한 낱말이 하나도 없는 제목") === null, "안 걸리면 null");
  assert(pick("특별한 낱말이 없는 제목", "incident") === "사건·사고와 재판", "incident 기본값");
  assert(pick("특별한 낱말이 없는 제목", "community") === "화제와 발견", "community 기본값");
  assert(pick("특별한 낱말이 없는 제목", "parenting") === "생활 혜택과 제도", "parenting 기본값");
  assert(pick("특별한 낱말이 없는 제목", "person") === "인물과 스타 이슈", "person 기본값");
  // living은 화제와 발견이다 - 혜택·제도는 위 규칙이 낱말로 집어 간다.
  assert(pick("맥도날드 대형 버거 빅아치, 단품만으로 든든하지만 한입엔 버겁다", "living") === "화제와 발견", "living 기본값");
  assert(pick("낱말 없음", "모르는라벨") === TISTORY_FALLBACK_CATEGORY, "모르는 라벨은 폴백");
  assert(pick("낱말 없음", null) === TISTORY_FALLBACK_CATEGORY, "라벨 없으면 폴백");
}

// ── 5. 옛 호출 모양(문자열 하나)과 강제 스위치 ─────────────────────
{
  assert(tistoryCategoryName("incident", NO_ENV) === "사건·사고와 재판", "문자열 인자도 받는다");
  assert(tistoryCategoryName(null, NO_ENV) === TISTORY_FALLBACK_CATEGORY, "null도 받는다");
  assert(tistoryCategoryName(undefined, NO_ENV) === TISTORY_FALLBACK_CATEGORY, "undefined도 받는다");
  assert(
    tistoryCategoryName({ title: "로또 1등 3장", category: "living" }, { TISTORY_DEFAULT_CATEGORY: "임시 보관" }) === "임시 보관",
    "강제 스위치가 규칙을 이긴다"
  );
}

// ── 6. 제목이 없으면 키워드로 판정한다 ────────────────────────────
{
  assert(
    tistoryCategoryName({ title: null, keyword: "현대이지웰 개인정보 유출 사고", category: "living" }, NO_ENV) ===
      "개인정보 유출과 보안",
    "제목이 없으면 키워드를 본다"
  );
}

// ── 7. 실측 표본 — 카테고리마다 두 건씩 ───────────────────────────
{
  const SAMPLES: Array<[string, string | null, string]> = [
    ["지하철 3호선 원당역 동료 여성 흉기 휘두른 30대, 살인미수 혐의 체포", "incident", "사건·사고와 재판"],
    ["침 시술 중 환자 숨지게 한 한의사 벌금형, 2천만 원 선고", "incident", "사건·사고와 재판"],
    ["공수처 개편안, 대통령·국회의원 수사권 중수청 이전 논의", "incident", "정치와 국정"],
    ["박윤규 정보통신산업진흥원장 근무일 375일 중 326일 출장 국감 지적", "incident", "정치와 국정"],
    ["북한 지뢰 제거 작전에 영토 1㎜ 침범하면 즉시 강력대응", "living", "국방·외교와 북한"],
    ["국방부 예술체육요원 병역특례 감축·폐지 추진", "incident", "국방·외교와 북한"],
    ["아동수당 언제 받을까? 9세 미만으로 확대, 4월 최대 48만 원 지급", "living", "생활 혜택과 제도"],
    ["주정차 단속 과태료 12만원 스쿨존, 사진 두 장이면 부과", "living", "생활 혜택과 제도"],
    ["HLB 그룹주 시간외 강세, FDA 심사 2개월이냐 6개월이냐", "living", "돈과 부동산"],
    ["광교 자연앤센트레빌 지분적립형, 25%만 내고 20년에 걸쳐 완성", "living", "돈과 부동산"],
    ["미래에셋생명 개인정보 유출 사고, 해커가 조회한 파일 약 41개", "living", "개인정보 유출과 보안"],
    ["할리스 멤버십 개인정보 유출, 비밀번호·주소까지 35일간 노출", "living", "개인정보 유출과 보안"],
    ["백제금동대향로 중국 드라마 가금채 논란, 닮은 향로가 등장했다", "community", "화제와 발견"],
    ["국내 최초 번식 쌍둥이 레서판다 마루·마롱, 이른 아침에 만나요", "living", "화제와 발견"],
    ["헤이지니 노동 착취 의혹 해명, 연봉 25% 인상 vs 하루 16시간", "living", "인물과 스타 이슈"],
    ["쌍별 셰프 손종원, 신세계 임원 36명 중 유일한 전문임원", "living", "인물과 스타 이슈"],
  ];
  for (const [title, category, want] of SAMPLES) {
    const got = pick(title, category);
    assert(got === want, `표본: "${title.slice(0, 26)}" -> 기대 ${want} / 실제 ${got}`);
  }
}

console.log("✅ 카테고리 이름 8개와 기본값이 실제 카테고리와 일치");
console.log("✅ 규칙 순서: 유출 > 제도 > 국방 > 동물·과학 > 재판 > 정치 > 돈 > 인물 > 넓은 생활");
console.log("✅ 넓은 생활 낱말이 정치·재판을 가로채지 않는다");
console.log("✅ 규칙이 빗나가면 내부 category 기본값 (living = 화제와 발견)");
console.log("✅ 옛 문자열 호출과 TISTORY_DEFAULT_CATEGORY 스위치 유지");
console.log("✅ 제목이 없으면 키워드로 판정");
console.log("✅ 실측 표본 16건(카테고리마다 2건) 통과");
console.log("\n✅ 티스토리 카테고리 판정 테스트 완료");
