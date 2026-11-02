// 인물 소스팩의 "작품별 등장인물"(2026-11-02). 인물 문서만으로는 캐릭터 네 항목 중 **역할·관계**가 빈다.
//
// 실측(서현진, 2026-11-02): `namu.wiki/w/서현진`은 배역명과 비중·시청률을 다 준다 - 출연 목록 표의
// `배역`·`비고`·`시청률` 컬럼이다. 그런데 **역할(극 중 직업·신분·목표)과 관계(상대 배역)는 없다** -
// 배역명 여섯 개가 전부 인포박스 목록에 한 번씩만 나오고 설명이 없다. 그 설명은 인물 문서가 아니라
// **작품 문서의 `등장인물`**에 있다(`namu.wiki/w/또! 오해영/등장인물`).
//
// 클라우드 러너는 그 문서를 직접 열 수 없다(namu.wiki 403 - personSourcePack.ts 머리글). 그래서 인물
// 문서와 같은 방식으로 **맥이 받아 소스팩에 넣는다.** 작품은 인물 문서가 이미 알려 준다 - 출연 목록 표를
// 읽어 대표작 후보를 고르고(시청률·주연 표기·`개요`/`특징` 언급), 받아 온 등장인물 문서에서 **그 사람 배역
// 주변만** 잘라 담는다(문서 전체는 수십 KB이고 나머지 배역은 이 원고의 재료가 아니다).
//
// 파싱이 틀려도 안전하다 - 없는 제목은 404로 떨어지고 그 작품만 빠진다(errors에 남는다).

/** 작품당 등장인물 발췌 상한(UTF-8 바이트). 배역 설명 한 덩어리면 충분하다. */
export const WORK_CAST_MAX_BYTES = 4 * 1024;
/** 등장인물 수집 작품 수 상한. 규격이 요구하는 대표작은 6~8개다(person-researcher.md §2-6-1). */
export const WORK_CAST_MAX_WORKS = 8;
/** 배역명 앞뒤로 몇 자를 떠낼지. 나무위키 등장인물 항목 하나가 대개 이 안에 든다. */
const EXCERPT_BEFORE = 200;
const EXCERPT_AFTER = 1_200;
/** 배역 전용 문서에서 절마다 떠낼 분량과 발췌 총량(자). 바이트 상한(4KB)에 맞춘 값이다. */
const ROLE_DOC_SECTION_CHARS = 500;
const ROLE_DOC_TOTAL_CHARS = 1_400;
/** 배역 전용 문서에서 쓸 절. 역할은 `개요`·`인물 배경`, 관계는 `인간관계`에 있다. */
const ROLE_DOC_SECTION = /^## \d+(?:\.\d+)*\.\s*(개요|소개|인물 ?배경|인간관계|관계)/;

/** 출연 목록 표의 방송사·플랫폼 칸. 작품명 자리를 가려내려면 이 칸을 먼저 걷어내야 한다. */
const CHANNEL_CELLS = new Set([
  "MBC", "KBS", "KBS 1TV", "KBS 2TV", "SBS", "tvN", "JTBC", "OCN", "ENA", "MBN", "TV조선", "채널A",
  "Mnet", "넷플릭스", "Netflix", "티빙", "TVING", "웨이브", "wavve", "쿠팡플레이", "디즈니+", "왓챠",
  "카카오TV", "네이버TV", "유튜브", "SBS Plus", "KBS Joy", "EBS", "지니 TV",
]);

/** 비고 칸에 오는 비중 표기. */
const WEIGHT_CELLS = new Set(["주연", "조연", "특별출연", "우정출연", "단막", "주인공", "조연 출연"]);

const YEAR_CELL = /^\d{4}년/;
const RATING_CELL = /^(\d+(?:\.\d+)?)\s*%$/;

export type WorkPick = {
  /** 작품명. 나무위키 문서 제목으로 그대로 쓴다. */
  work: string;
  /** 그 작품에서 이 사람이 맡은 배역명. 괄호 수식("오해영(흙)")은 떼어 둔다. */
  role: string;
  /** 비고 칸의 비중 표기. 없으면 빈 문자열. */
  weight: string;
  /** 시청률(%). 없으면 undefined - 비공개 플랫폼이거나 표에 칸이 없다. */
  rating?: number;
  /** `개요`·`특징` 문단이 이름을 부른 작품인가. 가장 강한 대표작 신호다(§2-6-1 ①). */
  featured: boolean;
};

/**
 * "오해영(흙)" -> "오해영". 괄호 수식을 떼고, 한 칸에 배역이 여럿이면("하인주 송연우" - 신들의 만찬
 * 실측) 앞의 것만 쓴다. 쉼표·슬래시·공백 전부 구분자로 본다 - 배역명에 공백이 든 경우는 드물다.
 */
