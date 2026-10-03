// 원고 이미지 자동 생성 설정 (BLOGSPOT_ONLY_DESIGN.md §3).
//
// workflows/writing/generateArticleImages.ts(자체 브리프 생성 -> 본문에 마크다운 삽입)와는 다른
// 경로다. 이쪽은 writer가 이미 본문에 남긴 [IMAGE PROMPT: ...]를 그대로 써서, 본문을 건드리지
// 않고 이미지만 만든다. 옛 경로는 지우지 않되 호출하지 않는다(ARTICLE_IMAGE_GENERATION은 계속 false).
//
// 기본값은 켜짐(2026-10-03 - 운영 variables `MANUSCRIPT_IMAGE_GENERATION=true`와 맞췄다. 전에는 코드 false /
// 운영 true로 갈려 맥 로컬과 클라우드가 다르게 돌았다). 유료 API 호출이라 끄는 건 `=false`로 명시한다.
// OPENAI_API_KEY(또는 GEMINI_API_KEY)가 없으면 생성이 실패로 기록될 뿐 원고 준비는 그대로 진행된다.
// IMAGE_AB_COMPARE도 같은 이유로 운영값(false)이 기본이다 - A/B 비교는 끝났다.

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
  /**
   * 인포그래픽 자리의 생성 화질(2026-10-01). 사진 자리는 비용 때문에 `low`로 두는데, 인포그래픽은
   * **글자가 읽혀야 쓸모가 있어** 같은 화질로 뽑으면 라벨이 뭉개진다.
   *
   * 기본은 `low`로 둔다 - 올리면 장당 비용이 오르고, 유료 상향은 사용자 승인 사항이다.
   * 올릴 때는 `IMAGE_INFOGRAPHIC_QUALITY=medium`(또는 high) 한 줄이면 된다.
   */
  infographicQuality: ImageQuality;
};

/** OpenAI 이미지 화질 등급. 올릴수록 글자가 또렷해지고 장당 비용이 오른다. */
export type ImageQuality = "low" | "medium" | "high";

function parseQualityEnv(raw: string | undefined, fallback: ImageQuality): ImageQuality {
  const value = (raw ?? "").trim().toLowerCase();
  return value === "low" || value === "medium" || value === "high" ? value : fallback;
}

export const MANUSCRIPT_IMAGE_CONFIG: ManuscriptImageConfig = {
  enabled: parseBooleanEnv(process.env.MANUSCRIPT_IMAGE_GENERATION, true),
  abCompare: parseBooleanEnv(process.env.IMAGE_AB_COMPARE, false),
  maxPerArticle: parseIntEnv(process.env.IMAGE_MAX_PER_ARTICLE, 8),
  infographicQuality: parseQualityEnv(process.env.IMAGE_INFOGRAPHIC_QUALITY, "low"),
};
