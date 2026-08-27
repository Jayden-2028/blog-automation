// 원고 생성 프롬프트 조립.
//
// 스킬 선택(SPRINT_2_DESIGN.md 2절 - 설계 전제 변경): 원래 계획은 카테고리별로 다른 블로그 작성
// 스킬(entertainment/parenting/trend-blog-writer)을 쓰는 것이었으나, 그 스킬들은
// `anthropic-skills:*` 네임스페이스로 대화형 세션에만 있고 헤드리스 CLI(`claude -p`)에서는
// 로드되지 않는 것이 실측 확인됐다. 대신 `moai-marketer:content-blog`(네이버 블로그를 명시적으로
// 다루고 SEO 메타까지 만든다)를 카테고리 무관 단일 스킬로 쓰고, `moai-writer:korean-humanize`를
// 후처리로 체이닝한다. 두 스킬 모두 헤드리스에서 사용 가능함을 확인했다.
//
// 웹 검색을 주지 않는 이유(§9 결정): 우리가 모은 sources가 곧 감사 기록이어야 한다. 원고 생성에
// 웹 검색을 열면 내용은 풍부해지지만 무엇을 근거로 썼는지 추적할 수 없어지고, Sprint 3 검수가
// 검증할 대상이 사라진다. runArticleJob이 이 프롬프트를 실행할 때 allowedTools를 Skill 하나로
// 제한하는 것으로 강제한다(이 파일은 프롬프트 텍스트만 만들고, 도구 제한은 호출자 책임이다).

import { buildFactCard, summarizeSourcesByAuthority } from "../research/buildFactCard.js";
import type { ArticleJobRow, SourceRow } from "../../types/database.js";

/** 목표 본문 길이(자, 공백 포함). 네이버 블로그 기준 - 짧으면 저품질 판정 위험, 길면 비용·이탈률이 는다. */
export const TARGET_ARTICLE_LENGTH = { min: 1500, max: 2500 } as const;

// 응답을 결정적으로 파싱하기 위한 구분자. 모델이 자유 형식으로 답하면 title/body/seoDescription을
// 나눌 수 없으므로 강하게 고정한다.
export const ARTICLE_OUTPUT_MARKERS = {
  title: "### TITLE",
  body: "### BODY",
  seoDescription: "### SEO_DESCRIPTION",
} as const;

const COMMON_RULES = [
  "제공된 근거(팩트 카드)를 벗어난 구체적인 수치·날짜·인용을 절대 지어내지 않는다. 근거에 없는" +
    " 정보가 필요하면 그 부분은 일반적인 안내 수준으로만 쓰고 확정적으로 말하지 않는다.",
  "인물 관련 내용은 확정 보도된 사실만 다룬다. 추측성 표현(\"~라는 의혹\", \"~한 듯\", \"~로 보인다\")을" +
    " 쓰지 않는다. 한국은 사실을 적시해도 명예훼손이 성립할 수 있다.",
  "정책·지원금 정보는 본문에 출처(기관명 또는 URL)와 발표일을 명시하고, 이 글이 작성된 시점 기준" +
    " 정보임을 밝힌다.",
  "[community] 등급 출처에만 기대는 주장은 단정하지 않는다. \"~라고 알려져 있습니다\", \"~라는" +
    " 경험담이 있습니다\" 수준으로 낮추고, 가능하면 출처를 함께 언급한다.",
  "충격/경악/소름 같은 과장된 낚시 표현을 쓰지 않는다.",
  "본문 끝에 '참고 자료' 섹션을 두고 팩트 카드의 출처를 제목 + 링크 형태로 나열한다.",
] as const;

const MEDICAL_RULES = [
  "이 주제는 의학 정보를 다룬다. 진단이나 처방으로 읽힐 수 있는 단정적 표현(\"~이면 ~입니다\"," +
    " \"~하면 낫습니다\", \"~병입니다\")을 쓰지 않는다.",
  "개별 사례(커뮤니티 경험담 등)를 소개할 때는 반드시 그것이 개인 경험담임을 밝히고, 모든 아이에게" +
    " 적용되는 것처럼 일반화하지 않는다.",
  "글 앞부분에 즉시 병원 진료가 필요한 응급 신호(예: 경련이 5분 이상 지속, 의식 저하, 호흡 곤란 등" +
    " 팩트 카드에 근거가 있는 경우)를 안내한다. 근거가 없으면 이 항목은 생략한다.",
  "본문 중간과 끝에 최소 1회씩 \"정확한 진단은 반드시 소아과 등 전문의와 상담하세요\"라는 취지의" +
    " 안내를 포함한다.",
] as const;

