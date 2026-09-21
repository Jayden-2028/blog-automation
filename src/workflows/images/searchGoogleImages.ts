// 구글 Custom Search JSON API(`searchType=image`)로 후보 이미지를 모은다(2026-09-21).
//
// 왜 네이버만으로 부족한가(사용자 지적): 네이버 이미지 검색은 **한국 색인**이라 해외 자료는 물론,
// 스포츠 현장 사진처럼 구글에는 수십 장 있는 것도 후보가 안 나오는 경우가 있다. 실측 반려 사례가
// 전부 "구글에서 검색하면 충분히 나오는데 자리가 비었다"였다(이현중 슛, 지창욱 톰포드 화보).
// 검색어를 아무리 다듬어도 **색인에 없는 사진은 못 찾는다** - 그래서 색인을 하나 더 붙인다.
//
// 네이버보다 나은 점이 하나 더 있다: `image.contextLink`로 **그 사진이 실린 페이지**를 같이 준다.
// 네이버는 제목만 줘서 출처를 짐작해야 했다. 2026-09-21에 "얼굴로 인물을 특정하지 말고 출처
// 페이지로 판단하라"는 규칙을 넣었는데, 그 판단에 쓸 근거가 여기서 나온다.
//
// 무료 한도는 하루 100건이다. 원고 1건에 자리 5개면 하루 20건까지 무료로 커버된다(현재 하루 3건).
// 한도를 넘거나 키가 없으면 **조용히 빈 배열**을 돌려준다 - 네이버 후보만으로 계속 돈다.

import type { ImageCandidate } from "./searchNaverImages.js";

const ENDPOINT = "https://www.googleapis.com/customsearch/v1";
/** 한 번에 받을 후보 수. API 상한이 10이다. */
const DISPLAY = 10;

type GoogleImageItem = {
  title?: string;
  link?: string;
  image?: { thumbnailLink?: string; width?: number; height?: number; contextLink?: string };
};

export function googleSearchConfigured(): boolean {
  return Boolean(process.env.GOOGLE_SEARCH_API_KEY && process.env.GOOGLE_SEARCH_ENGINE_ID);
}

export async function searchGoogleImages(
  query: string,
  options: { fetchImpl?: typeof fetch } = {}
): Promise<ImageCandidate[]> {
  const apiKey = process.env.GOOGLE_SEARCH_API_KEY;
  const engineId = process.env.GOOGLE_SEARCH_ENGINE_ID;
  const trimmed = query.trim();
  if (!apiKey || !engineId || !trimmed) return [];

  const url = new URL(ENDPOINT);
  url.searchParams.set("key", apiKey);
  url.searchParams.set("cx", engineId);
  url.searchParams.set("q", trimmed);
  url.searchParams.set("searchType", "image");
  url.searchParams.set("num", String(DISPLAY));
  // 한국 독자용 블로그다 - 한국 결과를 우선한다(네이버와 겹치되 색인이 달라 후보가 넓어진다).
  url.searchParams.set("gl", "kr");
  url.searchParams.set("hl", "ko");
  url.searchParams.set("safe", "active");
  // 큰 이미지를 우대한다. 최소 크기 검증(400px)에서 떨어지는 후보를 줄인다.
  url.searchParams.set("imgSize", "large");

  const fetchImpl = options.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(url.toString());
  } catch {
    // 네트워크 실패로 수집 전체를 멈추지 않는다 - 네이버 후보로 계속 간다.
    return [];
  }

  if (!res.ok) {
    // 429(한도 초과)·403(키 문제)도 여기로 온다. 조용히 비우고 네이버에 맡긴다.
    console.warn(`⚠️ 구글 이미지 검색 실패(${res.status}) - 네이버 후보만 사용합니다: "${trimmed}"`);
    return [];
  }

  const json = (await res.json().catch(() => ({}))) as { items?: GoogleImageItem[] };
  return (json.items ?? [])
    .filter((item): item is GoogleImageItem & { link: string } => typeof item.link === "string")
    .map((item) => ({
      title: item.title ?? "",
      link: item.link,
      thumbnail: item.image?.thumbnailLink ?? "",
      width: item.image?.width ?? null,
      height: item.image?.height ?? null,
      // 네이버에는 없는 값. 검증 단계가 "이 인물이 맞는지"를 출처로 판단할 때 쓴다.
      sourcePage: item.image?.contextLink ?? null,
    }));
}
