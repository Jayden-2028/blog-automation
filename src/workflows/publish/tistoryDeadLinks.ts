// 2026-10-27 사건의 옛(404) 티스토리 주소 → 새 주소 치환 도구(순수 함수, 2026-10-28). 링크 치환 CLI(tistoryFixLinksCli.ts)가 쓴다.
// 옛→새 18쌍은 교정 CLI가 남긴 픽스처(services/publish/tistory/fixtures/tistoryUrlAudit-2026-10-27.json)가 원본이다.
// 순수 함수 테스트: testTistoryDeadLinks.ts

import { readFileSync } from "node:fs";

import { hrefKey, type LinkPair } from "../../services/publish/tistory/tistoryPostEdit.js";

export type DeadLinkPair = LinkPair & { publicationId: number };

export type ContentLinkFix = { from: string; to: string; count: number };

export const DEAD_LINK_FIXTURE_URL = new URL("../../services/publish/tistory/fixtures/tistoryUrlAudit-2026-10-27.json", import.meta.url);

export function loadDeadLinkPairs(fixtureUrl: URL = DEAD_LINK_FIXTURE_URL): DeadLinkPair[] {
  const rows = JSON.parse(readFileSync(fixtureUrl, "utf-8")) as Array<{ id: number; stored: string; fix: string }>;
  return rows.map((row) => ({ publicationId: row.id, from: row.stored, to: row.fix }));
}

/**
 * 본문(마크다운/HTML) 속 티스토리 글 주소 토큰. 옛 주소에 날것의 `'`·`?`가 들어간 것이 있어(id 257·253) 그 둘은 주소의 일부로 본다.
 * 끝은 공백·`)`·`]`·`"`·`<`·`>`에서 끊는다(마크다운 링크 `[..](url)`·HTML 속성 모두).
 */
function entryUrlPattern(host: string): RegExp {
  return new RegExp(`(?:https?://)?${host.replace(/\./g, "\\.")}/entry/[^\\s)\\]"<>]+`, "g");
}

/**
 * articles.content의 옛 주소를 새 주소로 바꾼다. 인코딩 변형(퍼센트/풀린 한글)도 같은 주소로 본다(hrefKey).
 * 이미 새 주소인 링크는 그대로 - 다시 돌려도 결과가 같다(멱등).
 */
export function replaceDeadLinksInContent(
  content: string,
  pairs: readonly LinkPair[],
  host: string
): { content: string; fixes: ContentLinkFix[] } {
  const byKey = new Map(pairs.map((pair) => [hrefKey(pair.from, host), pair]));
  const counts = new Map<string, ContentLinkFix>();
  const next = content.replace(entryUrlPattern(host), (token) => {
    const pair = byKey.get(hrefKey(token, host));
    if (!pair) return token;
    const fix = counts.get(pair.from) ?? { from: pair.from, to: pair.to, count: 0 };
    fix.count += 1;
    counts.set(pair.from, fix);
    return pair.to;
  });
  return { content: next, fixes: [...counts.values()] };
}

/** 옛 주소가 본문에 몇 개 있나(치환 없이 세기만). */
export function countDeadLinksInContent(content: string, pairs: readonly LinkPair[], host: string): number {
  return replaceDeadLinksInContent(content, pairs, host).fixes.reduce((sum, fix) => sum + fix.count, 0);
}
