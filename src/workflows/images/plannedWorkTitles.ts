// 기획 단계가 이미 알아낸 **작품명**을 키노라이츠 수집기에 넘긴다(2026-11-25).
//
// 무엇이 고장이었나(2026-11-17 실측): 수집기는 job 키워드에서 작품명을 **추측한다**
// (`workTitleCandidates`). 2026-11-09 개정은 "모든 연속 구간을 후보로 삼는다"고 했지만, 상한 6칸
// 배분이 늘 「키워드 전체 + 1단어 3개(첫·끝·둘째) + 2단어 2개(맨앞·맨끝)」로 고정돼 **가운데 구간에
// 닿지 못했다**. 그래서 11/10~11/17 작품 원고 7건 중 작품명이 맨 앞인 3건은 전부 스틸이 붙고
// 맨 앞이 아닌 4건은 전부 0장이었다(유스·너의 그라운드·하트비트·완벽한 타인2). 밀린 거리는 한두 칸이다 -
// `완벽한 타인2`는 2단어 후보 중 3번째, `하트비트`는 1단어 후보 중 5번째였다.
//
// 그런데 **추측할 필요가 없다.** 이미지 기획(`planImageSlots`)은 원고를 읽고 `protagonist`(원고의
// 주인공 - 사람 또는 작품)와 `summary`(한 줄 요약)를 만들어 `job.metadata.imagePlan`에 남긴다.
// 안 붙은 4건 전부 여기에 작품명이 적혀 있었다(DB 실측):
//
//   유스          protagonist `HBO 〈Youth(유스)〉 — 알렉스 역 샤론 호건`  summary `HBO 코미디 〈유스〉의 …`
//   너의 그라운드  protagonist `너의 그라운드 (한효주·공명)`              summary `… '너의 그라운드' 첫 대본 리딩 …`
//   하트비트      protagonist `남주혁(그리고 한소희)`                     summary `… 드라마 <하트비트> 캐스팅 소식 …`
//   완벽한 타인2   protagonist `전지현`                                   summary `전지현이 '완벽한 타인2' 주연을 …`
//
// **그래서 추측 대신 받는다.** 받은 작품명은 후보 맨 앞에 서고, 추측 후보는 상한(6) 안에서 그만큼
// 줄어든다 - Serper 호출 수는 고치기 전 이하다.
//
// ## 왜 summary의 인용부호가 protagonist보다 먼저인가
//
// `protagonist`는 "사람 또는 작품"이라서 **사람일 때가 있다**(하트비트 = `남주혁(그리고 한소희)`).
// 사람 이름을 작품명 후보로 넣으면 호출을 버리는 데 그치지 않고 **「수지」 사고**가 재발한다 - 인물과
// 같은 제목의 작품이 검증을 통과해 다른 배우의 스틸이 발행됐던 그 자리다(2026-11-19). 반면 인용부호
// (`'…'` `〈…〉` `『…』` …)는 기획이 **작품명이라고 표시한** 자리다. 그래서 ① 인용부호 안의 말을 먼저
// 쓰고 ② 인용부호가 없는 protagonist는 키워드의 인물명 후보와 겹치면 버린다.

import { personNameCandidates } from "../research/personNameFromKeyword.js";
import { cleanKeyword, normalize } from "./searchKinolightsStills.js";

/**
 * 인용부호로 감싼 말. `'…'` `‘…’` `「…」` `『…』` `<…>` `〈…〉` `《…》` `“…”` `"…"`.
 *
 * `〈〉`(U+3008/3009)와 `『』`(U+300E/300F)는 2026-11-25에 넣었다 - 기획이 실제로 쓰는 괄호인데
 * 빠져 있었다(`〈유스〉`·`『재혼 황후』`가 작품명으로 안 잡혔다).
 */
export const QUOTED =
  /'([^']{2,40})'|‘([^’]{2,40})’|「([^」]{2,40})」|『([^』]{2,40})』|<([^<>]{2,40})>|〈([^〉]{2,40})〉|《([^》]{2,40})》|“([^”]{2,40})”|"([^"]{2,40})"/g;

/** 인용부호 안의 말을 나온 순서대로. */
export function quotedTitles(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(QUOTED)) {
    const value = m.slice(1).find(Boolean)?.trim();
    if (value) out.push(value);
  }
  return out;
}

/** 한 원고에서 수집기에 넘길 작품명 수 상한. 넘긴 만큼 추측 후보가 줄어든다(호출 수 불변). */
export const MAX_PLANNED_TITLES = 3;

