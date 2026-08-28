// 이미지 저작권 근거 형식 검증(SPRINT_3_DESIGN.md 11절).
//
// 왜 세 형식으로 고정하는가: `images.copyright_status`가 분쟁 시 유일한 설명 근거다. 자유
// 문자열을 허용하면("아마 괜찮을 것 같음" 등) 나중에 어느 것이 실제로 안전한 근거인지 가려낼 수
// 없다. 로드맵 §6-1(저작권·초상권이 "가장 큰 실질 위험")과 설계 §10(서치는 두 경로로만 한정,
// 생성이 기본) 결정을 코드로 강제하는 지점이다.

export type ImageCopyrightKind = "ai-generated" | "press-release" | "stock";

export type ParsedImageCopyright =
  | { kind: "ai-generated"; tool: string }
  | { kind: "press-release"; domain: string }
  | { kind: "stock"; service: string; license: string };

const AI_GENERATED_PATTERN = /^ai-generated:([a-zA-Z0-9._-]+)$/;
const PRESS_RELEASE_PATTERN = /^press-release:([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})$/;
const STOCK_PATTERN = /^stock:([a-zA-Z0-9._-]+):([a-zA-Z0-9._-]+)$/;

/**
 * `copyright_status` 문자열을 파싱한다. 세 형식 중 하나가 아니면 null - 이 경우 저장을
 * 거부해야 한다(recordArticleImage.ts가 이 함수를 그 목적으로 쓴다).
 */
export function parseImageCopyright(value: string | null | undefined): ParsedImageCopyright | null {
  if (!value) return null;

  const aiMatch = value.match(AI_GENERATED_PATTERN);
  if (aiMatch) return { kind: "ai-generated", tool: aiMatch[1] };

  const pressMatch = value.match(PRESS_RELEASE_PATTERN);
  if (pressMatch) return { kind: "press-release", domain: pressMatch[1] };

  const stockMatch = value.match(STOCK_PATTERN);
  if (stockMatch) return { kind: "stock", service: stockMatch[1], license: stockMatch[2] };

  return null;
}

export function isValidImageCopyright(value: string | null | undefined): boolean {
  return parseImageCopyright(value) !== null;
}
