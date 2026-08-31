// 승인된 네이버 기준 원고 -> 채널별(blogspot/tistory) SEO 배리에이션 원고 1건.
// SPRINT_5_DESIGN.md §3. 네이버 원고 집필(runArticleJob)과 같은 헤드리스 경로(claude -p +
// moai-marketer:content-blog + moai-writer:korean-humanize)를 쓴다.
//
// 왜 "의미 있는 재작성"인가: 같은 사람이 운영하는 서로 다른 도메인에 거의 같은 글이 올라가면
// 한쪽이 구글에서 중복 콘텐츠로 걸러진다. 표현·구조·제목은 바꾸되 팩트·수치·날짜·인용은
// 기준 원고에서 100% 보존한다(§3-3). 이 "보존" 요구는 프롬프트 규칙 + 이후 articleReviewChecks
// (팩트 검사)로 이중 확인한다.
//
// 웹 검색을 주지 않는 이유는 runArticleJob과 같다 - 기준 원고가 감사 기록이고, 배리에이션이
// 새 사실을 끌어오면 추적성이 깨진다. allowedTools를 Skill 하나로 제한한다.

import { runHeadlessClaude } from "../../services/llm/runHeadlessClaude.js";
import type { RunHeadlessClaudeResult } from "../../services/llm/runHeadlessClaude.js";

export const VARIANT_TIMEOUT_MS = 8 * 60 * 1000;

export const VARIANT_OUTPUT_MARKERS = {
  title: "### TITLE",
  searchDescription: "### SEARCH_DESCRIPTION",
  slug: "### SLUG",
  tags: "### TAGS",
  body: "### BODY",
} as const;

export type VariantChannel = "blogspot" | "tistory";

export type ArticleVariant = {
  title: string;
  searchDescription: string | null;
  /** blogspot만 의미 있음(영문 kebab permalink). tistory는 null. */
  slug: string | null;
  tags: string[];
  /** 마크다운 부분집합(## / ** / - / [](): / ![](): ). convertArticleToHtml이 HTML로 바꾼다. */
  body: string;
};

export type GenerateArticleVariantResult =
  | { status: "success"; variant: ArticleVariant; durationMs: number }
  | { status: "failed"; error: string };

const CHANNEL_LABEL: Record<VariantChannel, string> = {
  blogspot: "구글 Blogspot(Blogger)",
  tistory: "티스토리",
};

export type GenerateArticleVariantInput = {
  channel: VariantChannel;
  /** 내부 category (entertainment/ott/parenting/living/community). 톤 참고용. */
  category: string | null;
  baseTitle: string;
  /** 네이버 기준 원고 본문(마크다운). 해시태그 줄 포함. */
  baseBody: string;
  /** 테스트 주입 지점. 기본은 runHeadlessClaude(claude -p). */
  generate?: (prompt: string) => Promise<RunHeadlessClaudeResult>;
};

