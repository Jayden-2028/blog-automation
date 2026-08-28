// official 등급 출처(정부·공공기관 도메인)에 한해 본문을 가져와 SourceRow.content를 보강한다.
//
// 왜 official만인가(SPRINT_2_DESIGN.md 4-3·4-4절): 검색 API 스니펫은 한두 문장뿐이라 "2026 근로장려금
// 지급일이 9월 1일부터" 같은 핵심 정보가 잘려 나가곤 한다. hometax.go.kr 같은 공공 사이트가 검색에
// 잡히는데 스니펫만 쓰는 건 아깝다. 반면 언론사·블로그 본문은 저작권(로드맵 §6-1)·ToS·마크업
// 취약성 문제로 긁지 않는다.
//
// 도메인을 official 등급으로 제한했기 때문에 어떤 URL을 읽었는지가 sources.url에 그대로 남아 감사
// 가능성이 유지된다 - 원고 생성에 일반 웹 검색을 열지 않기로 한 이유(추적 불가)가 여기서는 적용되지 않는다.
//
// 실패는 이 단계 전체를 막지 않는다. fetch/파싱이 실패하면 원래 스니펫을 그대로 둔다(원문 없이도
// 검색 스니펫만으로 근거로는 쓸 수 있다) - "본문을 못 읽었다"가 "근거가 없다"가 되면 안 된다.

import { parse } from "node-html-parser";
import type { HTMLElement } from "node-html-parser";
import type { SourceInsert } from "../../types/database.js";

/** 본문 fetch 타임아웃. 정부 사이트는 응답이 느릴 수 있으나, 자료조사 전체를 오래 붙들면 안 된다. */
export const OFFICIAL_FETCH_TIMEOUT_MS = 10_000;

/** 본문 저장 상한. 팩트 카드 프롬프트에 그대로 들어가므로 무제한으로 두지 않는다. */
export const OFFICIAL_CONTENT_MAX_CHARS = 3_000;

// 본문일 가능성이 높은 컨테이너. 앞에서부터 먼저 잡히는 것을 쓴다.
const MAIN_CONTENT_SELECTORS = ["main", "article", "#content", "#container", ".content", "#contents"] as const;

// 본문이 아닌 것이 확실한 영역. 제거하지 않으면 메뉴 텍스트가 본문 앞을 다 차지한다.
const CHROME_SELECTORS = "script, style, noscript, nav, header, footer, aside, form, iframe, .gnb, .lnb, .snb, #gnb, #header, #footer, .breadcrumb, .skip";

/**
 * 텍스트가 "읽을 만한 산문"인지 판정한다.
 *
 * 왜 필요한가(2026-08-27 실측): kh.or.kr에서 뽑아온 3,000자가 전부 네비게이션 메뉴였다
 * ("경복궁 / 창덕궁 / 덕수궁 / 종묘 / ..."). 길이만 보면 통과하지만 사실이 하나도 없다.
 * 메뉴는 짧은 토막의 나열이므로, 일정 길이 이상의 "문장"이 있는지로 구분한다.
 */
export function looksLikeProse(text: string): boolean {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return false;

  // 40자 이상인 줄이 하나라도 있으면 문장이 있다고 본다. 메뉴 항목은 대부분 20자 미만이다.
  const longLines = lines.filter((line) => line.length >= 40);
  if (longLines.length === 0) return false;

  // 긴 줄들이 전체의 최소 15%는 차지해야 한다 - 메뉴 사이에 긴 줄 하나가 끼어든 경우를 걸러낸다.
  const longChars = longLines.reduce((sum, line) => sum + line.length, 0);
  return longChars / text.length >= 0.15;
}

function cleanText(element: HTMLElement): string {
  return element.text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * HTML에서 본문 텍스트를 추출한다. 네비게이션·헤더·푸터를 먼저 제거하고, 본문 컨테이너가 있으면
 * 그 안만 읽는다. 어느 후보도 산문으로 보이지 않으면 body 전체를 폴백으로 쓴다(판정을 완전히
 * 포기하는 것보다 낫다 - 최종 채택 여부는 호출자가 looksLikeProse로 다시 본다).
 */
export function extractReadableText(html: string): string {
  const root = parse(html);
  root.querySelectorAll(CHROME_SELECTORS).forEach((el) => el.remove());

  for (const selector of MAIN_CONTENT_SELECTORS) {
    const candidate = root.querySelector(selector);
    if (!candidate) continue;
    const text = cleanText(candidate);
    if (looksLikeProse(text)) return text;
  }

  return cleanText(root);
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; blog-automation-research/1.0)" },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * fetch한 본문을 채택할지 판정한다.
 *
 * 스니펫을 덮어쓰는 것이 항상 이득은 아니다(2026-08-27 실측): fetch 결과가 메뉴 텍스트면 원래
 * 스니펫에 있던 정보까지 사라진다. 산문으로 보이고 스니펫보다 실제로 길 때만 교체한다.
 */
export function shouldReplaceSnippet(fetched: string, snippet: string | null | undefined): boolean {
  if (!fetched) return false;
  if (!looksLikeProse(fetched)) return false;
  return fetched.length > (snippet?.length ?? 0);
}

export type EnrichOfficialSourcesResult = {
  sources: SourceInsert[];
  /** 본문으로 교체된 건수. 알림·로그에서 "공공 N건"의 실제 충실도를 판단하는 데 쓴다. */
  enrichedCount: number;
  /** fetch는 했으나 산문이 아니라 스니펫을 유지한 건수. */
  rejectedCount: number;
};

/**
 * official 등급 source의 content를 실제 페이지 본문으로 보강한다(채택 가능한 경우에만).
 * 입력 배열을 변경하지 않고 새 배열을 반환한다.
 */
export async function enrichOfficialSources(sources: SourceInsert[]): Promise<EnrichOfficialSourcesResult> {
  const enriched: SourceInsert[] = [];
  let enrichedCount = 0;
  let rejectedCount = 0;

  for (const source of sources) {
    // 신뢰: 호출자(collectSourcesForJob)가 이미 authority를 판정해 넣어뒀다고 가정한다. 여기서
    // 다시 판정하지 않는 이유는 등급 규칙이 config/sourceAuthorityRules.ts 한 곳에만 있어야 하기
    // 때문이다 - 두 곳에서 각자 판정하면 규칙이 갈라질 때 조용히 어긋난다.
    if (source.authority !== "official" || !source.url) {
      enriched.push(source);
      continue;
    }

    try {
      const html = await fetchWithTimeout(source.url, OFFICIAL_FETCH_TIMEOUT_MS);
      const text = extractReadableText(html);

      if (!shouldReplaceSnippet(text, source.content)) {
        rejectedCount++;
        console.warn(
          `ℹ️ enrichOfficialSources: "${source.url}" 본문이 산문으로 보이지 않아 스니펫을 유지합니다 ` +
            `(추출 ${text.length}자).`
        );
        enriched.push(source);
        continue;
      }

      enrichedCount++;
      enriched.push({ ...source, content: text.slice(0, OFFICIAL_CONTENT_MAX_CHARS) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`⚠️ enrichOfficialSources: "${source.url}" 본문 fetch 실패 (스니펫 유지) -`, message);
      enriched.push(source);
    }
  }

  return { sources: enriched, enrichedCount, rejectedCount };
}