/** ` — 알렉스 역 샤론 호건` 같은 꼬리를 뗀다. 줄표 앞까지가 제목이다. */
function cutAtDash(text: string): string {
  return text.split(/\s[—–-]\s/)[0].trim();
}

/** 끝에 붙은 괄호 주석을 뗀다. `너의 그라운드 (한효주·공명)` -> `너의 그라운드`. */
function stripTrailingParenthetical(text: string): string {
  return text.replace(/\s*[(（][^)）]*[)）]\s*$/, "").trim();
}

/**
 * 인용부호 **안의** `A(B)`는 "원제(한국어 제목)"다 - 둘 다 후보로 쓴다(`Youth(유스)` -> `Youth`, `유스`).
 * 인용부호 **밖의** 괄호는 플랫폼·출연진 주석이라(`문무(KBS2 대하드라마)`) 바깥만 쓴다.
 */
function expandQuoted(title: string): string[] {
  const m = title.match(/^(.{2,})[(（](.{2,})[)）]$/);
  if (!m) return [title];
  return [m[1].trim(), m[2].trim()].filter((t) => t.length >= 2);
}

/**
 * 부제가 붙은 제목은 **부제 없는 머리도** 후보로 둔다(`흑백 가수: 보컬 계급 전쟁` -> `흑백 가수`).
 * 키노라이츠가 어느 쪽으로 등록해 뒀는지는 알 수 없고, 전체 제목이 먼저 가므로 틀릴 위험이 없다.
 */
function subtitleHead(title: string): string | null {
  const head = title.split(/\s*[:：]\s*/)[0].trim();
  return head.length >= 2 && head !== title ? head : null;
}

/**
 * 통째로든 조각으로든 **사람 이름뿐인가.** `남주혁` · `강동원·김고은` 둘 다 참이다.
 * (`너의 그라운드`는 조각이 하나이고 인물명이 아니라 거짓이다.)
 */
function isAllPeople(title: string, people: ReadonlySet<string>): boolean {
  if (people.has(normalize(title))) return true;
  const parts = title
    .split(/[·,&・]|\s+(?:와|과)\s+/)
    .map((t) => normalize(t))
    .filter((t) => t.length >= 2);
  return parts.length >= 2 && parts.every((t) => people.has(t));
}

export type PlannedTitleSource = {
  summary?: string | null;
  protagonist?: string | null;
};

/**
 * 기획에서 작품명 후보를 뽑는다. 순서가 곧 수집기의 시도 순서다.
 *
 * `keyword`는 **인물명을 가려내는 데만** 쓴다 - 여기서 또 키워드를 추측하지 않는다(그 일은 수집기의
 * `workTitleCandidates`가 폴백으로 계속 한다).
 */
export function plannedWorkTitlesFrom(plan: PlannedTitleSource | null | undefined, keyword: string): string[] {
  if (!plan) return [];

  const people = new Set(personNameCandidates(keyword).map(normalize));
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string, allowPerson: boolean): void => {
    const title = raw.trim();
    const key = normalize(title);
    if (key.length < 2 || seen.has(key)) return;
    // 인용부호가 없는 protagonist가 키워드의 인물명이면 버린다(「수지」 사고 계열).
    // `강동원·김고은`처럼 **여럿을 가운뎃점으로 이어 둔 것도** 사람이다 - 조각이 모두 인물명이면 버린다.
    if (!allowPerson && isAllPeople(title, people)) return;
    seen.add(key);
    out.push(title);
    const head = subtitleHead(title);
    if (head) add(head, allowPerson);
    // 기획은 `영화 폭설`처럼 장르·플랫폼을 붙여 적기도 한다. 추측 후보와 같은 규칙으로 걷어낸 꼴도 둔다.
    const bare = cleanKeyword(title);
    if (bare !== title) add(bare, allowPerson);
  };

  // ① 기획이 인용부호로 "작품명"이라고 표시한 말. summary -> protagonist 순.
  for (const source of [plan.summary ?? "", plan.protagonist ?? ""]) {
    for (const quoted of quotedTitles(source)) {
      for (const variant of expandQuoted(quoted)) add(variant, true);
    }
  }
  // ② protagonist에 인용부호가 **없을 때만** 그 머리를 쓴다 - 인물명이면 버린다.
  //    (있으면 ①이 이미 제목만 정확히 떠 왔다. 여기서 `HBO 〈Youth(유스)〉`를 또 넣으면 호출만 버린다.)
  const protagonist = plan.protagonist ?? "";
  if (quotedTitles(protagonist).length === 0) {
    const bare = stripTrailingParenthetical(cutAtDash(protagonist));
    if (bare) add(bare, false);
  }

  return out.slice(0, MAX_PLANNED_TITLES);
}