function buildPrompt(input: GenerateArticleVariantInput): string {
  const { channel, category, baseTitle, baseBody } = input;
  const M = VARIANT_OUTPUT_MARKERS;
  const slugRule =
    channel === "blogspot"
      ? `- ${M.slug} 다음 줄에 영문 소문자 kebab-case 슬러그 1줄(핵심 키워드의 로마자 표기, 4~6단어, 날짜·숫자 금지).`
      : `- ${M.slug} 다음 줄에 "-" 한 글자만(티스토리는 슬러그를 지정하지 않는다).`;

  return [
    `당신은 ${CHANNEL_LABEL[channel]}에 올릴 SEO 최적화 블로그 글을 쓴다.`,
    `아래 "기준 원고"(네이버 블로그용)를 소스로, ${CHANNEL_LABEL[channel]} 독자와 구글 검색에 맞춘`,
    `배리에이션 글을 만든다. moai-marketer:content-blog 스킬로 작성하고 moai-writer:korean-humanize로 마무리한다.`,
    ``,
    `## 절대 규칙 - 사실 보존`,
    `- 기준 원고에 있는 수치·날짜·금액·고유명사·인용·제도명은 한 글자도 바꾸지 않고 그대로 쓴다.`,
    `  기준 원고에 없는 새로운 사실·수치·날짜를 추가하지 않는다(웹 검색 없음).`,
    ``,
    `## 절대 규칙 - "다시 쓰기"가 아니라 "다시 기획하기" (중복 콘텐츠 방지)`,
    `기준 원고 문장을 동의어로 바꾸는 수준이면 구글이 중복으로 판단해 한쪽을 색인에서 뺀다.`,
    `- 각 소제목의 내용을 새 각도에서 서술한다: 정보 제시 순서를 바꾸고, 진입점을 바꾸고`,
    `  (기준이 "무엇인가" 설명이면 배리에이션은 "독자가 겪는 상황 → 해결"), 나열형을 문답형·비교형·`,
    `  시나리오형으로 바꾼다.`,
    `- **"## 요약"은 기준 원고의 결론/정리 문장을 절대 재사용하지 않는다.** 이 배리에이션 글에서`,
    `  실제로 다룬 소제목들을 1~2문장으로 새로 압축한다.`,
    `- 절차(번호 목록)와 고유명사 목록은 내용을 바꿀 수 없다 - 대신 그 앞뒤 설명 문장을 새로 쓰고,`,
    `  설명형 목록(절차가 아닌 것)은 항목을 묶거나 나눠 개수를 다르게 한다.`,
    `- 마지막 점검: 배리에이션의 어떤 부분도 기준 원고와 연속 3어절 이상 똑같이 겹치면 안 된다`,
    `  (숫자·날짜·제도명·URL은 예외).`,
    ``,
    `## 절대 규칙 - 구조/형식`,
    `- 제목은 기준 원고 제목과 완전히 다른 표현으로. 핵심 키워드를 앞쪽에 둔다.`,
    `- 첫 문단 100자 안에 핵심 키워드를 넣는다.`,
    `- 소제목(##)은 질문형/How-to형으로. 본문 끝에 "## 자주 묻는 질문"(3~5문답)과 "## 요약" 문단을 둔다.`,
    `- 본문 안에서 개별 출처를 부르지 않는다("(출처: ...)", "한 블로그에 따르면" 금지). 참고 링크는`,
    `  기준 원고의 '참고 자료'를 그대로 옮긴다.`,
    `- 이미지: 기준 원고의 ![alt](url) 이미지를 같은 URL로 본문 흐름에 맞는 위치에 그대로 넣는다.`,
    `  alt 텍스트에 키워드가 들어가도록 자연스럽게 다듬는다.`,
    category ? `- 카테고리: ${category}. 그 분야 개인 블로그 톤을 유지한다.` : ``,
    ``,
    `## 출력 형식 (아래 마커를 정확히 그대로, 순서대로)`,
    `${M.title}`,
    `(재작성한 제목 1줄)`,
    `${M.searchDescription}`,
    `(검색 설명 1줄, 155자 이내, 핵심 키워드 + 요점)`,
    slugRule,
    `${M.tags}`,
    `(쉼표로 구분한 태그 5~10개)`,
    `${M.body}`,
    `(마크다운 본문: ## 소제목 / **굵게** / - 목록 / [텍스트](URL) / ![alt](url) 이미지 / 빈 줄로 문단 구분)`,
    ``,
    `## 기준 원고 (제목: ${baseTitle})`,
    baseBody,
  ]
    .filter((line) => line !== ``)
    .join("\n");
}

function sliceBetween(text: string, startMarker: string, endMarkers: string[]): string {
  const start = text.indexOf(startMarker);
  if (start === -1) return "";
  const from = start + startMarker.length;
  const ends = endMarkers.map((m) => text.indexOf(m, from)).filter((i) => i !== -1);
  const to = ends.length > 0 ? Math.min(...ends) : text.length;
  return text.slice(from, to).trim();
}

export function parseVariantOutput(raw: string, channel: VariantChannel, fallbackTitle: string): ArticleVariant {
  const M = VARIANT_OUTPUT_MARKERS;
  const order: string[] = [M.title, M.searchDescription, M.slug, M.tags, M.body];
  const after = (marker: string): string[] => order.slice(order.indexOf(marker) + 1);

  const title = sliceBetween(raw, M.title, after(M.title)).split("\n")[0]?.trim() || fallbackTitle;
  const searchDescription = sliceBetween(raw, M.searchDescription, after(M.searchDescription)).split("\n")[0]?.trim() || null;

  const slugRaw = sliceBetween(raw, M.slug, after(M.slug)).split("\n")[0]?.trim() ?? "";
  const slug =
    channel === "blogspot"
      ? slugRaw
          .toLowerCase()
          .replace(/[^a-z0-9\s-]/g, "")
          .trim()
          .replace(/\s+/g, "-")
          .replace(/-+/g, "-")
          .slice(0, 80) || null
      : null;

  const tagsRaw = sliceBetween(raw, M.tags, after(M.tags));
  const tags = tagsRaw
    .split(/[,\n]/)
    .map((t) => t.replace(/^#/, "").trim())
    .filter(Boolean)
    .slice(0, 10);

  const body = sliceBetween(raw, M.body, []) || raw.trim();

  return { title, searchDescription, slug, tags, body };
}

export async function generateArticleVariant(
  input: GenerateArticleVariantInput
): Promise<GenerateArticleVariantResult> {
  const generate =
    input.generate ??
    ((prompt: string) => runHeadlessClaude({ prompt, allowedTools: ["Skill"], timeoutMs: VARIANT_TIMEOUT_MS }));

  const startedAt = Date.now();
  const result = await generate(buildPrompt(input));
  if (!result.ok) {
    return { status: "failed", error: result.error };
  }

  const variant = parseVariantOutput(result.output, input.channel, input.baseTitle);
  if (!variant.body || variant.body.length < 300) {
    return { status: "failed", error: `배리에이션 본문이 너무 짧습니다 (${variant.body.length}자)` };
  }

  return { status: "success", variant, durationMs: Date.now() - startedAt };
}
