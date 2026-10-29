// 원고에서 금지된 표현 패턴 모음(단일 출처). 검수 경고(articleReviewChecks)와 저장 직전 자동 교정
// (enforceWritingRules)이 같은 패턴을 쓴다 - 규칙은 prompts/writing/core-rules.md.
// 전역(g) 정규식이라 .test() 호출 전에 lastIndex를 0으로 되돌려야 한다.

/**
 * 보도·매체에 소식의 출처를 돌리는 모든 표현. 2026-09-16부터 횟수 무관 - 1건만 있어도 경고.
 * 예외(의도적으로 안 잡음): 실제 인물·기관을 문장의 주어로 쓴 직접 인용("OOO는 ~라고
 * 밝혔습니다") - "보도/전해지다/매체" 단어 자체가 없으면 이 패턴에 안 걸린다.
 */
export const MEDIA_ATTRIBUTION_PATTERN =
  /라고\s*보도(?:됐|했|되었|하였)|것으로\s*보도(?:됐|했)|보도에\s*따르면|라고\s*전(?:해졌|했)|것으로\s*전(?:해졌|했)|라는\s*소식(?:입니다|이다)|매체(?:가|들이|마다)[^.!?\n]{0,20}(?:전했|보도)|보도마다/g;

/** 보도 경위(누가 언제·몇 곳이 보도했는지) 서술. facts-and-hedging.md §4-2. */
export const COVERAGE_NARRATIVE_PATTERN =
  /인용해\s*전(?:한|했)|취재진이\s*확보|함께\s*보도(?:했|됐)|보도로\s*확산|이어\s*[^.!?\n]{0,12}보도(?:했|됐)/g;

/**
 * 경위·한정·계산 서술(2026-10-29 사용자 피드백, core-rules.md §1-12 · facts-and-hedging.md §4-3).
 * "이게 틀린 정보가 아니다"를 증명하려는 문장 - 소식이 나온 경로("~가 나온 곳은 ~입니다"), 표현의 출처
 * ("~라는 말은 ~한 데서 나왔습니다"), 신뢰도 한정·부인("감정한 사람은 ~ 한 명이고, 공인 감정 결과는 아닙니다"),
 * 계산 과정 노출("~로 따지면 ~이니 약 N년"). 사실은 사건 문장("X가 Y했습니다")으로 쓰고 출처는 주어·부사구로
 * 한 번만 넣는다("~영상에서 나왔습니다"는 통과). 보수적으로 잡는다 - 아래 네 모양만이고, "방송이 아니라" 같은
 * 선제 정정은 범위가 넓어 문서(humanize.md §1-13)로만 다룬다. incident는 적용하지 않는다(한정 서술이 무죄추정의 일부).
 */
export const PROVENANCE_NARRATIVE_PATTERN =
  /(?:나온|알려진|퍼진|시작된)\s*곳은|(?:데|곳)에서\s*(?:나왔|비롯)|데서\s*(?:나왔|비롯)|한\s*명(?:뿐이|이고\s*[^.!?\n]{0,40}아닙니다|의\s*(?:의견|판단))|(?:의견|판단)일\s*뿐|(?:공인|공식)\s*[^.!?\n]{0,12}(?:는|은)\s*아닙니다|(?:으로|로)\s*(?:따지면|따져\s*보면|계산하면|셈하면)/g;

/**
 * 우리 취재·검증 과정의 확인/확정 여부를 원고 내용으로 서술하는 것. facts-and-hedging.md
 * 핵심 원칙 2번. ("공개되지 않았다"류는 09-30부터 별도 패턴 UNPUBLISHED_PATTERN이 잡는다.)
 */
export const VERIFICATION_STATUS_PATTERN =
  /확인되지\s*않았|확정되지\s*않았|확인되지\s*않고|확인해\s*주는[^.!?\n]{0,20}(?:없다|없습니다|여전히)/g;

/**
 * 부분 데이터 갭을 알리는 문장. facts-and-hedging.md §4-1.
 * 이 항목은 없다는 사실 자체를
 * 알리는 특정 동사 조합만 잡는다(오탐 축소 - 2026-09-15/16 실측 문구 기준). 대조 접속어
 * (별도로/따로/구체적으로)가 없는 단독 문장("~뿐 ~는 밝히지 않았다")도 2026-09-16부터 포함.
 */
export const PARTIAL_GAP_PATTERN =
  /(?:별도로|따로|구체적으로)\s*(?:나오지|제시되지|확인되지|언급되지)\s*않았|(?:밝히지|명시하지)\s*않았습니다/g;

/**
 * 기준 시점·확인 시점 표기(2026-09-30 핵심 원칙 3). "2026년 9월 기준입니다", "9월 18일 기준",
 * "18일자로 확인된", "기준으로 찾아본"처럼 조사·확인 시점을 짚는 표현. 날짜 뒤에 붙은 "기준"만
 * 잡으므로 "1인 기준", "만 12세 기준"은 안 걸린다.
 */
