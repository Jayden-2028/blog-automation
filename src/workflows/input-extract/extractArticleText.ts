// 일반 블로그·뉴스 HTML -> { title, text }. 과욕 부리지 않는다(발주서 B-2): 알려진 본문 셀렉터 -> <article> -> 문단이 가장 많은
// 블록 순으로 시도하고, 모두 짧으면 빈 문자열을 돌려줘 호출자가 "붙여넣어 달라"로 넘어가게 한다.
import { parse } from "node-html-parser";
import type { HTMLElement } from "node-html-parser";

import { capUtf8 } from "../research/personSourcePack.js";

export const ARTICLE_TEXT_MAX_BYTES = 8 * 1024;
/** 이보다 짧은 추출은 본문으로 보지 않는다(메뉴·약관 조각을 본문으로 오인하지 않도록). */
export const MIN_ARTICLE_CHARS = 200;

const KNOWN_BODY_SELECTORS = [
  ".se-main-container", // 네이버 SmartEditor(블로그)
  ".entry-content", // 티스토리 기본 스킨
  ".article_view",
  ".tt_article_useless_p_margin",
  ".contents_style",
  "[itemprop=articleBody]",
  "#articleBody",
  "#article-view-content-div",
  "#newsct_article",
  ".article_body",
  ".news_end",
  "article",
];

const NOISE = "script,style,noscript,svg,iframe,nav,header,footer,aside,form,button,.ad,.ads,.advertisement,.comment,.comments,.related,.share,.sns,[class*=banner],[id*=banner]";

function clean(text: string): string {
  return text
    .replace(/ /g, " ")
    .replace(/[​-‍﻿]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function textOf(el: HTMLElement): string {
  return clean(el.structuredText);
}

/** 문서 제목: og:title -> <title>. 사이트명 꼬리(" : 블로그", " - 언론사")는 그대로 둔다(주제 추출은 사용자가 고친다). */
export function extractTitle(html: string): string | null {
  const root = parse(html);
  const og = root.querySelector('meta[property="og:title"]')?.getAttribute("content");
  const raw = og ?? root.querySelector("title")?.text;
  const t = clean(raw ?? "").replace(/\s+/g, " ");
  return t ? t.slice(0, 120) : null;
}

export function extractArticleText(html: string, maxBytes: number = ARTICLE_TEXT_MAX_BYTES): { title: string | null; text: string } {
  const title = extractTitle(html);
  const root = parse(html, { blockTextElements: { script: false, style: false, noscript: false } });
  root.querySelectorAll(NOISE).forEach((n) => n.remove());

  let text = "";
  for (const selector of KNOWN_BODY_SELECTORS) {
    const el = root.querySelector(selector);
    if (!el) continue;
    const t = textOf(el);
    if (t.length >= MIN_ARTICLE_CHARS) {
      text = t;
      break;
    }
  }

  if (!text) {
    // 휴리스틱: 자기 바로 아래 <p> 글자가 가장 많은 블록.
    let best: { el: HTMLElement; score: number } | null = null;
    for (const el of root.querySelectorAll("div,section,main")) {
      const score = el.children.filter((c) => c.tagName === "P").reduce((sum, p) => sum + p.text.trim().length, 0);
      if (score > (best?.score ?? 0)) best = { el, score };
    }
    if (best) {
      const t = textOf(best.el);
      if (t.length >= MIN_ARTICLE_CHARS) text = t;
    }
  }

  return { title, text: text ? capUtf8(text, maxBytes) : "" };
}
