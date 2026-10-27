// Korea Plain 리브랜딩(2026-10-28): 기존 글·고정 페이지에 남은 옛 이름(The Korea Manual)을 새 이름으로 바꾸는 순수 변환.
// 실행은 tkmRebrandCli.ts(Blogger API), 수동 실행은 .github/workflows/tkm-rebrand.yml.
//
// 왜 필요한가: thekoreamanual.com이 같은 이름·같은 주제의 제3자 사이트라 브랜드가 충돌한다. 주소(thekoreamanual.blogspot.com)
// 는 도메인 전환 때 한 번에 바꾸고, 이번에는 **이름·태그라인만** 바꾼다. 2026-10-28 실측(공개 페이지 46개):
//  - 글 40편: 옛 이름은 본문 JSON-LD의 author·publisher.name 두 군데뿐이고 읽히는 글자에는 0건.
//  - 고정 페이지: About(본문 3회 + 제목), Disclaimer 2회, Privacy Policy 1회, All Guides 1회. Contact·Editorial Policy 0회.
//  - 블로그 제목·설명·테마 헤더·피드 제목은 테마/설정이라 API로 못 바꾼다(UI 작업표: docs/ai-handoff/KOREA_PLAIN_REBRAND_2026-10.md).
//
// 바꾸는 것: (1) 스크립트 밖 HTML의 "The Korea Manual"/"Korea Manual"(주소·슬러그는 소문자·하이픈이라 걸리지 않는다)
// (2) tkm-jsonld 블록의 author·publisher(다른 칸은 그대로 - dateModified도 안 바꾼다, 이름 바꾸기는 글 수정이 아니다)
// (3) About 페이지만: 제목 "About Korea Plain", 맨 위 태그라인 한 줄, 첫 문장에 "(formerly The Korea Manual)".
// 변환 뒤 checkNameOnlyChange가 "옛 이름 -> 새 이름 + 허용한 삽입" 말고 다른 차이가 없음을 확인한다. 다시 돌려도 결과가 같다(멱등).

import { TKM_BRAND_NAME, TKM_BRAND_TAGLINE, TKM_FORMER_BRAND_NAME, tkmJsonLdBrand } from "./tkmPostStructure.js";

/** About 페이지 경로. 슬러그는 링크가 깨지지 않게 그대로 둔다(제목만 바뀐다). */
export const TKM_ABOUT_PATH = "/p/about-korea-manual.html";
export const TKM_ABOUT_TITLE = `About ${TKM_BRAND_NAME}`;
const FORMERLY = ` (formerly ${TKM_FORMER_BRAND_NAME})`;
/** About 맨 위에 넣는 태그라인 문단. */
export const TKM_ABOUT_TAGLINE_HTML = `<p><b>${TKM_BRAND_TAGLINE}.</b></p>`;

// "formerly The Korea Manual"은 일부러 남긴 옛 이름이라 건너뛴다(멱등). "The " 없이 쓴 경우도 잡는다.
const FORMER_NAME_RE = /(?<!formerly (?:The )?)(?:[Tt]he )?Korea Manual\b/g;
const SCRIPT_RE = /<script\b[\s\S]*?<\/script>/gi;
const JSONLD_RE = /(<script\b[^>]*\btkm-jsonld\b[^>]*>)([\s\S]*?)(<\/script>)/gi;

/** 스크립트 밖에서 옛 이름 개수. */
export function countFormerName(html: string): number {
  return (html.replace(SCRIPT_RE, "").match(FORMER_NAME_RE) ?? []).length;
}

/** 스크립트 밖의 옛 이름을 새 이름으로. 스크립트(JSON-LD 포함)는 글자 하나 건드리지 않는다. */
export function replaceFormerName(text: string): string {
  let out = "";
  let last = 0;
  for (const match of text.matchAll(SCRIPT_RE)) {
    out += text.slice(last, match.index).replace(FORMER_NAME_RE, TKM_BRAND_NAME) + match[0];
    last = match.index! + match[0].length;
  }
  return out + text.slice(last).replace(FORMER_NAME_RE, TKM_BRAND_NAME);
}

