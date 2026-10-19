// 실환경 ExtractDeps 조립(클라우드 웹훅 CLI와 맥 폴링 봇이 공유). 키는 env에서만 읽고 로그에 남기지 않는다.
import { NAVER_API_HUB_BASE_URL, naverGetJson, stripNaverMarkup } from "../../services/search/naver/naverClient.js";
import type { ExtractDeps, NewsSearchItem } from "./extractLinkSource.js";

type NaverNewsResponse = { items?: Array<{ title: string; description: string; link: string; originallink: string }> };

/** 네이버 뉴스 검색 API(기존 키). 제목으로 같은 기사의 언론사 원문 링크(originallink)를 찾는 데 쓴다. */
export async function searchNaverNews(query: string): Promise<NewsSearchItem[]> {
  const body = await naverGetJson<NaverNewsResponse>(`${NAVER_API_HUB_BASE_URL}/search/v1/news`, {
    params: { query, display: 30, sort: "sim" },
  });
  return (body.items ?? []).map((i) => ({
    title: stripNaverMarkup(i.title),
    description: stripNaverMarkup(i.description),
    link: i.link,
    originallink: i.originallink,
  }));
}

export function createExtractDeps(env: Record<string, string | undefined> = process.env): ExtractDeps {
  return {
    fetchImpl: (url, init) => fetch(url, init),
    // 네이버 키가 없으면 검색 의존 경로(네이버 뉴스)만 붙여넣기 안내로 떨어진다(비치명).
    ...(env.NAVER_CLIENT_ID && env.NAVER_CLIENT_SECRET ? { searchNews: searchNaverNews } : {}),
    youtubeApiKey: env.YOUTUBE_API_KEY?.trim() || null,
  };
}
