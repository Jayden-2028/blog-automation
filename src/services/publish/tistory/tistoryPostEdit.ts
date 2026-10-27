// 발행된 티스토리 글을 **고치는** 데 쓰는 순수 함수들(2026-10-28). TistoryPublisher.editPost와 링크 치환 CLI
// (workflows/publish/tistoryFixLinksCli.ts)가 같이 쓴다 - Playwright를 import하지 않는다.
//
// 원칙(TISTORY_AUTO_PUBLISH_DESIGN.md "발행 후 수정"):
//   - 본문을 통째로 setContent 하지 않는다. 에디터에서 `a` 목록을 읽어 **Node에서** 바꿀 자리(번호·옛 값·새 값)를
//     정하고(EditPlan), 브라우저는 그 자리의 속성만 바꾼다.
//   - 바꾸기 전후 스냅샷을 비교해 "텍스트·이미지·링크 수는 같고 href만 계획한 만큼 바뀜"이 아니면 발행하지 않는다.
// 순수 함수 테스트: testTistoryPostEdit.ts

import { createHash } from "node:crypto";

import { decodeEntities } from "./tistoryPublishedUrl.js";

export type TistoryPostIdSource = "data-entry-id" | "entryId" | "link";

/** 에디터 본문의 `a` 하나를 바꾸는 계획. index는 `ed.dom.select("a")`의 순번, from은 바꾸기 전 href 그대로. */
export type HrefChange = { index: number; from: string; to: string };

export type EditPlan = {
  hrefChanges: HrefChange[];
  /** 바꿀 게 있어야 하는데 못 찾은 경우처럼 **발행하지 말아야** 할 때 사유를 적는다. */
  abort?: string;
};

/** 브라우저에서 읽어 온 그대로의 본문 상태. 해시는 Node에서 계산한다(snapshotFromRaw). */
export type RawEditorState = { text: string; images: number; hrefs: string[]; content: string };

export type EditorSnapshot = {
  textLength: number;
  textHash: string;
  images: number;
  anchors: number;
  /** `a` 순서대로의 href(getAttrib). */
  hrefs: string[];
  /** ed.getContent() 직렬화 결과에 실린 href - 저장되는 건 이쪽이다. */
  serializedHrefs: string[];
};

export type InvariantResult = { ok: true; changed: HrefChange[] } | { ok: false; reasons: string[] };

/** 공개 글 페이지 HTML에서 숫자 글 ID. data-entry-id → "entryId":N → `/<N>` 링크 순. 값이 둘 이상 갈리면 다음 규칙으로 넘어간다. */
export function extractTistoryPostId(html: string): { id: number; source: TistoryPostIdSource } | null {
  const unique = (values: string[]): number | null => {
    const set = new Set(values);
    return set.size === 1 ? Number([...set][0]) : null;
  };
  const byAttr = unique([...html.matchAll(/data-entry-id="(\d+)"/g)].map((m) => m[1]));
  if (byAttr) return { id: byAttr, source: "data-entry-id" };
  const byJson = unique([...html.matchAll(/"entryId"\s*:\s*(\d+)/g)].map((m) => m[1]));
  if (byJson) return { id: byJson, source: "entryId" };

  // `/<N>`·`/<N>#comment` 같은 링크 - 다른 글로 가는 링크도 섞이므로 가장 많이 나온 번호가 **홀로** 1등일 때만 쓴다.
  const counts = new Map<string, number>();
  for (const m of html.matchAll(/href="(?:https?:\/\/[^"/]+)?\/(\d+)(?:[#?][^"]*)?"/g)) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0 || (ranked[1] && ranked[1][1] === ranked[0][1])) return null;
  return { id: Number(ranked[0][0]), source: "link" };
}

export function tistoryEditUrl(blogName: string, postId: number): string {
  return `https://${blogName}.tistory.com/manage/newpost/${postId}?type=post`;
}

/** 공개 글 페이지의 og:title(없으면 <title>). 수정 화면이 맞는 글을 열었는지 대조한다. */
export function extractPageTitle(html: string): string | null {
  const raw =
    html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]*)"/i)?.[1] ??
    html.match(/<meta[^>]+content="([^"]*)"[^>]+property="og:title"/i)?.[1] ??
    html.match(/<title>([^<]*)<\/title>/i)?.[1];
  return raw ? decodeEntities(raw).trim() : null;
}

/** 퍼센트 인코딩을 풀 수 있는 조각만 푼다(`30%`처럼 날것의 %가 섞여도 죽지 않게). */
function decodePercentRuns(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text.replace(/(%[0-9A-Fa-f]{2})+/g, (seq) => {
      try {
        return decodeURIComponent(seq);
      } catch {
        return seq;
      }
    });
  }
}

/**
 * 비교용 href 키. 같은 주소의 인코딩 변형(퍼센트 인코딩/풀린 한글, `&amp;`, http/https, 끝 슬래시, #조각)을 같게 본다.
 * 상대 경로(`/entry/…`)는 host를 주면 그 블로그 주소로 본다.
 */
