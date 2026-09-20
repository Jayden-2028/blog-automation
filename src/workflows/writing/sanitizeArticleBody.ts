// 발행 전에 본문에서 걷어내는 것들. 프롬프트로 금지해도 모델이 계속 넣는 유형이라 코드로 막는다.
//
// 1) 본문 뒤에 덧붙이는 "작업 노트"
// 2) 원고 전체에 거는 기준 시점 고지("여기 정리한 내용은 2026년 9월 기준입니다.")
//
// --- 1) 작업 노트 ---
//
// 헤드리스 모델은 프롬프트로 아무리 금지해도 가끔 자기 작업을 설명하는 문단을 본문 끝에 붙인다.
// 그대로 두면 독자에게 발행된다 - 실제로 09-19 발행분에 이 문단이 그대로 나갔다(사용자 리포트):
//
//   ---
//   분량은 공백·이미지마커·참고자료 제외 약 2,200자로 2,000~3,000자 범위 안입니다. 진입점을
//   "겪는 장벽 → 원인 → ..." 순으로 재구성해 기준 원고와 소제목·서술 순서를 다르게 잡았고 ...
//
// 예전에는 "점검 결과" 같은 **낱말**로 잡았는데, 위 문단은 그 낱말을 하나도 안 쓴다 - 낱말 목록은
// 계속 새는 방식이라 **구조 규칙**을 1순위로 둔다: 원고는 `**참고 자료**` 목록으로 끝난다
// (prompts/writing/rules/output-format.md). 그 뒤에 오는 `---` 구분선 아래는 본문이 아니다.

/** 본문의 마지막 섹션. 이 뒤에 오는 `---` 블록은 전부 모델의 군말이다. */
const REFERENCES_HEADING = /^\s*(?:\*\*|#{1,3}\s*)?참고\s*자료/;

const DIVIDER = /^\s*-{3,}\s*$/;

/** 낱말 기반 백스톱 - 참고 자료 섹션이 없는 본문용(관측: 2026-09-01). */
const META_PATTERNS = [
  /\n+-{3,}\s*\n+\**\s*점검[^\n]*[\s\S]*$/,
  /\n+#{1,3}\s*점검[\s\S]*$/,
  /\n+\**\s*점검\s*결과\**[\s\S]*$/,
  /\n+\**\s*(확인|검토)\s*(결과|사항)\**\s*[:：][\s\S]*$/,
];

/**
 * `---` 구분선 아래가 작업 노트로 읽히는지. 참고 자료 섹션이 없는 본문에서만 쓴다 -
 * 원고를 가리키는 말(분량·자수·기준 원고·마커·요구사항 …)이 들어 있으면 독자용 문장이 아니다.
 */
const META_VOCABULARY = /(분량|글자\s*수|자수|기준\s*원고|이미지\s*마커|요구\s*사항|체크리스트|작성\s*노트|재구성해|겹치는\s*구간)/;

/**
 * 원고 전체에 거는 기준 시점 고지를 지운다(2026-09-20 사용자 지시).
 *
 * 기준 시점은 **값에 붙이는 것**이지(facts-and-hedging.md "2026년 8월 기준 지원금은 30만 원입니다")
 * 원고 전체에 거는 면피 문장이 아니다. 실측된 것들:
 *   "여기 정리한 내용은 2026년 9월 기준입니다."
 *   "여기 정리한 내용은 2026년 9월 19일 시점 기준입니다."
 *   "이 정리는 2026년 9월 18일 기준입니다."
 *
 * 값에 붙은 기준("친조카는 50만~100만원이 흔한 기준입니다", "인터파크 예매 페이지 기준이에요")은
 * 건드리지 않는다 - 그래서 **원고 자신을 가리키는 주어 + 연도**가 둘 다 있을 때만 지운다.
 */
const AS_OF_DISCLAIMER =
  /(?:여기(?:서)?\s*정리한\s*(?:내용|정보)|이\s*(?:정리|글|포스팅|기사)(?:의\s*(?:내용|정보))?|위\s*(?:내용|정보)|본문의?\s*(?:내용|정보))[^.。!?\n]{0,30}?\d{4}년[^.。!?\n]{0,25}?기준(?:입니다|이에요|이예요|임)\.?\s*/g;

export function stripAsOfDisclaimer(body: string): string {
  return body
    .split("\n")
    .map((line) => {
      const cleaned = line.replace(AS_OF_DISCLAIMER, "").trimEnd();
      // 줄 전체가 그 고지였다면 빈 줄로 남기고, 아래에서 빈 문단을 정리한다.
      return cleaned;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 발행 전 본문 정리 - 작업 노트 제거 + 기준 시점 고지 제거. */
export function sanitizeArticleBody(body: string): string {
  return stripAsOfDisclaimer(stripTrailingMeta(body));
}

export function stripTrailingMeta(body: string): string {
  let out = body;

  // 1) 구조 규칙: `참고 자료` 다음에 나오는 첫 `---` 줄부터 끝까지 버린다. 참고 자료는 원고의
  //    마지막 섹션이라 그 아래 구분선 밑에는 독자용 문장이 올 자리가 없다.
  const lines = out.split("\n");
  const referencesAt = lines.findIndex((line) => REFERENCES_HEADING.test(line));
  if (referencesAt >= 0) {
    const dividerAt = lines.findIndex((line, i) => i > referencesAt && DIVIDER.test(line));
    if (dividerAt >= 0) out = lines.slice(0, dividerAt).join("\n");
  } else {
    // 2) 참고 자료가 없는 본문: 마지막 `---` 아래가 원고 얘기를 하고 있으면 버린다.
    const lastDivider = lines.map((line) => DIVIDER.test(line)).lastIndexOf(true);
    if (lastDivider > 0 && META_VOCABULARY.test(lines.slice(lastDivider + 1).join("\n"))) {
      out = lines.slice(0, lastDivider).join("\n");
    }
  }

  // 3) 낱말 백스톱(구분선 없이 붙는 유형). 위에서 잘라낸 결과에도 이어서 적용한다.
  for (const pattern of META_PATTERNS) out = out.replace(pattern, "");
  return out.trim();
}
