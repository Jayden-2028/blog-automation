// 본문 뒤에 모델이 덧붙이는 "작업 노트"를 잘라낸다.
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