export function hrefKey(href: string, host?: string): string {
  let s = decodeEntities(href.trim()).replace(/#.*$/, "");
  if (host && s.startsWith("/")) s = `${host}${s}`;
  s = s.replace(/^https?:\/\//i, "");
  const slash = s.indexOf("/");
  const hostPart = (slash < 0 ? s : s.slice(0, slash)).toLowerCase();
  const pathPart = slash < 0 ? "" : s.slice(slash);
  return `${hostPart}${decodePercentRuns(pathPart).normalize("NFC")}`.replace(/\/+$/, "");
}

export type LinkPair = { from: string; to: string };

/** 에디터 `a` 목록(hrefs) 중 옛 주소와 키가 같은 것만 새 주소로 바꾸는 계획. 이미 새 주소인 것은 건드리지 않는다. */
export function planHrefReplacements(hrefs: readonly string[], pairs: readonly LinkPair[], host?: string): HrefChange[] {
  const byKey = new Map(pairs.map((pair) => [hrefKey(pair.from, host), pair.to]));
  const changes: HrefChange[] = [];
  hrefs.forEach((href, index) => {
    const to = byKey.get(hrefKey(href, host));
    if (to && hrefKey(to, host) !== hrefKey(href, host)) changes.push({ index, from: href, to });
  });
  return changes;
}

/** HTML 문자열의 `<a href>` 값(엔티티를 푼 그대로). 공개 페이지·직렬화 본문 검사에 쓴다. */
export function extractHrefs(html: string): string[] {
  return [...html.matchAll(/<a\b[^>]*?\shref\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)].map((m) => decodeEntities(m[1] ?? m[2] ?? ""));
}

/** 옛 주소 키들이 html의 링크에 몇 개 남았나. */
export function countLinksTo(html: string, urls: readonly string[], host?: string): number {
  const keys = new Set(urls.map((url) => hrefKey(url, host)));
  return extractHrefs(html).filter((href) => keys.has(hrefKey(href, host))).length;
}

export function snapshotFromRaw(raw: RawEditorState): EditorSnapshot {
  return {
    textLength: raw.text.length,
    textHash: createHash("sha256").update(raw.text).digest("hex").slice(0, 16),
    images: raw.images,
    anchors: raw.hrefs.length,
    hrefs: [...raw.hrefs],
    serializedHrefs: extractHrefs(raw.content),
  };
}

/**
 * 불변 검증: 텍스트(길이·해시)·이미지 수·링크 수가 같고, href는 계획한 자리만 계획한 값으로 바뀌었으며,
 * 직렬화 본문(저장되는 쪽)에도 옛 주소가 없고 새 주소가 있어야 통과다. 하나라도 어긋나면 발행하지 않는다.
 */
export function checkEditInvariants(before: EditorSnapshot, after: EditorSnapshot, plan: readonly HrefChange[], host?: string): InvariantResult {
  const reasons: string[] = [];
  if (plan.length === 0) reasons.push("바꿀 링크가 없습니다(계획 0건)");
  if (before.textLength !== after.textLength || before.textHash !== after.textHash) {
    reasons.push(`본문 텍스트가 달라졌습니다(길이 ${before.textLength}→${after.textLength}, 해시 ${before.textHash}→${after.textHash})`);
  }
  if (before.images !== after.images) reasons.push(`이미지 수가 달라졌습니다(${before.images}→${after.images})`);
  if (before.anchors !== after.anchors) reasons.push(`링크 수가 달라졌습니다(${before.anchors}→${after.anchors})`);
  if (before.serializedHrefs.length !== after.serializedHrefs.length) {
    reasons.push(`직렬화 본문의 링크 수가 달라졌습니다(${before.serializedHrefs.length}→${after.serializedHrefs.length})`);
  }

  const planned = new Map(plan.map((change) => [change.index, change]));
  const changed: HrefChange[] = [];
  const length = Math.max(before.hrefs.length, after.hrefs.length);
  for (let index = 0; index < length; index += 1) {
    const was = before.hrefs[index] ?? "";
    const now = after.hrefs[index] ?? "";
    const want = planned.get(index);
    if (want) {
      if (was !== want.from) reasons.push(`#${index} 바꾸기 전 값이 계획과 다릅니다`);
      if (hrefKey(now, host) !== hrefKey(want.to, host)) reasons.push(`#${index} href가 계획한 값으로 바뀌지 않았습니다(${now})`);
      else changed.push({ index, from: was, to: now });
    } else if (was !== now) {
      reasons.push(`#${index} 계획에 없는 href가 바뀌었습니다(${was} → ${now})`);
    }
  }

  const serializedKeys = new Set(after.serializedHrefs.map((href) => hrefKey(href, host)));
  for (const change of plan) {
    if (serializedKeys.has(hrefKey(change.from, host))) reasons.push(`직렬화 본문에 옛 주소가 남았습니다(${change.from})`);
    if (!serializedKeys.has(hrefKey(change.to, host))) reasons.push(`직렬화 본문에 새 주소가 없습니다(${change.to})`);
  }

  return reasons.length > 0 ? { ok: false, reasons } : { ok: true, changed };
}
