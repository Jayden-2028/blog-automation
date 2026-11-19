// Gemini grounding 출처 URL을 **실제 주소로 되돌린다**(2026-10-30 실측 수정).
//
// 왜 필요한가: `groundingMetadata.groundingChunks[].web.uri`는 사이트 주소가 아니라 구글의
// 리디렉션 주소다 - `https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQ...`.
// 반면 Gemini가 조사 파일 본문에 적는 `· 출처:`는 실제 주소(`https://www.korea.kr/news/...`)다.
// enforceGeminiGroundingUrls는 이 둘을 글자 그대로 비교했으므로 **영영 일치할 수 없었고**,
// grounding된 official 항목까지 전부 community로 강등돼 verdict가 thin으로 떨어졌다
// (2026-10-30 실측: "한국 전국 10대 도시 지역별 특산품" 1건에서 공식 출처 10건 전부 강등,
// 강등된 URL 3개를 직접 열어 보니 모두 정상 200 응답의 실제 공식 페이지였다).
//
// 그래서 강제 검증 **전에** 리디렉션을 풀어 최종 주소를 얻는다. 리디렉션이 풀리지 않은 출처는
// 도메인만이라도 남겨 두고(`web.title`이 사이트 도메인을 담고 있다), enforce 쪽에서 "경로가 있는
// URL에 한해" 도메인 단위로 인정한다 - 2026-09-03에 막으려던 실패(최상위 도메인만 적고 인용문을
// 지어내는 것)는 그대로 막힌다.
//
// 네트워크만 쓰는 얇은 모듈이고 fetch를 주입할 수 있어 테스트는 네트워크 없이 돈다.

import type { GeminiGroundingSource } from "./runGeminiResearch.js";

/** 구글 grounding 리디렉션 주소인가. */
export function isGroundingRedirect(url: string): boolean {
  return /^https?:\/\/vertexaisearch\.cloud\.google\.com\/grounding-api-redirect\//i.test(url);
}

/** 추적 파라미터만 걷어 내고 호스트·경로를 비교 가능한 형태로 맞춘다. */
export function normalizeUrl(raw: string): string {
  const trimmed = raw.trim().replace(/[),.]+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return trimmed.replace(/\/$/, "");
  }
  parsed.hash = "";
  const host = parsed.host.toLowerCase().replace(/^www\./, "");
  for (const key of [...parsed.searchParams.keys()]) {
    if (/^(utm_|fbclid|gclid|igshid|ref|from)/i.test(key)) parsed.searchParams.delete(key);
  }
  const path = parsed.pathname.replace(/\/$/, "");
  const query = parsed.searchParams.toString();
  return `${parsed.protocol}//${host}${path}${query ? `?${query}` : ""}`;
}

/** 비교용 호스트(소문자, www 제거). 파싱 실패하면 빈 문자열. */
export function hostOf(raw: string): string {
  try {
    return new URL(raw.trim().replace(/[),.]+$/, "")).host.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

export type ResolvedGrounding = {
  /** 리디렉션을 푼 최종 주소(정규화). 강제 검증의 1순위 근거다. */
  urls: Set<string>;
  /** 풀지 못한 출처의 도메인(web.title 또는 풀린 주소의 호스트). 경로가 있는 URL에만 쓰는 2순위 근거다. */
  domains: Set<string>;
  resolvedCount: number;
  unresolvedCount: number;
};

export type ResolveOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  concurrency?: number;
};

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_CONCURRENCY = 5;

/** 리디렉션 한 건을 따라가 최종 주소를 얻는다. 실패하면 null. */
async function resolveOne(url: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // HEAD를 거부하는 서버가 있어 실패하면 GET으로 한 번 더 시도한다.
    for (const method of ["HEAD", "GET"] as const) {
      try {
        const res = await fetchImpl(url, { method, redirect: "follow", signal: controller.signal });
        const final = res.url || null;
        if (final && !isGroundingRedirect(final)) return final;
      } catch {
        // 다음 method로
      }
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * grounding 출처 목록의 리디렉션을 모두 풀어 허용 URL·도메인 집합을 만든다.
 * 리디렉션이 아닌 주소(baseline 등)는 그대로 통과시킨다.
 */
export async function resolveGroundingUrls(
  sources: readonly GeminiGroundingSource[],
  options: ResolveOptions = {}
): Promise<ResolvedGrounding> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);

  const urls = new Set<string>();
  const domains = new Set<string>();
  let resolvedCount = 0;
  let unresolvedCount = 0;

  const queue = [...sources];
  const worker = async (): Promise<void> => {
    for (;;) {
      const source = queue.shift();
      if (!source) return;

      if (!isGroundingRedirect(source.url)) {
        urls.add(normalizeUrl(source.url));
        const host = hostOf(source.url);
        if (host) domains.add(host);
        resolvedCount++;
        continue;
      }

      const final = await resolveOne(source.url, fetchImpl, timeoutMs);
      if (final) {
        urls.add(normalizeUrl(final));
        const host = hostOf(final);
        if (host) domains.add(host);
        resolvedCount++;
        continue;
      }

      // 못 풀었다 - web.title에 담긴 사이트 도메인이라도 남긴다("korea.kr" 같은 값).
      unresolvedCount++;
      const titleHost = (source.title ?? "").trim().toLowerCase().replace(/^www\./, "");
      if (/^[a-z0-9.-]+\.[a-z]{2,}$/.test(titleHost)) domains.add(titleHost);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(sources.length, 1)) }, worker));

  return { urls, domains, resolvedCount, unresolvedCount };
}
