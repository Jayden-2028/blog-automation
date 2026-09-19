// 작성 단계 기준 원고 -> Blogspot SEO 배리에이션 원고 1건.
// SPRINT_5_DESIGN.md §3. 2026-09-15 티스토리 운영 중단으로 채널 인자가 사라졌다
// (BLOGSPOT_ONLY_DESIGN.md §6) - 이 함수는 항상 Blogspot용 1건만 만든다.
// 원고 집필(runArticleJob)과 같은 헤드리스 경로(claude -p +
// moai-marketer:content-blog + moai-writer:korean-humanize)를 쓴다.
//
// 왜 "의미 있는 재작성"인가: 같은 사람이 운영하는 서로 다른 도메인에 거의 같은 글이 올라가면
// 한쪽이 구글에서 중복 콘텐츠로 걸러진다. 표현·구조·제목은 바꾸되 팩트·수치·날짜·인용은
// 기준 원고에서 100% 보존한다(§3-3). 이 "보존" 요구는 프롬프트 규칙 + 이후 articleReviewChecks
// (팩트 검사)로 이중 확인한다.
//
// 웹 검색을 주지 않는 이유는 runArticleJob과 같다 - 기준 원고가 감사 기록이고, 배리에이션이
// 새 사실을 끌어오면 추적성이 깨진다. allowedTools를 Skill 하나로 제한한다.

import { PIPELINE_ROOT } from "../../config/pipelinePaths.js";
import { runHeadlessClaude } from "../../services/llm/runHeadlessClaude.js";
import { stripTrailingMeta } from "./stripTrailingMeta.js";
import { parseImageAcquisition } from "../manuscripts/parseManuscriptBlocks.js";
import type { RunHeadlessClaudeResult } from "../../services/llm/runHeadlessClaude.js";

// 배리에이션도 writer.md(500줄+)를 읽고 content-blog·korean-humanize를 순서대로 돌린다 -
// 원고 집필과 비슷한 부하다. 2026-09-01 E2E에서 8분 타임아웃에 걸려 20분으로 늘린다.
export const VARIANT_TIMEOUT_MS = 20 * 60 * 1000;

export const VARIANT_OUTPUT_MARKERS = {
  title: "### TITLE",
  searchDescription: "### SEARCH_DESCRIPTION",
  slug: "### SLUG",
  shortName: "### SHORT_NAME",
  tags: "### TAGS",
  body: "### BODY",
} as const;

export type ArticleVariant = {
  title: string;
  searchDescription: string | null;
  /** 영문 kebab permalink. 모델이 쓸 만한 값을 못 주면 null. */
  slug: string | null;
  /** 로컬 보관함 폴더로 쓸 짧은 한글 키워드. 못 주면 null(키워드로 폴백). */
  shortName: string | null;
  tags: string[];
  /** 마크다운 부분집합(## / ** / - / [](): / ![](): ). convertArticleToHtml이 HTML로 바꾼다. */
  body: string;
};

export type GenerateArticleVariantResult =
  | { status: "success"; variant: ArticleVariant; durationMs: number }
  | { status: "failed"; error: string };

const CHANNEL_LABEL = "구글 Blogspot(Blogger)";

export type GenerateArticleVariantInput = {
  /** 내부 category (entertainment/ott/parenting/living/community). 톤 참고용. */
  category: string | null;
  baseTitle: string;
  /** 작성 단계 기준 원고 본문(마크다운). 해시태그 줄 포함. */
  baseBody: string;
  /** 테스트 주입 지점. 기본은 runHeadlessClaude(claude -p). */
  generate?: (prompt: string) => Promise<RunHeadlessClaudeResult>;
};

