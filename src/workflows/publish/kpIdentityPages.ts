// Korea Plain 고정 페이지 로컬 정체성 반영(2026-10-30). 순수 변환만 - 네트워크·DB 없음.
// 실행은 kpIdentityPagesCli.ts(Blogger pages API).
//
// 근거 문서: branding-2026-10/kp-native-identity-2026-10.md §A-3(About 전문)·§A-4(Editorial Policy "Local review")·§A-6(Contact 첫 문단).
// 사용자가 2026-10-30에 Q1~Q10을 전부 권고대로 승인했다. 바꾸는 것은 **본문(+About 제목은 그대로)**뿐이고
// 슬러그·블로그 이름·태그라인·이메일 주소는 건드리지 않는다.
//
// 멱등: About는 목표 본문과 같으면 변경 없음, Editorial Policy는 "Local review" 절이 있으면 건너뜀,
// Contact는 첫 문단이 이미 개정 문구면 건너뜀. 세 경로 모두 두 번 돌려도 한 번 돌린 것과 같다.

/** 고정 페이지 경로(슬러그는 링크가 깨지지 않게 그대로 둔다). */
export const KP_ABOUT_PATH = "/p/about-korea-manual.html";
export const KP_EDITORIAL_PATH = "/p/editorial-policy.html";
export const KP_CONTACT_PATH = "/p/contact.html";

/** Blogger 편집기가 쓰는 빈 줄 문단(기존 페이지와 같은 모양). */
const GAP = "<p><br /></p>";

function paragraphs(...blocks: string[]): string {
  return blocks.join(GAP);
}

function list(items: readonly string[]): string {
  return `<ul>${items.map((item) => `<li>${item}</li>`).join("")}</ul>`;
}

/** About 전문(§A-3 완성본). 제목 "About Korea Plain"과 슬러그는 CLI가 그대로 둔다. */
export const KP_ABOUT_HTML = paragraphs(
  `<p><b>Korea, in plain English.</b></p>`,
  `<p>Korea Plain is a practical guide to everyday life in Korea, written in plain English by a Korean who was born and raised here and lives in Seoul.</p>`,
  `<p>Many Korea websites tell you where to go. This one explains what to do when you get there: which app to open, which button to look for, what information you need, what can go wrong, and what to try next. And because the writer is Korean, each guide also tells you what people here actually do &#8212; the unwritten habits that locals never think to explain, and the things visitors commonly get wrong.</p>`,
  `<p><b>What you get in every guide</b></p>`,
  list([
    "The answer first, then the steps, in the order you will meet them.",
    'A short "Local note" on how Koreans themselves handle it.',
    "The Korean words you will see on the sign, the menu, or the app screen, so you can recognize them.",
    "Prices, hours, and rules taken from official or first-party sources, with the date they were checked.",
  ]),
  `<p><b>What we cover</b></p>`,
  list([
    "Travel &amp; Transit &#8212; getting in, getting around, and what to do when an app or payment fails",
    "Food &amp; Dining &#8212; what to order, how to order it, and what you&#39;re actually eating",
    "Culture &amp; Etiquette &#8212; the unwritten rules, explained before you need them",
    "Living in Korea &#8212; paperwork, housing, banking, Korean apps, and everyday errands",
    "K-Wave Context &#8212; the background knowledge that makes K-pop, dramas, and webtoons make more sense",
  ]),
  `<p><b>What we don&#39;t do</b></p>`,
  `<p>We don&#39;t write travel diaries, and we don&#39;t invent stories. When a guide says "most people do this," it reflects common practice in Korea, not one person&#39;s day. We don&#39;t give legal, immigration, medical, tax, or financial advice, and we are not a government service.</p>`,
  `<p><b>Who runs this</b></p>`,
  `<p>Korea Plain is written and edited in Seoul by Jayden, a Korean. Research and drafting are assisted by AI tools; every guide is checked against the sources and reviewed by the editor before it is published. If something is out of date, or if you know a regional exception, tell us through the Contact page &#8212; we correct errors and note the change.</p>`,
  `<p>Company and product names belong to their respective owners.</p>`
);

/** Editorial Policy에 덧붙이는 절(§A-4). 기존 페이지의 절 제목은 굵게가 아니라 맨 문단이라 같은 모양으로 쓴다. */
export const KP_EDITORIAL_HEADING = "Local review";
export const KP_EDITORIAL_BLOCK = paragraphs(
  `<p>${KP_EDITORIAL_HEADING}</p>`,
  `<p>Every guide is written by a Korean who lives in Seoul and uses these services as a resident. Where a guide describes what people in Korea usually do &#8212; which door to board from, how to call staff, what to bring to a gu office &#8212; that description comes from everyday local practice, cross-checked against Korean-language sources: official notices, Korean community posts, and domestic news on rule changes. We label these passages as a "Local note" so you can tell practice from regulation. Where practice differs by city or neighborhood, we say so instead of generalizing.</p>`
);

