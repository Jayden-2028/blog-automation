// 네이버 발행본 수집: RSS 목록 파싱 + 모바일 글 HTML에서 본문 문단 추출.
// 이미지 캡션(.se-image)·"함께 보면 좋은 글" 이하(링크 카드)·해시태그 줄은 비교 대상에서 뺀다.
import { parse } from "node-html-parser";

import { kstDate } from "./text.js";

export type RssPost = { logNo: string; title: string; link: string; publishedAt: string; publishedDate: string; category: string | null };

export type PostParagraph = { text: string; heading: boolean };
export type NaverPost = { title: string; paragraphs: PostParagraph[] };

const decode = (s: string) =>
  s.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").trim();

/** RSS XML -> 글 목록(최신순 그대로). logNo를 못 읽는 항목은 건너뛴다. */
export function parseNaverRss(xml: string): RssPost[] {
  const out: RssPost[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const item = m[1] ?? "";
    const pick = (tag: string) => decode(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(item)?.[1] ?? "");
    const link = pick("link");
    const logNo = /\/(\d{6,})/.exec(link)?.[1];
    const pub = new Date(pick("pubDate"));
    if (!logNo || Number.isNaN(pub.getTime())) continue;
    out.push({ logNo, title: pick("title"), link, publishedAt: pub.toISOString(), publishedDate: kstDate(pub), category: pick("category") || null });
  }
  return out;
}

const SKIP_COMPONENT = /se-(image|video|oglink|horizontalLine|sticker|map|materialMedia|imageStrip|oembed|quotation)\b/;
const HASHTAG_ONLY = /^(#[^\s#]+\s*)+$/;
const RELATED_MARK = /^함께 보면 좋은 글$/;

/** `se-fs-fs19`·`se-fs19` 같은 클래스에서 글자 크기를 읽는다(없으면 0). */
function fontSizeOf(cls: string): number {
  const m = /\bse-fs-?(?:fs)?(\d+)\b/.exec(cls);
  return m ? Number(m[1]) : 0;
}

const clean = (s: string) => s.replace(/[​-‍﻿]/g, "").replace(/ /g, " ").replace(/[ \t]+/g, " ").trim();

/** 모바일 글 HTML -> 제목 + 본문 문단. 소제목(se-fs19 이상)은 heading으로 표시한다. */
export function extractNaverPost(html: string): NaverPost | null {
  const root = parse(html, { blockTextElements: { script: false, style: false, noscript: false } });
  const container = root.querySelector(".se-main-container");
  if (!container) return null;
  const rawTitle = root.querySelector(".se-title-text")?.text ?? root.querySelector("title")?.text ?? "";
  const title = clean(rawTitle.replace(/\s*:\s*네이버 블로그\s*$/, ""));

  const paragraphs: PostParagraph[] = [];
  for (const comp of container.querySelectorAll(".se-component")) {
    const cls = comp.getAttribute("class") ?? "";
    if (SKIP_COMPONENT.test(cls) || !/se-text\b/.test(cls)) continue;
    for (const p of comp.querySelectorAll(".se-text-paragraph")) {
      const heading = p.querySelectorAll("span").some((s) => fontSizeOf(s.getAttribute("class") ?? "") >= 19);
      const text = clean(p.text);
      if (!text) continue;
      if (RELATED_MARK.test(text)) return { title, paragraphs };
      if (HASHTAG_ONLY.test(text)) continue;
      paragraphs.push({ text, heading });
    }
  }
  return paragraphs.length > 0 ? { title, paragraphs } : null;
}
