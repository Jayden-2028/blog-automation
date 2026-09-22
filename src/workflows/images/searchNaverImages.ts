// 네이버 이미지 검색 API(API HUB `/search/v1/image`)로 후보 이미지를 모은다(2026-09-17 저녁).
//
// 왜 필요한가(사용자 지적): 지금까지 수집기는 에이전트가 web_search로 페이지를 뒤져 이미지 URL을
// **추정**하는 구조였다. 그래서 콜라주·이자카야 사진 같은 오답이 섞이고, 핫링크 차단으로 내려받기
// 실패가 잦았다. 사용자는 "구글 이미지 검색에서 고르기만 해도 된다"고 했다 - 그 경험을 만들려면
// 검색창에 친 결과를 후보로 받아 **그중에서 고르게** 해야 한다. 네이버 이미지 검색은 공식 API이고
// 이미 쓰는 API HUB 키로 호출되며, 직접 이미지 URL과 크기가 응답에 있어 다운로드 실패도 줄어든다.
//
// 이 모듈은 후보만 돌려준다. 고르는 판단(문단과 맞는가·출처 분류)은 collectWebImages의 에이전트가,
// 내려받기·검증·업로드는 Node가 그대로 한다.

import { NAVER_API_HUB_BASE_URL, naverGetJson, stripNaverMarkup } from "../../services/search/naver/naverClient.js";

const NAVER_IMAGE_SEARCH_URL = `${NAVER_API_HUB_BASE_URL}/search/v1/image`;
/** 후보 수. 너무 많으면 프롬프트만 길어지고 에이전트가 앞쪽만 본다. */
const DEFAULT_DISPLAY = 12;

export type ImageCandidate = {
  /** 검색 결과 제목(HTML 태그 제거). 출처 페이지를 짐작하는 유일한 단서다. */
  title: string;
  /** 이미지 파일 직접 URL. */
  link: string;
  thumbnail: string;
  width: number | null;
  height: number | null;
  /**
   * 그 사진이 실린 페이지. 네이버 응답에는 없어 null이고, 구글(Custom Search)은 contextLink로 준다
   * (2026-09-21). 검증 단계가 "이 인물이 맞는지"를 얼굴이 아니라 출처로 판단할 때 쓴다.
   */
  sourcePage?: string | null;
};

export type SearchImages = (query: string) => Promise<ImageCandidate[]>;

type NaverImageSearchResponse = {
  total?: number;
  items?: { title?: string; link?: string; thumbnail?: string; sizeheight?: string; sizewidth?: string }[];
};

/**
 * 실패하면 빈 배열이다. 후보가 없어도 에이전트는 web_search로 직접 찾을 수 있으므로 이 단계가
 * 수집 전체를 막아서는 안 된다.
 */
export async function searchNaverImages(query: string, display: number = DEFAULT_DISPLAY): Promise<ImageCandidate[]> {
  try {
    const body = await naverGetJson<NaverImageSearchResponse>(NAVER_IMAGE_SEARCH_URL, {
      params: { query, display, sort: "sim", filter: "large" },
    });
    return (body.items ?? [])
      .filter((item) => typeof item.link === "string" && /^https?:\/\//.test(item.link))
      .map((item) => ({
        title: stripNaverMarkup(item.title ?? ""),
        link: item.link as string,
        thumbnail: item.thumbnail ?? "",
        width: item.sizewidth ? Number(item.sizewidth) || null : null,
        height: item.sizeheight ? Number(item.sizeheight) || null : null,
      }));
  } catch (error) {
    console.warn(`⚠️ [images] 네이버 이미지 검색 실패("${query}"): ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}
