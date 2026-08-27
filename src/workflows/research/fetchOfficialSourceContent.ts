// official 등급 출처(정부·공공기관 도메인)에 한해 본문을 가져와 SourceRow.content를 보강한다.
//
// 왜 official만인가(SPRINT_2_DESIGN.md 4-3·4-4절): 검색 API 스니펫은 한두 문장뿐이라 "2026 근로장려금
// 지급일이 9월 1일부터" 같은 핵심 정보가 잘려 나가곤 한다. hometax.go.kr 같은 공공 사이트가 검색에
// 잡히는데 스니펫만 쓰는 건 아깝다. 반면 언론사·블로그 본문은 저작권(로드맵 §6-1)·ToS·마크업
// 취약성 문제로 긁지 않는다(Creator Advisor 파서 하나 고치는 데도 상당한 시간이 들었다).
//
// 도메인을 official 등급(config/sourceAuthorityRules.ts의 접미사)으로 제한했기 때문에, 어떤 URL을
// 읽었는지가 sources.url에 그대로 남아 감사 가능성이 유지된다 - 원고 생성에 일반 웹 검색을 열지
// 않기로 한 이유(추적 불가)가 여기서는 적용되지 않는다.
//
// 실패는 이 단계 전체를 막지 않는다. fetch/파싱이 실패하면 원래 스니펫을 그대로 둔다(원문 없이도
// 검색 스니펫만으로 근거로는 쓸 수 있다) - "본문을 못 읽었다"가 "근거가 없다"가 되면 안 된다.

import { parse } from "node-html-parser";
import type { SourceInsert } from "../../types/database.js";

/** 본문 fetch 타임아웃. 정부 사이트는 응답이 느릴 수 있으나, 자료조사 전체를 오래 붙들면 안 된다. */
export const OFFICIAL_FETCH_TIMEOUT_MS = 10_000;

/** 본문 저장 상한. 팩트 카드 프롬프트에 그대로 들어가므로 무제한으로 두지 않는다. */
export const OFFICIAL_CONTENT_MAX_CHARS = 3_000;

/** HTML에서 안전하게 텍스트만 추출한다. script/style은 내용까지 제거해야 한다(태그만 벗기면 JS 코드가 섞인다). */
export function extractReadableText(html: string): string {
  const root = parse(html);
  root.querySelectorAll("script, style, noscript").forEach((el) => el.remove());
  return root.text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
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
 * official 등급 source의 content를 실제 페이지 본문으로 교체한다(가능한 경우에만).
 * 입력 배열을 변경하지 않고 새 배열을 반환한다.
 */
export async function enrichOfficialSources(sources: SourceInsert[]): Promise<SourceInsert[]> {
  const enriched: SourceInsert[] = [];

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

      if (!text) {
        enriched.push(source);
        continue;
      }

      enriched.push({ ...source, content: text.slice(0, OFFICIAL_CONTENT_MAX_CHARS) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`⚠️ enrichOfficialSources: "${source.url}" 본문 fetch 실패 (스니펫 유지) -`, message);
      enriched.push(source);
    }
  }

  return enriched;
}
