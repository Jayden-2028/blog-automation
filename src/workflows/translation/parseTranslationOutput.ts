// 번역 헤드리스 출력(구분자 형식)을 파싱하고 계약을 검증한다. 순수 함수 - 네트워크·DB 없음.
//
// 출력 형식(buildTranslationPrompt.ts가 모델에 요구한다):
//   <<<TITLE>>> ... <<<SEARCH_DESCRIPTION>>> ... <<<SLUG>>> ... <<<TAGS>>> ... <<<BODY>>> ... <<<KO_SUMMARY>>> ... <<<END>>>
//
// 검증이 중요한 이유: 영어 본문은 한글 원고와 **같은 이미지 마커를 같은 순서로** 가져야 한다. job.metadata.imagePrompts
// (한글 원고 순서로 저장된 검색어)가 번호로 마커에 짝지어지고, 획득 방식(웹 검색/AI 생성...)이 바뀌면 엉뚱한 경로로
// 이미지를 구한다. 마커가 어긋난 번역은 조용히 통과시키지 않고 실패로 돌려 한 번 더 시도한다.

import { parseImageAcquisition } from "../manuscripts/parseManuscriptBlocks.js";

export const TRANSLATION_SECTIONS = ["TITLE", "SEARCH_DESCRIPTION", "SLUG", "TAGS", "BODY", "KO_SUMMARY"] as const;
type SectionName = (typeof TRANSLATION_SECTIONS)[number];

export type ParsedTranslation = {
  title: string;
  searchDescription: string;
  slug: string | null;
  /** # 없이. */
  tags: string[];
  body: string;
  /** 문단별 한글 요지(불릿 한 줄씩). 재승인 때 영어본 옆에서 읽는다. */
  koSummary: string[];
};

const SECTION_RE = /^<<<([A-Z_]+)>>>\s*$/;

/** 구분자로 섹션을 나눈다. 모르는 구분자·빠진 구분자는 오류 목록으로 돌려준다(예외 아님). */
export function splitSections(output: string): { sections: Partial<Record<SectionName, string>>; errors: string[] } {
  const sections: Partial<Record<SectionName, string>> = {};
  const errors: string[] = [];
  let current: SectionName | null = null;
  let buffer: string[] = [];

  const flush = (): void => {
    if (current) sections[current] = buffer.join("\n").trim();
    buffer = [];
  };

  for (const line of output.replace(/\r\n/g, "\n").split("\n")) {
    const match = line.match(SECTION_RE);
    if (match) {
      flush();
      const name = match[1];
      if (name === "END") {
        current = null;
        break;
      }
      if ((TRANSLATION_SECTIONS as readonly string[]).includes(name)) {
        current = name as SectionName;
      } else {
        current = null;
        errors.push(`알 수 없는 구분자 <<<${name}>>>`);
      }
      continue;
    }
    if (current) buffer.push(line);
  }
  flush();

  for (const name of TRANSLATION_SECTIONS) {
    if (sections[name] === undefined) errors.push(`구분자 <<<${name}>>>가 없습니다`);
  }
  return { sections, errors };
}

const MARKER_LINE_RE = /^\[IMAGE:\s*([\s\S]*?)\]\s*$/;

/** 본문의 [IMAGE: ...] 마커 설명 목록(순서대로). */
export function imageMarkerDescriptions(body: string): string[] {
  return body
    .split("\n")
    .map((line) => line.trim().match(MARKER_LINE_RE))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => m[1].trim());
}

const HANGUL_RE = /[가-힣ㄱ-ㅎㅏ-ㅣ]/g;

/**
 * 영어 본문에 남은 한글 글자 수. 허용 자리는 뺀다:
 *  - 이미지 마커 줄(획득 방식 접미사 `— 웹 검색`이 한글로 남는다)
 *  - 괄호 안 한글(`jjimjilbang (찜질방)` - 표지판·메뉴에서 찾는 용도)
 *  - 마크다운 링크의 URL·인용부호 안 고유명사는 괄호/링크 텍스트로 들어오므로 링크 텍스트도 뺀다
 */
