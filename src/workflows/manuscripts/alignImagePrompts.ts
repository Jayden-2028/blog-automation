// 배리에이션이 문단을 재배열해도 이미지 검색어가 제 마커를 따라가게 맞춘다.
//
// 왜 필요한가(2026-09-21 실측 - 지창욱 원고 6자리 중 5자리가 어긋났다):
// `imagePrompts`는 **기준 원고 순서**로 저장된다(parseDraftFile이 본문에서 빼낸 순서). 그런데
// Blogspot 배리에이션은 "진입점을 바꿔 재구성"하는 것이 일이라 문단과 함께 마커 순서도 바뀐다.
// 그걸 번호로만 다시 짝지으면 통째로 밀린다:
//
//   기준 원고 : 제작발표회 · 좋은아침 · 인스타 · 얼굴비교 · 톰포드 · 포스터
//   배리에이션: 톰포드 · 포스터 · 좋은아침 · 얼굴비교 · 인스타 · 제작발표회
//   결과      : "톰포드 화보" 자리에 "제작발표회" 검색어가 붙는다
//
// 그러면 **검색은 A를 하고 판정은 B로** 하게 된다(chooseImage는 마커 설명을 기준으로 본다).
// 맞을 리가 없어 후보가 전부 탈락하고 자리가 빈다 - 사용자가 계속 본 "웹 검색이 안 된다"의
// 직접 원인이었다.
//
// 기존 안전장치(획득 방식 순열 비교)로는 못 잡는다. 전부 `웹 검색`이면 순열이 `ssssss`로 같아
// 순서가 뒤집혀도 통과한다.
//
// 재배열 자체는 막지 않는다(배리에이션의 존재 이유다). 대신 **설명이 가리키는 대상으로** 다시
// 짝지어 검색어가 마커를 따라가게 한다.

const MARKER_RE = /^\[IMAGE:\s*([\s\S]*?)\]$/;
/** 이 점수 아래면 "같은 자리"라고 볼 수 없다. 억지 매칭보다 포기가 낫다. */
const MIN_SCORE = 0.3;

/** 마커 줄에서 설명만 뽑는다(획득 방식 접미사 제거). */
export function markerDescriptions(body: string): string[] {
  return body
    .split("\n")
    .map((line) => line.trim().match(MARKER_RE))
    .filter((matched): matched is RegExpMatchArray => matched !== null)
    .map((matched) => matched[1].trim().replace(/\s*—\s*[^—]*$/, "").trim());
}

/**
 * 비교용 토큰. 한글 2글자 이상, 영문·숫자 2글자 이상만 남긴다 - 한 글자는 어느 설명에나 나와
 * 변별력이 없다.
 */
function tokenize(text: string): string[] {
  const tokens = text
    .replace(/[^0-9A-Za-z가-힣]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 2);
  return [...new Set(tokens)];
}

/**
 * 두 토큰이 같은 말인가. 한국어는 명사에 조사가 달라붙어 같은 대상도 글자열이 달라진다
 * ("안은진" vs "안은진이", "1회" vs "1회에서"). 그래서 **한쪽이 다른 쪽의 앞부분이면** 같게 본다.
 *
 * 조사 목록을 만들어 떼는 방법은 쓰지 않는다. 고유명사가 조사와 같은 글자로 끝나면 망가진다 -
 * "이미도"(극중 인물)의 "도"를 떼면 "이미"가 된다. 게다가 붙은 조사에 따라 결과가 달라져
 * 같은 단어가 서로 다르게 정규화된다.
 */
function sameToken(a: string, b: string): boolean {
  return a === b || a.startsWith(b) || b.startsWith(a);
}

/**
 * 두 설명이 같은 대상을 가리키는 정도(0~1). 자카드 유사도 - 단, 토큰 비교는 접두 일치다.
 *
 * 2026-09-21 안은진 원고 실측: 정확 일치만 쓰던 때는 순서가 바뀌지도 않은 원고에서 6자리 중
 * 4자리가 "대응 없음"으로 떨어졌다. 조사 하나 때문에 같은 단어를 다른 단어로 센 탓이었다.
 */