function parseJsonLd(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function originOf(url: unknown): string | null {
  try {
    return typeof url === "string" ? new URL(url).origin : null;
  } catch {
    return null;
  }
}

/**
 * tkm-jsonld 블록의 author·publisher를 새 브랜드로 갈아 끼운다. 나머지 칸·순서는 그대로 두고 buildJsonLdHtml과 같은 방식
 * (`<` 이스케이프)으로 다시 쓴다. 이미 새 브랜드면 그 블록은 원문 그대로 둔다. 파싱이 안 되는 블록은 건드리지 않고 센다.
 */
export function rebrandJsonLd(html: string): { html: string; changed: number; unparsable: number } {
  let changed = 0;
  let unparsable = 0;
  const next = html.replace(JSONLD_RE, (whole, open: string, raw: string, close: string) => {
    const data = parseJsonLd(raw);
    if (!data) {
      unparsable += 1;
      return whole;
    }
    const { author, publisher } = tkmJsonLdBrand(originOf(data.url));
    if (JSON.stringify(data.author) === JSON.stringify(author) && JSON.stringify(data.publisher) === JSON.stringify(publisher)) return whole;
    changed += 1;
    const updated = { ...data, author, publisher };
    return `${open}${JSON.stringify(updated).replace(/</g, "\\u003c")}${close}`;
  });
  return { html: next, changed, unparsable };
}

/**
 * About 본문: 이름을 바꾼 뒤 첫 "Korea Plain is"에 "(formerly The Korea Manual)"를 붙이고 맨 위에 태그라인 문단을 넣는다.
 * 이미 들어가 있으면 다시 넣지 않는다.
 */
export function rebrandAboutHtml(html: string): string {
  let body = replaceFormerName(html);
  if (!body.includes(FORMERLY.trim())) body = body.replace(`${TKM_BRAND_NAME} is `, `${TKM_BRAND_NAME}${FORMERLY} is `);
  if (!body.includes(TKM_ABOUT_TAGLINE_HTML)) body = `${TKM_ABOUT_TAGLINE_HTML}${body}`;
  return body;
}

/** About에서만 허용하는 삽입(검증용). */
export const TKM_ABOUT_INSERTIONS = [TKM_ABOUT_TAGLINE_HTML, FORMERLY];

export type NameOnlyCheck = { ok: true } | { ok: false; reason: string };

function withoutJsonLd(html: string): { rest: string; blocks: Array<Record<string, unknown> | null> } {
  const blocks: Array<Record<string, unknown> | null> = [];
  const rest = html.replace(JSONLD_RE, (_whole, _open: string, raw: string) => {
    blocks.push(parseJsonLd(raw));
    return "\u0000JSONLD\u0000";
  });
  return { rest, blocks };
}

function omitBrand(data: Record<string, unknown> | null): string {
  if (!data) return "null";
  const { author: _author, publisher: _publisher, ...rest } = data;
  return JSON.stringify(rest);
}

/**
 * 변환 전후 차이가 "이름 치환 + 허용 삽입"뿐인지. JSON-LD는 author·publisher 말고 모든 칸이 같아야 하고, 바뀐 쪽은 새 이름이어야 한다.
 * 그 밖의 HTML은 `replaceFormerName(전)` == `후 - 허용 삽입`이어야 한다(문자 단위로 같음).
 */
export function checkNameOnlyChange(before: string, after: string, insertions: readonly string[] = []): NameOnlyCheck {
  const b = withoutJsonLd(before);
  const a = withoutJsonLd(after);
  if (b.blocks.length !== a.blocks.length) return { ok: false, reason: `JSON-LD 블록 수가 다름 (${b.blocks.length} -> ${a.blocks.length})` };
  for (let i = 0; i < b.blocks.length; i += 1) {
    if (omitBrand(b.blocks[i]) !== omitBrand(a.blocks[i])) return { ok: false, reason: `JSON-LD ${i + 1}번째 블록에서 이름 외 칸이 바뀜` };
    const next = a.blocks[i] as { author?: { name?: unknown }; publisher?: { name?: unknown } } | null;
    if (next && (next.author?.name !== TKM_BRAND_NAME || next.publisher?.name !== TKM_BRAND_NAME)) {
      return { ok: false, reason: `JSON-LD ${i + 1}번째 블록의 author/publisher 이름이 ${TKM_BRAND_NAME}이 아님` };
    }
  }
  // 삽입은 양쪽에서 걷는다 - 이미 바꾼 페이지를 다시 돌릴 때(멱등) 전 본문에도 들어 있다.
  const drop = (html: string) => insertions.reduce((acc, insertion) => acc.split(insertion).join(""), html);
  const rest = drop(a.rest);
  const expected = drop(replaceFormerName(b.rest));
  if (rest !== expected) {
    let at = 0;
    while (at < rest.length && rest[at] === expected[at]) at += 1;
    return { ok: false, reason: `본문 HTML이 이름 치환 결과와 다름 (위치 ${at}: "${expected.slice(at, at + 40)}" vs "${rest.slice(at, at + 40)}")` };
  }
  return { ok: true };
}

export type RebrandResult = {
  html: string;
  title: string;
  /** 스크립트 밖에서 바꾼 옛 이름 수. */
  textReplacements: number;
  /** author·publisher를 바꾼 JSON-LD 블록 수. */
  jsonLdBlocks: number;
  unparsableJsonLd: number;
  titleChanged: boolean;
  changed: boolean;
  check: NameOnlyCheck;
};

/** 글·페이지 하나를 바꾼다. path가 About이면 About 규칙(제목·태그라인·formerly)을 쓴다. */
export function rebrandTkmHtml(input: { path: string; title: string; html: string }): RebrandResult {
  const isAbout = input.path === TKM_ABOUT_PATH;
  const textReplacements = countFormerName(input.html);
  const renamed = isAbout ? rebrandAboutHtml(input.html) : replaceFormerName(input.html);
  const jsonLd = rebrandJsonLd(renamed);
  const title = isAbout ? TKM_ABOUT_TITLE : replaceFormerName(input.title);
  return {
    html: jsonLd.html,
    title,
    textReplacements,
    jsonLdBlocks: jsonLd.changed,
    unparsableJsonLd: jsonLd.unparsable,
    titleChanged: title !== input.title,
    changed: jsonLd.html !== input.html || title !== input.title,
    check: checkNameOnlyChange(input.html, jsonLd.html, isAbout ? TKM_ABOUT_INSERTIONS : []),
  };
}