export type BuildArticlePromptInput = {
  job: ArticleJobRow;
  sources: SourceRow[];
  isMedical: boolean;
};

export function buildArticlePrompt(input: BuildArticlePromptInput): string {
  const { job, sources, isMedical } = input;
  const factCard = buildFactCard(sources);
  const summary = summarizeSourcesByAuthority(sources);

  const rules = isMedical ? [...COMMON_RULES, ...MEDICAL_RULES] : COMMON_RULES;

  return [
    "너는 네이버 블로그에 올릴 원고를 쓰는 편집자다.",
    "",
    `moai-marketer:content-blog 스킬을 사용해 아래 키워드로 네이버 블로그 포스팅 초안을 작성한 뒤,`,
    `moai-writer:korean-humanize 스킬로 다듬어라. 두 스킬 모두 순서대로 사용한 뒤 최종 결과만 출력하라.`,
    "",
    `키워드: ${job.keyword}`,
    job.headline && job.headline !== job.keyword ? `원문 제목: ${job.headline}` : null,
    job.category ? `분야: ${job.category}` : null,
    "",
    `근거 출처 등급 요약: 공공 ${summary.countByAuthority.official}건 · 의료기관 ${summary.countByAuthority.medical}건 · ` +
      `뉴스 ${summary.countByAuthority.news}건 · 커뮤니티 ${summary.countByAuthority.community}건`,
    "",
    "=== 팩트 카드 (이 안의 정보만 근거로 쓸 것) ===",
    factCard,
    "=== 팩트 카드 끝 ===",
    "",
    "규칙:",
    ...rules.map((rule) => `- ${rule}`),
    `- 본문 길이는 공백 포함 ${TARGET_ARTICLE_LENGTH.min}~${TARGET_ARTICLE_LENGTH.max}자를 목표로 한다.`,
    "",
    "출력 형식(반드시 아래 마커를 그대로 쓰고, 그 외 설명·인사말을 앞뒤에 붙이지 마라):",
    "",
    ARTICLE_OUTPUT_MARKERS.title,
    "(제목 한 줄)",
    "",
    ARTICLE_OUTPUT_MARKERS.body,
    "(마크다운 본문 전체)",
    "",
    ARTICLE_OUTPUT_MARKERS.seoDescription,
    "(검색 결과에 노출될 요약, 공백 포함 160자 이내 한 줄)",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

export type ParsedArticleOutput = {
  title: string;
  body: string;
  seoDescription: string | null;
};

/**
 * buildArticlePrompt가 지정한 마커로 모델 출력을 나눈다. 마커가 없으면(모델이 형식을 안 지킨 경우)
 * 전체를 body로 보고 title은 job.keyword로 대체한다 - 파싱 실패로 원고 자체를 버리지 않는다.
 */
export function parseArticleOutput(rawOutput: string, fallbackTitle: string): ParsedArticleOutput {
  const titleIndex = rawOutput.indexOf(ARTICLE_OUTPUT_MARKERS.title);
  const bodyIndex = rawOutput.indexOf(ARTICLE_OUTPUT_MARKERS.body);
  const seoIndex = rawOutput.indexOf(ARTICLE_OUTPUT_MARKERS.seoDescription);

  if (titleIndex === -1 || bodyIndex === -1) {
    return { title: fallbackTitle, body: rawOutput.trim(), seoDescription: null };
  }

  const title = rawOutput
    .slice(titleIndex + ARTICLE_OUTPUT_MARKERS.title.length, bodyIndex)
    .trim()
    .split("\n")[0]
    ?.trim();

  const bodyEnd = seoIndex === -1 ? rawOutput.length : seoIndex;
  const body = rawOutput.slice(bodyIndex + ARTICLE_OUTPUT_MARKERS.body.length, bodyEnd).trim();

  const seoDescription =
    seoIndex === -1
      ? null
      : rawOutput.slice(seoIndex + ARTICLE_OUTPUT_MARKERS.seoDescription.length).trim().split("\n")[0]?.trim() || null;

  return { title: title || fallbackTitle, body: body || rawOutput.trim(), seoDescription };
}