export function similarity(a: string, b: string): number {
  const left = tokenize(a);
  const right = tokenize(b);
  if (left.length === 0 || right.length === 0) return 0;

  // 오른쪽 토큰 하나는 한 번만 쓴다 - 같은 단어에 여러 개가 겹쳐 붙어 점수가 부풀지 않게.
  const used = new Array<boolean>(right.length).fill(false);
  let shared = 0;
  for (const token of left) {
    const hit = right.findIndex((other, index) => !used[index] && sameToken(token, other));
    if (hit >= 0) {
      used[hit] = true;
      shared += 1;
    }
  }
  return shared / (left.length + right.length - shared);
}

export type AlignResult = {
  /** 배리에이션 마커 순서에 맞춘 검색어. */
  prompts: string[];
  /** 실제로 순서가 바뀌었는지(로그용). */
  reordered: boolean;
  /** 짝을 못 지은 자리 번호(1-base). 그 자리는 빈 문자열이 들어간다. */
  unmatched: number[];
};

/**
 * 기준 원고 순서로 저장된 `prompts`를, 배리에이션 마커 순서에 맞춰 다시 늘어놓는다.
 *
 * 짝짓기는 **탐욕적**이다 - 점수가 높은 쌍부터 확정하고 쓴 것은 뺀다. 같은 설명이 두 번
 * 나오는 원고는 없다시피 하고, 있어도 서로 다른 자리에 하나씩 배정된다.
 *
 * 개수가 안 맞거나 기준 설명이 없으면 `null`을 돌려준다 - 호출부가 기존 동작(번호순)을
 * 그대로 쓰게 해서, 못 고칠 상황에서 더 나빠지지 않게 한다.
 */
export function alignImagePrompts(
  baseBody: string,
  variantBody: string,
  prompts: readonly string[]
): AlignResult | null {
  const baseDescriptions = markerDescriptions(baseBody);
  const variantDescriptions = markerDescriptions(variantBody);

  // 기준 원고의 마커 수와 검색어 수가 다르면 애초에 짝이 깨진 상태다 - 손대지 않는다.
  if (baseDescriptions.length === 0 || baseDescriptions.length !== prompts.length) return null;
  if (variantDescriptions.length === 0) return null;

  // (배리에이션 자리, 기준 자리, 점수) 전부를 만들어 점수 높은 순으로 확정한다.
  const pairs: Array<{ variantIndex: number; baseIndex: number; score: number }> = [];
  variantDescriptions.forEach((variantDescription, variantIndex) => {
    baseDescriptions.forEach((baseDescription, baseIndex) => {
      pairs.push({ variantIndex, baseIndex, score: similarity(variantDescription, baseDescription) });
    });
  });
  pairs.sort((a, b) => b.score - a.score);

  const takenVariant = new Set<number>();
  const takenBase = new Set<number>();
  const assigned = new Array<number | null>(variantDescriptions.length).fill(null);

  for (const pair of pairs) {
    if (pair.score < MIN_SCORE) break;
    if (takenVariant.has(pair.variantIndex) || takenBase.has(pair.baseIndex)) continue;
    assigned[pair.variantIndex] = pair.baseIndex;
    takenVariant.add(pair.variantIndex);
    takenBase.add(pair.baseIndex);
  }

  const reordered = assigned.some((baseIndex, variantIndex) => baseIndex !== null && baseIndex !== variantIndex);

  // 짝을 못 지은 자리를 **무조건 비우면** 검색어 없이 수집하게 돼 그 자리가 빈다. 순서가 바뀌지
  // 않았다는 게 확인된 원고라면 번호순 짝이 맞을 가능성이 높으니 그대로 쓴다(둘 다 아직 임자가
  // 없을 때만 - 이미 다른 자리가 가져간 검색어를 겹쳐 쓰지는 않는다).
  // 순서가 바뀐 원고에서는 쓰지 않는다. 밀린 검색어를 붙이는 것이야말로 고치려던 문제다.
  const unmatched: number[] = [];
  const aligned = assigned.map((baseIndex, variantIndex) => {
    if (baseIndex !== null) return prompts[baseIndex];
    if (!reordered && variantIndex < prompts.length && !takenBase.has(variantIndex)) {
      return prompts[variantIndex];
    }
    unmatched.push(variantIndex + 1);
    return "";
  });

  return { prompts: aligned, reordered, unmatched };
}