export const AS_OF_PATTERN =
  /(?:\d{4}년|\d{1,2}월|\d{1,2}일)(?:\s*\d{1,2}[월일])*\s*(?:시점\s*)?기준|\d{1,2}일자로\s*확인|기준으로\s*(?:찾아본|확인한|정리한)/g;

/** 공개·확정되지 않은 값을 서술하는 문장(2026-09-30 핵심 원칙 4) - 없는 값은 쓰지 않는다. */
export const UNPUBLISHED_PATTERN =
  /(?:공개|발표|결정|공지)되지\s*않았|(?:일정|시점|금액|요금|가격|날짜)[^.!?\n]{0,8}미정/g;

/**
 * style/voice.md §2가 금지한 구어 어미. 어미 뒤에 문장부호·공백·줄끝이 와야 종결로 본다
 * ("고요한 밤"의 "고요"는 뒤에 "한"이 붙어 안 걸린다).
 */
export const BANNED_COLLOQUIAL_ENDINGS =
  /(더라고요|거든요|잖아요|답니다|네요|고요)(?=[.!?)"'”’\s]|$)/gm;

/** person(인물 백과)에서만 허용하는 구어 어미(2026-10-15 사용자 결정, voice.md §2·style/person.md). 원고당 합계 3곳까지. */
export const PERSON_ALLOWED_COLLOQUIAL_ENDINGS: ReadonlySet<string> = new Set(["거든요", "고요"]);
export const PERSON_ALLOWED_COLLOQUIAL_MAX = 3;

/**
 * 카테고리별 허용 구어 어미(2026-10-16 사용자 확정, voice.md §2).
 * - 전 카테고리: `~네요` 허용(발행본 실측 - 사용자가 매번 다시 넣던 어미. `~는데요`는 정규식 밖이라 문서로만 다룬다)
 * - person: 추가로 `거든요`·`고요`
 * - incident: 허용 없음(사건·사고는 구어 완화 예외 - style/incident.md)
 * 상한은 허용 집합 전체 합산 3곳(PERSON_ALLOWED_COLLOQUIAL_MAX 재사용).
 */
export function allowedColloquialEndingsFor(category?: string | null): ReadonlySet<string> {
  if (category === "incident") return new Set();
  if (category === "person") return new Set(["네요", ...PERSON_ALLOWED_COLLOQUIAL_ENDINGS]);
  return new Set(["네요"]);
}

/**
 * 직접 인용(큰따옴표 "…" · “…” · 작은따옴표 ‘…’ 안)의 글자를 같은 길이의 "□"로 덮는다.
 * 인용은 원문 그대로가 원칙이라 어미 검사·교정 대상에서 뺀다(2026-10-15, 전 카테고리 공통).
 * 줄 단위로만 짝을 찾으며(줄바꿈을 넘는 따옴표는 짝으로 보지 않는다), 길이를 유지하므로
 * 마스크한 문자열의 위치를 원문 위치로 그대로 쓸 수 있다.
 */
export function maskQuotedSpans(text: string): string {
  return text.replace(/"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’/g, (m) => "□".repeat(m.length));
}

/**
 * 구어 어미 위반 목록(인용 제외). 카테고리별 허용 어미(allowedColloquialEndingsFor)는 위반이 아니다.
 * 입력은 이미 maskQuotedSpans를 거친 문자열이어야 하는 경우를 위해 mask 여부를 호출자가 정한다.
 */
export function findColloquialEndings(text: string, category?: string | null): string[] {
  const allowed = allowedColloquialEndingsFor(category);
  const found = [...maskQuotedSpans(text).matchAll(BANNED_COLLOQUIAL_ENDINGS)].map((m) => m[1]);
  return found.filter((e) => !allowed.has(e));
}

/** 허용 구어 어미가 인용 밖에서 쓰인 횟수(카테고리별 집합 합산). 상한(3곳) 집행용. */
export function countAllowedEndings(text: string, category?: string | null): number {
  const allowed = allowedColloquialEndingsFor(category);
  return [...maskQuotedSpans(text).matchAll(BANNED_COLLOQUIAL_ENDINGS)].filter((m) => allowed.has(m[1])).length;
}

/** @deprecated person 전용 구버전 - countAllowedEndings(text, "person")을 쓴다. */
export function countPersonAllowedEndings(text: string): number {
  return countAllowedEndings(text, "person");
}

/**
 * "○○에 따르면/에 의하면" 출처 표기(2026-09-30). 기관을 주어로 직접 쓰거나 사실을 단정한다 - 원문을 안 열고 뉴스가 전한
 * 기관 이름을 앞세우면 확인 안 된 출처 표기가 된다. ("보도에 따르면"은 MEDIA_ATTRIBUTION_PATTERN이 따로 잡는다.)
 */
export const ACCORDING_TO_PATTERN = /[가-힣A-Za-z0-9]+\s*(?:에\s*따르면|에\s*의하면)/g;

/**
 * 올해 날짜에 붙은 연도 표기(2026-10-02 사용자 결정). "2026년 10월 1일에 SNS에 퍼졌습니다"에서 연도만 뺀다.
 *
 * **다른 연도는 정보다** - 올해 연도 바로 뒤에 월이 오는 경우만 걸린다("1990년 공휴일에서 빠졌습니다"는 통과).
 * 연도만 쓴 표기("2026년 공휴일은 70일")도 날짜가 아니라 그 해의 값이라 대상이 아니다.
 */
export function currentYearInDatePattern(year: number): RegExp {
  return new RegExp(`${year}년\\s*(?=\\d{1,2}월)`, "g");
}

/** 파이프라인은 한국 시간으로 돈다 - "올해"도 KST 기준이다. */
export function kstYear(now: Date = new Date()): number {
  return Number(now.toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" }).slice(0, 4));
}

/** 댓글·의견 유도 마무리(2026-09-30 금지). "여러분은 어떻게 생각하시나요?", "댓글로 남겨주세요". */
export const COMMENT_INVITE_PATTERN =
  /여러분(?:은|도|의)?[^.!?\n]{0,30}(?:생각|의견|경험)[^.!?\n]{0,20}\?|댓글(?:로|에)?\s*(?:남겨|공유|알려|달아)|의견(?:을)?\s*(?:남겨|들려)\s*주/g;

// ---------- kscene(사용설명서) 로컬 화자 (2026-10-30) ----------
//
// 로컬 정체성 개정으로 kscene의 1인칭이 열렸다(style/kscene.md 「화자」): 관행 서술("한국 사람들은 보통")과
// 화자의 일반 습관("저도 이렇게 합니다") 2문장까지. **그래서 지어내기 위험이 1인칭 자체가 아니라 두 모양으로
// 좁혀졌다** - (1) 위치가 드러나는 "저희 집·저희 동네" (2) 날짜·장소가 든 일화("지난주 강남에서").
// 둘 다 research §12로 뒷받침할 수 없는 사적 사실이라, kscene에서만 검수 경고로 잡는다.
//
// 보수적으로 잡는다: 허용된 "저도/저는 ~합니다"는 건드리지 않고, 아래 두 패턴만 본다.

/** "저희 집/저희 동네/저희 아파트…" - 거주지 정보. kscene 화자 절이 명시적으로 금지한 표현. */
export const KSCENE_PRIVATE_PLACE_PATTERN =
  /저희\s*(?:집|동네|아파트|단지|가족|동|구|지역|회사|학교|차)/g;

/**
 * 날짜·때 + 장소가 든 1인칭 일화. kscene.md 「화자」가 든 금지 예가 바로 "지난주 강남에서 택시를 탔는데"다.
 *
 * 세 조건 중 **때 + 장소는 필수**이고, 세 번째로 아래 둘 중 하나가 있어야 한다:
 *  (A) 명시적 1인칭(저/제가) - "지난주 강남에서 저는 택시를 탔습니다"
 *  (B) 화자 자신의 체험을 뜻하는 좁은 동사 - `~아/어/해 봤`(해 봤다 = 해 본 사람의 말), `탔`, `들렀`, `시켰`.
 *      한국어는 주어를 생략해서 (A)만 요구하면 규격의 금지 예("택시를 탔는데")가 통과한다 - 실측으로 확인했다.
 *
 * 오탐을 줄이려고 (B)의 동사는 3인칭 서술에 잘 안 쓰이는 것만 넣었다. "지난달 서울에서 요금이 올랐습니다"
 * (올랐 - 목록 밖)는 통과하고, "지난해 부산에서 열린 행사"(열린 - 목록 밖)도 통과한다. 자동 교정이 아니라
 * **검수 경고**라서 넓히기보다 좁게 두고 규격 문서로 보완한다.
 */
export const KSCENE_DATED_ANECDOTE_PATTERN =
  /(?=[^.!?\n]*(?:지난\s*(?:주|달|해|주말|금요일|토요일|일요일|월요일|화요일|수요일|목요일)|어제|그제|엊그제|며칠\s*전|얼마\s*전|작년|재작년|지난번))(?=[^.!?\n]*[가-힣A-Za-z0-9]+에서)(?=[^.!?\n]*(?:(?:^|[\s(])(?:저|제)(?:는|가|도|를|의)?\s|[아어해여]\s*봤|탔|들렀|시켰))[^.!?\n]+/gm;

/** kscene에서만 경고하는 화자 규칙. category가 kscene이 아니면 빈 배열을 돌려준다. */
export function findKsceneSpeakerViolations(text: string, category?: string | null): string[] {
  if (category !== "kscene") return [];
  const masked = maskQuotedSpans(text);
  const found: string[] = [];
  for (const pattern of [KSCENE_PRIVATE_PLACE_PATTERN, KSCENE_DATED_ANECDOTE_PATTERN]) {
    pattern.lastIndex = 0;
    for (const m of masked.matchAll(pattern)) found.push(m[0].trim());
  }
  return found;
}
