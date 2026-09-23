// 자료조사·집필의 **규격 모드**를 고른다(2026-09-23 사용자 결정 - 검증용).
//
// 왜 생겼나: 규격 문서가 2,549줄 / 체크박스 115개까지 불어났는데, 그중 "이 키워드의 핵심이
// 무엇인가"를 묻는 항목은 하나도 없다. 전부 형식·태도·수치 검사다. 실측 2건에서 주제별 핵심이
// 통째로 빠졌다.
//
//   고윤정 티저  - 티저 영상을 아무도 열어보지 않았다. 광고 속 연출(카페 우연)을 실제 사건으로
//                  읽고 6월 인맥을 설명으로 붙였다. 정작 티저에 무엇이 담겼는지가 없다.
//   영등포 박람회 - 질문 5개 중 3개가 "확인되지 않았다"로 끝났다. 못 찾은 것이 글의 주제가 됐고
//                  ("웨딩 순서의 진짜 뜻"), 어떤 웨딩홀·드레스샵·할인 얼마는 한 줄도 없다.
//
// 그래서 **규격을 지우지 않고 갈아끼운다.** 같은 키워드를 두 모드로 돌려 사람이 비교한다.
// 나쁘면 플래그만 끄면 되고 기존 파일은 그대로다.
//
//   spec(기본) - 지금까지의 규격. researcher.md + writer.md + 브리프 Q1~Q5.
//   auto       - 자율 모드. 조사 항목·소제목 뼈대·분량·이미지 개수를 AI가 정한다.
//                코드가 파싱하는 형식 계약과 사실 규칙만 남긴다.

export const WRITING_MODES = ["spec", "auto"] as const;
export type WritingMode = (typeof WRITING_MODES)[number];

export const DEFAULT_WRITING_MODE: WritingMode = "spec";

/** job.metadata 안의 키. 환경변수보다 우선한다. */
export const WRITING_MODE_KEY = "writingMode";

function coerce(raw: unknown): WritingMode | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  return (WRITING_MODES as readonly string[]).includes(value) ? (value as WritingMode) : null;
}

/**
 * 이 job에 적용할 모드.
 *
 * **job.metadata가 환경변수를 이긴다.** A/B 검증은 같은 파이프라인에서 키워드별로 갈라야 하는데,
 * GitHub Actions의 환경변수는 실행 전체에 걸리므로 그것만으로는 한 런에서 두 모드를 못 돌린다.
 */
export function resolveWritingMode(metadata?: Record<string, unknown> | null): WritingMode {
  return coerce(metadata?.[WRITING_MODE_KEY]) ?? coerce(process.env.WRITING_MODE) ?? DEFAULT_WRITING_MODE;
}
