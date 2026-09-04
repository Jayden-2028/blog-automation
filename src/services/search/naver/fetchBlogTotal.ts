// 특정 검색어의 네이버 블로그 문서 "총 개수"(total)만 조회한다.
//
// NaverBlogKeywordProvider와 같은 endpoint를 쓰지만 목적이 다르다: 그쪽은 items(개별 문서)를 모아
// 후보를 만들고, 이쪽은 items를 버리고 total만 본다("이 주제로 이미 블로그 글이 몇 개나 있는가").
// 그래서 display=1로 호출해 응답 크기를 최소화한다.
//
// provider가 아니라 서비스 함수로 둔 이유: KeywordProvider 인터페이스(fetchKeywords -> RawKeyword[])와
// 반환 형태가 맞지 않고, 후보 수집이 아니라 채점 단계에서 쓰이기 때문이다.

import { NAVER_API_HUB_BASE_URL, naverGetJson } from "./naverClient.js";

const NAVER_BLOG_SEARCH_URL = `${NAVER_API_HUB_BASE_URL}/search/v1/blog`;

type NaverBlogTotalResponse = {
  total?: number;
};

/**
 * 검색어의 블로그 문서 총 개수. 조회 실패 시 예외를 던지지 않고 null을 반환한다 -
 * 경쟁도는 보조 신호이므로 한 건의 실패가 랭킹 파이프라인을 멈추면 안 된다(호출자가 실패를 집계한다).
 */
export async function fetchBlogDocumentTotal(query: string): Promise<number | null> {
  const trimmed = query.trim();
  if (!trimmed) return null;

  const body = await naverGetJson<NaverBlogTotalResponse>(NAVER_BLOG_SEARCH_URL, {
    params: { query: trimmed, display: 1, sort: "sim" },
  });

  return typeof body.total === "number" && Number.isFinite(body.total) ? body.total : null;
}
