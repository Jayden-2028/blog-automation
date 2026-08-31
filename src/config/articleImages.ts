// 원고 내 이미지 자동생성(OpenAI/Gemini) 켜짐 여부.
//
// 기본 false(보류): 시스템 안정화 전까지 유료 이미지 API 호출을 피한다(CLAUDE.md 원고 파이프라인
// 운영 규칙). 생성 코드·provider(services/images/*, workflows/writing/generateArticleImages.ts)는
// 그대로 두고, runWritingStage가 이 플래그를 보고 호출 여부만 정한다. 보류 상태에서는 원고 본문의
// `[IMAGE: 설명]` 마커가 그대로 남아 사용자가 직접 이미지를 만들어 그 자리에 삽입한다.
//
// 재개: .env에 `ARTICLE_IMAGE_GENERATION=true` 한 줄.

function parseBooleanEnv(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  return value.trim().toLowerCase() === "true";
}

export const ARTICLE_IMAGE_GENERATION_ENABLED = parseBooleanEnv(
  process.env.ARTICLE_IMAGE_GENERATION,
  false
);
