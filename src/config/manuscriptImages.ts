// 원고 이미지 자동 생성 설정 (BLOGSPOT_ONLY_DESIGN.md §3).
//
// workflows/writing/generateArticleImages.ts(자체 브리프 생성 -> 본문에 마크다운 삽입)와는 다른
// 경로다. 이쪽은 writer가 이미 본문에 남긴 [IMAGE PROMPT: ...]를 그대로 써서, 본문을 건드리지
// 않고 이미지만 만든다. 옛 경로는 지우지 않되 호출하지 않는다(ARTICLE_IMAGE_GENERATION은 계속 false).
//
// 기본값이 false인 이유: 유료 API 호출이다. 켜는 것은 사용자 결정이고, .env / GitHub Secrets에
// `MANUSCRIPT_IMAGE_GENERATION=true`와 OPENAI_API_KEY(또는 GEMINI_API_KEY)가 들어가야 실제로 돈다.

function parseBooleanEnv(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value.trim() === "") return defaultValue;
  return value.trim().toLowerCase() === "true";
}

function parseIntEnv(value: string | undefined, defaultValue: number): number {
  if (value === undefined) return defaultValue;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) || parsed <= 0 ? defaultValue : parsed;
}

export type ManuscriptImageConfig = {
  enabled: boolean;
  /**
   * true면 프롬프트 1개당 OpenAI·Gemini 양쪽을 만들어 뷰어에 나란히 띄운다(2026-09-15 사용자
   * 결정 - 직접 보고 고르기로 함). 비교가 끝나면 false로 내리고 IMAGE_PROVIDER 한쪽만 쓴다.
   * 호출 수가 2배라 비교 기간에만 켜 둔다.
   */
  abCompare: boolean;
  /**
   * 원고 1건이 만들 수 있는 이미지 상한(프롬프트가 아무리 많아도 여기서 자른다).
   * 6 → 8(2026-09-18). writer.md §8은 "최소 5쌍"만 정하고 상한이 없어 마커 7개짜리 원고가 나오는데,
   * 상한 6에 걸려 **마지막 한 자리가 조용히 비었다**(실측: 정부지원금 원고, 마커 7 중 6장만 생성).
   * 비용 상한이라는 취지는 유지하되 실제 마커 수(5~7)를 덮도록 한 칸 올린다.
   */
  maxPerArticle: number;
};

export const MANUSCRIPT_IMAGE_CONFIG: ManuscriptImageConfig = {
  enabled: parseBooleanEnv(process.env.MANUSCRIPT_IMAGE_GENERATION, false),
  abCompare: parseBooleanEnv(process.env.IMAGE_AB_COMPARE, true),
  maxPerArticle: parseIntEnv(process.env.IMAGE_MAX_PER_ARTICLE, 8),
};