function bareRole(role: string): string {
  return role.replace(/[(（].*$/, "").split(/[\s,/·]/)[0].trim();
}

/**
 * 인물 문서의 출연 목록 표에서 작품·배역 쌍을 읽는다.
 *
 * 행마다 칸 수가 다르다 - 방송사가 앞 행과 같으면 생략되고 비고·시청률도 비어 있을 수 있다
 * (`2017년 | 사랑의 온도 | 이현수 | 11.2%`). 그래서 칸 위치를 믿지 않고 **생김새로 가린다**:
 * 연도·방송사·시청률·비중을 걷어내고 남은 첫 칸을 작품, 그 다음 칸을 배역으로 본다.
 */
export function parseFilmographyRows(namuwiki: string): WorkPick[] {
  const picks: WorkPick[] = [];
  const seen = new Set<string>();
  for (const line of filmographySections(namuwiki).split("\n")) {
    if (!line.includes(" | ")) continue;
    const cells = line.split("|").map((cell) => cell.trim()).filter(Boolean);
    if (cells.length < 2) continue;

    let rating: number | undefined;
    let weight = "";
    const rest: string[] = [];
    for (const cell of cells) {
      if (YEAR_CELL.test(cell) || CHANNEL_CELLS.has(cell)) continue;
      const asRating = RATING_CELL.exec(cell);
      if (asRating) {
        rating = Number(asRating[1]);
        continue;
      }
      if (WEIGHT_CELLS.has(cell)) {
        weight = cell;
        continue;
      }
      rest.push(cell);
    }
    if (rest.length < 2) continue;
    const work = rest[0];
    const role = bareRole(rest[1]);
    // 표 머리글(`연도 | 방송사 | 방송명 | 배역`)과 인포박스 나열 줄을 거른다.
    if (/^(연도|방송사|방송명|제목|배역|비고|시청률|구분|작품)$/.test(work)) continue;
    if (!role || role.length > 12 || work.length > 30) continue;
    if (/\d{4}/.test(role)) continue; // "오해영 2016"처럼 인포박스 한 줄이 통째로 들어온 경우
    const key = `${work}/${role}`;
    if (seen.has(key)) continue;
    seen.add(key);
    picks.push({ work, role, weight, ...(rating === undefined ? {} : { rating }), featured: false });
  }
  return picks;
}

/**
 * 출연 목록 절만 남긴다. 전체를 훑으면 **수상 경력 표가 작품으로 새어 들어온다**
 * (`2017년 | 제53회 백상예술대상 | TV부문 여자 최우수연기상` → 작품 "제53회 백상예술대상", 2026-11-02 실측).
 * 인포박스 나열 줄도 여기서 함께 빠진다.
 */
function filmographySections(namuwiki: string): string {
  // `## `로만 나눈다 - `### 5.1. 영화`는 `## 5. 출연 목록` 안에 남아 있어야 한다.
  const sections = namuwiki.split(/^(?=## )/m).filter((section) => /^## \d+(?:\.\d+)*\.\s*출연/.test(section));
  return sections.join("\n");
}

/** `## 1. 개요`·`## 2. 특징` 본문. 여기 이름이 나온 작품이 대표작이다(§2-6-1 ①). */
function featuredText(namuwiki: string): string {
  return namuwiki
    .split(/^(?=## )/m)
    .filter((section) => /^## \d+\.\s*(개요|특징)/.test(section))
    .join("\n");
}

/**
 * 등장인물을 받아 올 작품을 고른다. 순서는 규격 §2-6-1과 같다 - `개요`·`특징` 언급이 1순위,
 * 그다음 시청률, 주연 표기가 동점을 가른다. 특별출연은 언급이 없으면 뺀다(대표작이 아니다).
 */
export function pickWorksForCast(namuwiki: string, limit: number = WORK_CAST_MAX_WORKS): WorkPick[] {
  const featured = featuredText(namuwiki);
  const rows = parseFilmographyRows(namuwiki).map((pick) => ({
    ...pick,
    featured: featured.includes(pick.work),
  }));
  const score = (pick: WorkPick) =>
    (pick.featured ? 1_000 : 0) + (pick.rating ?? 0) * 10 + (pick.weight === "주연" || pick.weight === "주인공" ? 5 : 0);
  return rows
    .filter((pick) => pick.featured || !/특별출연|우정출연/.test(pick.weight))
    .sort((a, b) => score(b) - score(a))
    .slice(0, limit);
}

export type WorkCast = {
  work: string;
  /** 이 사람의 배역명. 발췌를 어디서 떠냈는지 가리킨다. */
  role: string;
  /** 실제로 읽은 나무위키 문서 제목(`또! 오해영/등장인물` 또는 `또! 오해영`). */
  namuwikiTitle: string;
  /** 배역 주변 발췌. 역할·관계가 여기 적혀 있다. */
  excerpt: string;
  /**
   * 발췌를 어떻게 집었는가. `heading`은 그 배역 소제목을 찾은 것이라 믿을 수 있고, `mention`은 본문
   * 언급만 잡은 것이어서 **옆 인물 설명이 섞여 있을 수 있다**(`오해영 父` 같은 소제목 때문에 밀린 경우).
   */
  matched?: RoleMatch;
};

/** 등장인물 문서가 배역 설명을 따로 둔 경우의 안내 문구. 대작은 배역마다 문서가 하나다. */
const SEE_ALSO = /자세한 내용은\s*(.{1,40}?)\s*문서를 참[고조]/g;

/**
 * 발췌가 "자세한 내용은 <배역> 문서를 참고하십시오"뿐이면 그 문서를 따라간다(2026-11-02 실측 -
 * 낭만닥터 김사부·블랙독처럼 주요 배역이 각자 문서를 가진 작품이 그렇다). 같은 이름 다른 문서를
 * 집지 않도록 **작품명이 그 문서에 나오는지 확인**하고, 아니면 원래 발췌를 쓴다.
 */
export function pointedRoleDocument(excerpt: string, role: string): string | null {
  // 발췌에는 옆 배역의 안내 문구도 섞여 있다(김사부·강동주…). **그 배역을 가리키는 것**만 따라간다.
  for (const match of excerpt.matchAll(SEE_ALSO)) {
    const title = match[1].trim();
    if (title.includes(role)) return title;
  }
  return null;
}

/**
 * 배역 전용 문서는 ±창으로 떠내면 안 된다 - 맨 위가 둘러보기 틀(OST·회차 목록)이고 **관계는
 * `인간관계` 절에 있어 창 밖으로 밀린다**(2026-11-02 실측, 윤서정 문서). 절을 골라 담는다.
 */
export function roleDocumentExcerpt(text: string): string {
  // `## `로만 나눈다 - `### 4.1. 김사부`(관계 상대별 항목)가 `## 4. 인간관계` 안에 남아 있어야 한다.
  const sections = text.split(/^(?=## )/m).filter((section) => ROLE_DOC_SECTION.test(section));
  if (sections.length === 0) return "";
  const picked = sections.map((section) => {
    const head = section.slice(0, ROLE_DOC_SECTION_CHARS).trim();
    return section.length > ROLE_DOC_SECTION_CHARS ? `${head}…` : head;
  });
  return picked.join("\n\n").slice(0, ROLE_DOC_TOTAL_CHARS).trim();
}

export type FetchWorkCastDeps = {
  /** 나무위키 문서 제목 -> 본문 텍스트. 없으면 던진다(404 포함). */
  readNamuwiki: (title: string) => Promise<string>;
  log?: (message: string) => void;
};

/**
 * 배역 설명이 시작되는 자리를 찾는다.
 *
 * **첫 번째 등장을 쓰면 안 된다**(2026-11-02 실측). 등장인물 문서 맨 위에는 배역 전원을 나열한
 * 둘러보기 틀과 목차가 있어서 `윤서정`·`이현수`의 첫 등장은 거기다 - 그 자리를 떠내면 OST 목록과
 * 목차만 담긴다. 그래서 **배역명이 소제목인 줄**(`### 2.1. 이현수`)을 먼저 찾고, 없으면 틀·목차
 * 구간을 지난 뒤의 등장을 쓴다.
 */
/** 발췌를 어떻게 집었는가. `heading`은 그 배역 소제목을 찾은 것이고 `mention`은 본문 언급만 잡은 것이다. */
export type RoleMatch = "heading" | "mention" | "none";

function roleStartIndex(text: string, role: string): { at: number; matched: RoleMatch } {
  const escaped = role.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // 배역명과 **정확히 같은** 소제목이 1순위다. `### 3.1. 오해영 父`처럼 이름이 들어가기만 한 소제목을
  // 먼저 집으면 다른 인물(부모·동명이인) 설명을 떠낸다(2026-11-02 또! 오해영 실측).
  const exactAt = text.search(new RegExp(`^#{2,4} (?:\\d+(?:\\.\\d+)*\\.\\s*)?${escaped}\\s*$`, "m"));
  if (exactAt >= 0) return { at: exactAt, matched: "heading" };
  const headingAt = text.search(new RegExp(`^#{2,4} (?:\\d+(?:\\.\\d+)*\\.\\s*)?${escaped}[(（]`, "m"));
  if (headingAt >= 0) return { at: headingAt, matched: "heading" };
  let at = text.indexOf(role);
  while (at >= 0 && at < NAVBOX_REGION) {
    const next = text.indexOf(role, at + role.length);
    if (next < 0) break;
    at = next;
  }
  return { at, matched: at >= 0 ? "mention" : "none" };
}

/** 문서 앞머리의 둘러보기 틀·목차 구간. 이 안의 배역명 등장은 설명이 아니다. */
const NAVBOX_REGION = 1_200;

/**
 * 본문에서 배역 설명 주변만 떠낸다. 배역명을 못 찾으면(이름 표기가 다르거나 문서가 요약형이면)
 * 앞머리를 쓴다 - 등장인물 문서 앞머리는 주요 인물이라 빈손보다 낫다.
 */
export function findRoleExcerpt(text: string, role: string): { excerpt: string; matched: RoleMatch } {
  if (!text) return { excerpt: "", matched: "none" };
  const { at, matched } = roleStartIndex(text, role);
  const from = at < 0 ? 0 : Math.max(0, at - EXCERPT_BEFORE);
  const slice = text.slice(from, from + EXCERPT_BEFORE + EXCERPT_AFTER);
  const head = at < 0 ? "" : from > 0 ? "…" : "";
  return { excerpt: `${head}${slice.trim()}`, matched };
}

/** 발췌만 필요할 때. 판정(`matched`)이 필요하면 findRoleExcerpt를 쓴다. */
export function excerptAroundRole(text: string, role: string): string {
  return findRoleExcerpt(text, role).excerpt;
}

/**
 * 고른 작품들의 등장인물 발췌를 모은다. 어떤 실패도 던지지 않는다 - 그 작품만 빠지고 사유는
 * errors에 담긴다(소스팩 전체는 비치명 원칙).
 */
export async function fetchWorkCasts(
  works: ReadonlyArray<WorkPick>,
  deps: FetchWorkCastDeps
): Promise<{ casts: WorkCast[]; errors: string[] }> {
  const casts: WorkCast[] = [];
  const errors: string[] = [];
  const log = deps.log ?? (() => {});
  for (const pick of works) {
    // 등장인물이 분리 문서인 작품이 많다. 없으면 작품 문서 본문에서 찾는다.
    // `뷰티 인사이드/등장인물`은 **영화** 문서다(2026-11-02 실측 - 서현진이 나온 건 JTBC 드라마다).
    // 그래서 괄호 붙은 제목까지 본다. 배역명이 없는 문서는 아래에서 걸러진다.
    const titles = [`${pick.work}/등장인물`, pick.work, `${pick.work}(드라마)/등장인물`, `${pick.work}(드라마)`];
    let got = false;
    for (const title of titles) {
      try {
        const text = await deps.readNamuwiki(title);
        // **배역명이 없는 문서는 이 사람 작품이 아니다**(동명 작품·다른 매체). 앞머리를 담지 않는다.
        if (!text.includes(pick.role)) continue;
        const found = findRoleExcerpt(text, pick.role);
        let excerpt = found.excerpt;
        let matched = found.matched;
        if (!excerpt) continue;
        let readTitle = title;
        const pointed = pointedRoleDocument(excerpt, pick.role);
        if (pointed) {
          try {
            const body = await deps.readNamuwiki(pointed);
            // 동명 문서 방지 - 그 작품을 다루는 문서여야 한다.
            const fromDoc = roleDocumentExcerpt(body) || excerptAroundRole(body, pick.role);
            if (body.includes(pick.work) && fromDoc) {
              excerpt = fromDoc;
              readTitle = pointed;
              matched = "heading"; // 배역 전용 문서 자체가 그 배역을 가리킨다.
            }
          } catch {
            // 배역 문서가 없으면 등장인물 문서 발췌를 그대로 쓴다.
          }
        }
        casts.push({ work: pick.work, role: pick.role, namuwikiTitle: readTitle, excerpt, matched });
        log(`· 등장인물 "${readTitle}" → ${pick.role} ${matched === "heading" ? "항목" : "언급"} ${excerpt.length.toLocaleString()}자`);
        got = true;
        break;
      } catch {
        // 그 제목이 없으면 다음 후보로 넘어간다.
      }
    }
    if (!got) errors.push(`workCast: "${pick.work}" 등장인물 못 받음(배역 ${pick.role})`);
  }
  return { casts, errors };
}