export function strayHangulCount(body: string): number {
  const kept = body
    .split("\n")
    .filter((line) => !MARKER_LINE_RE.test(line.trim()))
    .map((line) =>
      line
        .replace(/\[[^\]]*\]\([^)]*\)/g, " ") // 링크(텍스트+URL)
        .replace(/\([^()]*[가-힣][^()]*\)/g, " ") // 괄호 안 한글
        .replace(/`[^`]*`/g, " ")
    )
    .join("\n");
  return (kept.match(HANGUL_RE) ?? []).length;
}

/** 이 이상 남으면 번역이 덜 된 것으로 본다(고유명사 한두 개는 봐 준다). */
export const MAX_STRAY_HANGUL = 8;

export type TranslationValidationInput = {
  koreanBody: string;
  parsed: ParsedTranslation;
};

/** 계약 위반 목록. 비어 있으면 통과. */
export function validateTranslation({ koreanBody, parsed }: TranslationValidationInput): string[] {
  const errors: string[] = [];

  if (!parsed.title) errors.push("제목이 비었습니다");
  if (parsed.title.length > 120) errors.push(`제목이 너무 깁니다(${parsed.title.length}자)`);
  if (parsed.body.trim().length < 200) errors.push("영어 본문이 너무 짧습니다");
  if (parsed.koSummary.length === 0) errors.push("한글 대역 요약이 비었습니다");

  // 마커 개수·순서·획득 방식 보존
  const ko = imageMarkerDescriptions(koreanBody);
  const en = imageMarkerDescriptions(parsed.body);
  if (ko.length !== en.length) {
    errors.push(`이미지 마커 개수가 다릅니다(한글 ${ko.length}개 / 영어 ${en.length}개) - 마커를 추가·삭제·병합하지 마세요`);
  } else {
    ko.forEach((description, index) => {
      if (parseImageAcquisition(description) !== parseImageAcquisition(en[index])) {
        errors.push(`${index + 1}번 마커의 획득 방식이 바뀌었습니다("${description.slice(-12)}" -> "${en[index].slice(-12)}") - 접미사(— 웹 검색 등)는 그대로 두세요`);
      }
    });
  }

  const stray = strayHangulCount(parsed.body);
  if (stray > MAX_STRAY_HANGUL) errors.push(`영어 본문에 번역되지 않은 한글이 ${stray}자 남아 있습니다`);
  if (strayHangulCount(parsed.title) > 0) errors.push("영어 제목에 한글이 있습니다");

  // 링크 URL 보존(참고 자료). 한글 원고의 URL이 영어 본문에 없으면 누락이다.
  const urls = (text: string): string[] => [...text.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)].map((m) => m[1]);
  const enUrls = new Set(urls(parsed.body));
  const missing = urls(koreanBody).filter((url) => !enUrls.has(url));
  if (missing.length > 0) errors.push(`링크 ${missing.length}개가 누락됐습니다(예: ${missing[0]})`);

  return errors;
}

function parseTags(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/[,\n]/)
        .map((tag) => tag.trim().replace(/^#/, "").replace(/\s+/g, ""))
        .filter(Boolean)
    ),
  ];
}

function parseSlug(raw: string): string | null {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 80);
  return slug || null;
}

function parseSummary(raw: string): string[] {
  return raw
    .split("\n")
    .map((line) => line.trim().replace(/^[-*•]\s*/, "").replace(/^\d+[.)]\s*/, ""))
    .filter(Boolean);
}

export type ParseTranslationResult = { ok: true; parsed: ParsedTranslation } | { ok: false; errors: string[] };

export function parseTranslationOutput(output: string): ParseTranslationResult {
  const { sections, errors } = splitSections(output);
  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    parsed: {
      title: (sections.TITLE ?? "").replace(/^#+\s*/, "").replace(/^["“]|["”]$/g, "").trim(),
      searchDescription: (sections.SEARCH_DESCRIPTION ?? "").replace(/\s+/g, " ").trim(),
      slug: parseSlug(sections.SLUG ?? ""),
      tags: parseTags(sections.TAGS ?? ""),
      body: (sections.BODY ?? "").trim(),
      koSummary: parseSummary(sections.KO_SUMMARY ?? ""),
    },
  };
}