/** Contact 첫 문단 교체본(§A-6). 이메일·정정 요청 항목·개인정보 주의·자문 불가 문단은 그대로 둔다. */
export const KP_CONTACT_FIRST_PARAGRAPH =
  `<p>Found an outdated step, a broken link, or a Korea question that deserves a proper guide? Write to us. ` +
  `If you live in Korea and know a local exception &#8212; a city that does it differently, a shop that changed its system &#8212; ` +
  `we especially want to hear it; that is exactly the kind of detail a guide written in Seoul can check.</p>`;
/** 교체했는지 알아보는 표식(멱등 판정). */
const CONTACT_MARKER = "we especially want to hear it";

export type PageEdit =
  | { changed: true; html: string; note: string }
  | { changed: false; html: string; note: string };

/** About: 본문 전체 교체. 이미 같으면 변경 없음. */
export function applyAboutIdentity(html: string): PageEdit {
  if (html.trim() === KP_ABOUT_HTML) return { changed: false, html, note: "이미 개정본" };
  return { changed: true, html: KP_ABOUT_HTML, note: "본문 전문 교체(§A-3)" };
}

/**
 * Editorial Policy: "Sources" 절(제목 문단 + 그 다음 본문 문단) 바로 뒤에 "Local review" 절을 끼운다.
 * 이미 있으면 건너뛰고, Sources 절을 못 찾으면 바꾸지 않는다(실패로 보고).
 */
export function applyEditorialLocalReview(html: string): PageEdit {
  if (new RegExp(`<p[^>]*>\\s*${KP_EDITORIAL_HEADING}\\s*</p>`, "i").test(html)) {
    return { changed: false, html, note: "이미 Local review 절 있음" };
  }
  // Sources 제목 문단 뒤 첫 본문 문단의 끝을 찾는다.
  const headingRe = /<p[^>]*>\s*Sources\s*<\/p>/i;
  const heading = headingRe.exec(html);
  if (!heading) return { changed: false, html, note: "Sources 절을 찾지 못함(건너뜀)" };
  const afterHeading = heading.index + heading[0].length;
  const bodyRe = /<p\b[^>]*>[\s\S]*?<\/p>/i;
  const body = bodyRe.exec(html.slice(afterHeading));
  if (!body) return { changed: false, html, note: "Sources 본문 문단을 찾지 못함(건너뜀)" };
  const at = afterHeading + body.index + body[0].length;
  return {
    changed: true,
    html: `${html.slice(0, at)}${GAP}${KP_EDITORIAL_BLOCK}${html.slice(at)}`,
    note: "Sources 절 뒤에 Local review 삽입(§A-4)",
  };
}

/** Contact: 첫 문단만 교체. 나머지(이메일·항목·주의·자문 불가)는 글자 하나 건드리지 않는다. */
export function applyContactLocalTone(html: string): PageEdit {
  if (html.includes(CONTACT_MARKER)) return { changed: false, html, note: "이미 개정본" };
  const first = /<p\b[^>]*>[\s\S]*?<\/p>/i.exec(html);
  if (!first) return { changed: false, html, note: "첫 문단을 찾지 못함(건너뜀)" };
  return {
    changed: true,
    html: `${html.slice(0, first.index)}${KP_CONTACT_FIRST_PARAGRAPH}${html.slice(first.index + first[0].length)}`,
    note: "첫 문단 교체(§A-6)",
  };
}

export type KpIdentityPage = { path: string; label: string; apply: (html: string) => PageEdit };

export const KP_IDENTITY_PAGES: readonly KpIdentityPage[] = [
  { path: KP_ABOUT_PATH, label: "About", apply: applyAboutIdentity },
  { path: KP_EDITORIAL_PATH, label: "Editorial Policy", apply: applyEditorialLocalReview },
  { path: KP_CONTACT_PATH, label: "Contact", apply: applyContactLocalTone },
];

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

/** 문단·목록 항목 단위로 읽히는 글자를 뽑는다(diff 출력용). */
export function pageLines(html: string): string[] {
  return [...html.matchAll(/<(p|li|h[1-6])\b[^>]*>([\s\S]*?)<\/\1>/gi)]
    .map((match) =>
      match[2]
        .replace(/<[^>]+>/g, "")
        .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(Number(dec)))
        .replace(/&([a-z]+);/gi, (whole, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? whole)
        .replace(/\s+/g, " ")
        .trim()
    )
    .filter((line) => line.length > 0);
}

/** 아주 작은 LCS diff. 돌려주는 줄은 "  유지" / "- 삭제" / "+ 추가". */
export function diffLines(before: readonly string[], after: readonly string[]): string[] {
  const table: number[][] = Array.from({ length: before.length + 1 }, () => new Array<number>(after.length + 1).fill(0));
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      table[i][j] = before[i] === after[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      out.push(`  ${before[i]}`);
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      out.push(`- ${before[i]}`);
      i += 1;
    } else {
      out.push(`+ ${after[j]}`);
      j += 1;
    }
  }
  for (; i < before.length; i += 1) out.push(`- ${before[i]}`);
  for (; j < after.length; j += 1) out.push(`+ ${after[j]}`);
  return out;
}