function buildPrompt(input: GenerateArticleVariantInput): string {
  const { category, baseTitle, baseBody } = input;
  const M = VARIANT_OUTPUT_MARKERS;
  // 2026-09-18: "로마자 표기"를 **의미 번역**으로 바꿨다. 예전 규칙 그대로 두니
  // `neo-malgo-dareun-yeonae-sicheongnyul`(너 말고 다른 연애 시청률) 같은 소리나는 대로 적은
  // 퍼머링크가 나왔다 - 영어권 검색에 아무 의미가 없어 SEO를 통째로 버리는 값이다.
  const slugRule = [
    `- ${M.slug} 다음 줄에 영문 소문자 kebab-case 퍼머링크 1줄(4~7단어).`,
    `  **한글 발음을 로마자로 옮기지 말고 뜻을 영어로 번역한다.** 영어권 검색어로 말이 돼야 한다.`,
    `  다만 인명·지명·브랜드 같은 고유명사는 통용 표기를 그대로 쓴다(lee-jaesi, hongdae, samsung).`,
    `  연도·회차 숫자는 검색에 도움이 되면 넣어도 된다(2026-, -2nd-).`,
    `  (X) neo-malgo-dareun-yeonae-sicheongnyul   (O) not-you-another-romance-ratings`,
    `  (X) cheongnyeon-mirae-jeokgeum-sinchung    (O) youth-future-savings-2nd-application`,
    `  (X) sosanggongin-jiwongeum-sincheong-jogeon (O) 2026-small-business-subsidy-conditions`,
    `  (X) intern-gyeolmal-wonjak-iyu             (O) the-intern-korean-remake-ending`,
    // 로컬 보관함 폴더 이름. 제목 전체를 쓰면 폴더가 길어 훑어보기 나쁘다(사용자 요청, 2026-09-18).
    `- ${M.shortName} 다음 줄에 이 글을 가리키는 **짧은 한글 키워드** 1줄(2~8자, 공백 한 번까지).`,
    `  폴더 이름으로 쓴다 - 제목을 그대로 넣지 말고 사람이 부를 법한 말로 줄인다.`,
    `  예: "청년미래적금 2차 신청기간 확정｜가입조건" → 청년지원금 / "최민식·한소희 인턴 원작과 결말" → 인턴`,
    `  "이동국 딸 재시 美 명문대 휴학" → 이재시 / "소상공인지원금 신청 조건" → 소상공인 지원금`,
  ].join("\n");

  return [
    `당신은 ${CHANNEL_LABEL}에 올릴 SEO 최적화 블로그 글을 쓴다.`,
    `아래 "기준 원고"를 소스로, ${CHANNEL_LABEL} 독자와 구글 검색에 맞춘`,
    `배리에이션 글을 만든다. moai-marketer:content-blog 스킬로 작성하고 moai-writer:korean-humanize로 마무리한다.`,
    ``,
    `먼저 prompts/writing/writer.md와 prompts/writing/rules/facts-and-hedging.md를 Read해`,
    `구조·사실 태도(확인/헤지 금지 - 2026-09-15부터 writer.md §4가 이 파일로 옮겨졌다) 원칙을`,
    `따른다. prompts/writing/rules/output-format.md(구 §6~10)의 소제목·이미지 마커 서식도 그대로 따른다.`,
    category === "incident"
      ? `어투는 prompts/writing/style/incident.md(습니다체 통일·1인칭 금지)를 Read해 그대로 따른다.`
      : `어투·어미·인칭은 prompts/writing/style/voice.md(공통 문체, 2026-09-16)를 Read해 그대로 따른다 -`,
    category === "incident" ? `` : `카테고리와 무관하게 이 한 목소리다.`,
    `단, 출력은 output-format.md §9(파일 저장)가 아니라 아래 ### 마커 형식으로 하고, 사실은 기준`,
    `원고에서만 가져온다(자료조사 파일·웹 검색 없음).`,
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
    `- (스스로 확인만 할 것, 글에는 쓰지 않는다) 배리에이션의 어떤 부분도 기준 원고와 연속 3어절 이상`,
    `  똑같이 겹치면 안 된다 (숫자·날짜·제도명·URL은 예외).`,
    ``,
    `## 절대 규칙 - 구조/형식`,
    `- 제목은 기준 원고 제목과 완전히 다른 표현으로. 핵심 키워드를 앞쪽에 둔다.`,
    `- 첫 문단 100자 안에 핵심 키워드를 넣는다.`,
    `- 소제목은 output-format.md §6 규격대로 "**소제목**" 볼드 한 줄이다(# 안 씀). 질문형/How-to형으로 짓는다.`,
    `  소제목 앞에는 빈 줄 1개, 소제목 바로 다음 줄에는 빈 줄 없이 그 소제목의 첫 문단이 붙는다.`,
    `  본문 끝에 "**자주 묻는 질문**"(3~5문답)과 "**요약**" 문단을 둔다.`,
    `- [IMAGE: ...]/[IMAGE PROMPT: ...] 마커 쌍의 앞뒤는 다른 블록 사이(빈 줄 1개)보다 넓게 빈 줄 2개로 띄운다.`,
    `- 본문 안에서 개별 출처를 부르지 않는다("(출처: ...)", "한 블로그에 따르면" 금지). 참고 링크는`,
    `  기준 원고의 '참고 자료'를 그대로 옮긴다.`,
    `- 이미지: 기준 원고에 ![alt](url) 이미지가 있으면 같은 URL로 본문 흐름에 맞는 위치에 그대로`,
    `  넣고 alt 텍스트에 키워드가 들어가도록 다듬는다. 기준 원고에 "[IMAGE: 설명]" 마커만 있으면`,
    `  배리에이션에도 대응되는 위치에 "[IMAGE: 설명]" 마커로 남긴다(이미지는 사람이 나중에 삽입).`,
    category ? `- 카테고리: ${category}. 구조·흐름은 그 분야 style 파일, 어투는 위에서 Read한 문체 파일을 따른다.` : ``,
    ``,
    `## 출력 형식 (아래 마커를 정확히 그대로, 순서대로)`,
    `${M.title}`,
    `(재작성한 제목 1줄)`,
    `${M.searchDescription}`,
    `(검색 설명 1줄, 155자 이내, 핵심 키워드 + 요점)`,
    `  ※ 본문 첫 문단을 이 검색 설명과 같은 요지로 쓴다 - 한 문장만 읽어도 무슨 글인지 알 수 있게.`,
    `  Blogger는 검색 설명을 API로 못 받아서(2026-09-16 확인) 사람이 넣기 전까지 meta description이`,
    `  비고, 그때 검색엔진은 본문 앞부분으로 스니펫을 만든다. 첫 문단이 곧 설명이 되도록 쓴다.`,
    slugRule,
    // SHORT_NAME은 §규칙 절에만 있고 출력 템플릿에서 빠져 있었다(2026-09-18 발견). 모델이 규칙
    // 순서를 보고 TAGS 앞에 넣어줘서 지금까지 통했지만, 뒤에 넣으면 태그에 섞이고 아예 빠뜨리면
    // missingMarkers 검사에 걸려 배리에이션이 통째로 실패한다. 순서를 템플릿에 못박는다.
    `${M.shortName}`,
    `(짧은 한글 키워드 1줄 - 위 규칙 참고)`,
    `${M.tags}`,
    `(쉼표로 구분한 태그 정확히 10개 이상)`,
    `${M.body}`,
    `(마크다운 본문: **소제목**(볼드, 다음 줄에 바로 문단) / **굵게** / - 목록 / [텍스트](URL) / ![alt](url) 이미지 / 문단 사이 빈 줄 1개, 이미지 마커 앞뒤 빈 줄 2개)`,
    `본문은 '참고 자료' 목록으로 끝낸다. 그 뒤에 점검 결과·작업 노트·요구사항 준수 설명 같은`,
    `메타 텍스트를 절대 붙이지 않는다.`,
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

export function parseVariantOutput(raw: string, fallbackTitle: string): ArticleVariant {
  const M = VARIANT_OUTPUT_MARKERS;
  const order: string[] = [M.title, M.searchDescription, M.slug, M.shortName, M.tags, M.body];
  const after = (marker: string): string[] => order.slice(order.indexOf(marker) + 1);

  const title = sliceBetween(raw, M.title, after(M.title)).split("\n")[0]?.trim() || fallbackTitle;
  const searchDescription = sliceBetween(raw, M.searchDescription, after(M.searchDescription)).split("\n")[0]?.trim() || null;

  const slugRaw = sliceBetween(raw, M.slug, after(M.slug)).split("\n")[0]?.trim() ?? "";
  const slug =
    slugRaw
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .slice(0, 80) || null;

  const tagsRaw = sliceBetween(raw, M.tags, after(M.tags));
  // 해시태그는 10개 이상 확보해 두는 게 목표라(2026-09-06) 상한을 자르지 않는다.
  const tags = tagsRaw
    .split(/[,\n]/)
    .map((t) => t.replace(/^#/, "").trim())
    .filter(Boolean);

  const body = stripTrailingMeta(sliceBetween(raw, M.body, []) || raw.trim());

  // 폴더 이름으로 쓰므로 경로에 위험한 문자와 따옴표·마크다운 장식을 걷어낸다. 못 받으면 null -
  // exportFolderName이 키워드로 폴백한다.
  const shortNameRaw = sliceBetween(raw, M.shortName, after(M.shortName)).split("\n")[0]?.trim() ?? "";
  const shortName =
    shortNameRaw
      .replace(/^[-*·"'`]+|[-*·"'`]+$/g, "")
      .replace(/[/\\:*?"<>|]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 20) || null;

  return { title, searchDescription, slug, shortName, tags, body };
}

/** 본문의 `[IMAGE: ]` 마커 개수. 기준 원고와 배리에이션이 같아야 프롬프트 짝이 맞는다. */
export function countImageMarkers(body: string): number {
  return body.split("\n").filter((line) => /^\[IMAGE:\s*[\s\S]*?\]$/.test(line.trim())).length;
}

/**
 * 마커의 **획득 방식 순열**("atatata" 꼴). 개수만 봐서는 부족하다는 것이 실측으로 드러났다
 * (2026-09-18): 정부지원금은 기준 `atatata` → 배리에이션 `aattata`로 **개수는 7로 같은데 순서가
 * 달랐고**, 노크노크는 기준 `saasss` → 배리에이션 `ssasst`로 없던 `표 생성`까지 생겼다.
 * 프롬프트는 등장 순서로 짝지으므로 순서가 밀리면 AI 자리에 "표로 렌더"가, 표 자리에 사진
 * 프롬프트가 들어간다 - 사용자가 본 "내용과 상관없는 표"가 전부 이것이었다.
 */
export function imageAcquisitionSequence(body: string): string {
  return body
    .split("\n")
    .map((line) => line.trim().match(/^\[IMAGE:\s*([\s\S]*?)\]$/))
    .filter((matched): matched is RegExpMatchArray => matched !== null)
    .map((matched) => parseImageAcquisition(matched[1].trim())[0])
    .join("");
}

/** 마커 순열이 틀렸을 때 그 사실을 알려주고 다시 시키는 프롬프트. 한 번만 쓴다. */
function buildMarkerFixPrompt(input: GenerateArticleVariantInput, expected: string, got: string): string {
  const spell = (seq: string) =>
    [...seq].map((c) => (c === "a" ? "AI 생성" : c === "t" ? "표 생성" : c === "s" ? "웹 검색" : "미지정")).join(" → ");
  return [
    "방금 쓴 배리에이션의 `[IMAGE: ]` 마커가 기준 원고와 다르다.",
    `  기준 원고(${expected.length}개): ${spell(expected)}`,
    `  네가 쓴 것(${got.length}개): ${spell(got)}`,
    "이미지 제작 프롬프트가 마커 **등장 순서**로 짝지어지므로, 개수만이 아니라 **순서와 획득 방식**이",
    "정확히 같아야 한다. 하나라도 밀리면 AI 자리에 표 프롬프트가, 표 자리에 사진 프롬프트가 들어간다.",
    "기준 원고의 마커를 순서·획득 방식 그대로 옮겨 처음부터 다시 쓴다. 출력 마커 형식도 그대로 지킨다.",
    "",
    buildPrompt(input),
  ].join("\n");
}

export async function generateArticleVariant(
  input: GenerateArticleVariantInput
): Promise<GenerateArticleVariantResult> {
  const generate =
    input.generate ??
    ((prompt: string) =>
      runHeadlessClaude({
        prompt,
        // Skill(content-blog/korean-humanize) + Read(prompts/writing/writer.md). Write/WebSearch는
        // 주지 않는다 - 배리에이션은 기준 원고가 유일 소스이고 stdout 마커로 결과를 돌려준다.
        allowedTools: ["Skill", "Read"],
        permissionMode: "acceptEdits",
        cwd: PIPELINE_ROOT,
        timeoutMs: VARIANT_TIMEOUT_MS,
      }));

  const startedAt = Date.now();
  const result = await generate(buildPrompt(input));
  if (!result.ok) {
    return { status: "failed", error: result.error };
  }

  // 마커 형식을 지키지 않은 응답(예: "기준 원고에 정보가 부족합니다" 같은 대화체 회신)을 그대로
  // 통과시키면 안 된다 - sliceBetween은 ### BODY를 못 찾으면 원문 전체를 본문으로 써버려서,
  // 회신이 300자를 넘기면(실측: 근거 얇은 job에서 재현) 겉보기엔 "성공"인 채로 제목/태그/검색
  // 설명이 전부 비고 본문에 대화체 문장이 섞인 원고가 나간다(2026-09-06 실측 발견).
  const missingMarkers = Object.values(VARIANT_OUTPUT_MARKERS).filter((marker) => !result.output.includes(marker));
  if (missingMarkers.length > 0) {
    return {
      status: "failed",
      error: `모델이 출력 마커 형식을 따르지 않았습니다(누락: ${missingMarkers.join(", ")}) - 기준 원고 정보가 부족해 모델이 대화체로 되물었을 수 있습니다. 원문 시작: ${result.output.slice(0, 200)}`,
    };
  }

  const variant = parseVariantOutput(result.output, input.baseTitle);
  if (!variant.body || variant.body.length < 300) {
    return { status: "failed", error: `배리에이션 본문이 너무 짧습니다 (${variant.body.length}자)` };
  }

  // **마커 개수 보존 검증**(2026-09-18). 이미지 프롬프트(job.metadata.imagePrompts)는 기준 원고에서
  // 뽑은 것이라, 배리에이션이 마커를 하나라도 더하거나 빼면 짝이 어긋난다. 그러면
  // parseManuscriptBlocks가 안전을 위해 **모든 프롬프트를 null로 떨어뜨리고**, 그 원고의 AI 생성
  // 자리가 전부 "프롬프트 없음"으로 비어 버린다.
  //
  // 실측(2026-09-18): 오늘 13건 중 2건이 이 경우였다 - 카톡 스타벅스(기준 5 → 배리에이션 6),
  // 블랙핑크 로제(기준 6 → 배리에이션 5). 각각 AI 자리 3개·2개가 통째로 비었다.
  //
  // 한 번만 다시 시킨다. 실패해도 배리에이션 자체는 살린다 - Blogspot 원고는 필수라 여기서
  // 중단하면 원고가 통째로 없어지는데, 그건 이미지 몇 장 비는 것보다 훨씬 큰 손해다.
  const baseSeq = imageAcquisitionSequence(input.baseBody);
  if (baseSeq.length > 0 && imageAcquisitionSequence(variant.body) !== baseSeq) {
    const retry = await generate(buildMarkerFixPrompt(input, baseSeq, imageAcquisitionSequence(variant.body)));
    if (retry.ok) {
      const retried = parseVariantOutput(retry.output, input.baseTitle);
      if (retried.body.length >= 300 && imageAcquisitionSequence(retried.body) === baseSeq) {
        return { status: "success", variant: retried, durationMs: Date.now() - startedAt };
      }
    }
    console.warn(
      `⚠️ [variant] 이미지 마커가 기준 원고와 다릅니다(기준 ${baseSeq} / 배리에이션 ${imageAcquisitionSequence(variant.body)}) - 재시도도 실패했습니다. 프롬프트 짝이 밀려 이미지가 엉뚱하게 붙을 수 있습니다.`
    );
  }

  return { status: "success", variant, durationMs: Date.now() - startedAt };
}
