// 한국관광공사 관광사진 정보 API(공공데이터포털 data.go.kr/data/15101914, "한국관광공사_관광사진 정보_GW") 클라이언트(2026-11-25).
//
// 왜 이 출처인가: Korea Plain(koreaplain) 음식 글의 실제 사진 1순위다. **전 콘텐츠가 공공누리 제1유형**이라 출처를 표시하면
// 상업적 이용·변형(크롭·톤 보정)이 된다. 이미지 파일은 tong.visitkorea.or.kr에 있어 기존 화이트리스트(visitkorea.or.kr 하위)
// 안이다(workflows/images/koreaplainImageSources.ts).
//
// 실측(2026-11-25): `gallerySearchList1`에 한글 keyword - 닭갈비 82건, 나주곰탕 3건, 충무김밥 12건.
//
// 키(`KTO_SERVICE_KEY`)
//   - GitHub secret으로 넣는다. 포털이 주는 키는 **URL 인코딩된 형태**(Encoding 키)와 원문(Decoding 키) 두 가지라 어느 쪽이
//     와도 되게, `%`가 있으면 한 번 풀고 URLSearchParams로 **한 번만** 인코딩한다(두 번 인코딩되면 SERVICE_KEY_IS_NOT_REGISTERED).
//   - 없으면 이 출처를 **조용히 건너뛴다**(비치명) - 기존 웹 검색 경로가 그대로 돈다.
//   - **키와 전체 요청 URL을 로그·오류 문구에 남기지 않는다.** 이 저장소는 공개다. 오류 문구는 키워드와 상태만 적는다.
//
// 트래픽: 개발계정 하루 1,000건. 원고당 호출 상한은 호출부(collectKtoPhotos.ts)가 지킨다.

export const KTO_GALLERY_SEARCH_ENDPOINT = "https://apis.data.go.kr/B551011/PhotoGalleryService1/gallerySearchList1";
/** 출처 표기·뷰어 "출처" 링크로 쓰는 데이터셋 페이지(공공데이터포털). `.go.kr`이라 화이트리스트 안이다. */
export const KTO_DATASET_PAGE = "https://www.data.go.kr/data/15101914/openapi.do";
export const KTO_MOBILE_APP = "KoreaPlain";
/** 한 번에 받는 결과 수. 닭갈비가 82건이라 한 페이지면 충분하다. */
export const KTO_DEFAULT_ROWS = 50;
const REQUEST_TIMEOUT_MS = 15_000;

export type KtoPhoto = {
  contentId: string;
  title: string;
  imageUrl: string;
  location: string;
  photographer: string;
  /** 쉼표로 이어진 검색 키워드(원문 그대로). */
  searchKeywords: string;
  /** YYYYMM. 없으면 빈 문자열. */
  photographyMonth: string;
};

export type KtoSearchResult = { ok: true; photos: KtoPhoto[]; totalCount: number } | { ok: false; error: string };
export type KtoSearch = (keyword: string) => Promise<KtoSearchResult>;

/**
 * 환경변수의 키를 API에 넣을 원문으로 정리한다. 비면 null.
 * `%`가 있으면 Encoding 키로 보고 한 번 푼다 - 풀다가 깨지면(잘못된 % 시퀀스) 원문 그대로 둔다.
 */
export function normalizeServiceKey(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  if (!trimmed.includes("%")) return trimmed;
  try {
    return decodeURIComponent(trimmed);
  } catch {
    return trimmed;
  }
}

export function readKtoServiceKey(env: NodeJS.ProcessEnv = process.env): string | null {
  return normalizeServiceKey(env.KTO_SERVICE_KEY);
}

/** 요청 URL. **로그에 찍지 않는다**(키가 들어 있다). */
export function buildGallerySearchUrl(serviceKey: string, keyword: string, options: { rows?: number; page?: number } = {}): string {
  const params = new URLSearchParams({
    serviceKey,
    MobileOS: "ETC",
    MobileApp: KTO_MOBILE_APP,
    _type: "json",
    numOfRows: String(options.rows ?? KTO_DEFAULT_ROWS),
    pageNo: String(options.page ?? 1),
    keyword,
  });
  return `${KTO_GALLERY_SEARCH_ENDPOINT}?${params.toString()}`;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

/**
 * 응답 JSON → 사진 목록. 결과가 0건이면 `items`가 빈 문자열로, 1건이면 `item`이 배열이 아닌 객체로 오는 공공데이터 API 관행을
 * 둘 다 받는다. 이미지 주소가 없는 항목은 버린다.
 */
export function parseGallerySearchResponse(data: unknown): KtoSearchResult {
  const response = (data as { response?: { header?: { resultCode?: unknown; resultMsg?: unknown }; body?: unknown } } | null)?.response;
  if (!response || typeof response !== "object") return { ok: false, error: "응답 형식이 아님(response 없음)" };
  const code = text(response.header?.resultCode);
  if (code && code !== "0000" && code !== "00") {
    return { ok: false, error: `API 오류 ${code}: ${text(response.header?.resultMsg).slice(0, 80)}` };
  }
  const body = (response.body ?? {}) as { items?: unknown; totalCount?: unknown };
  const items = body.items && typeof body.items === "object" ? (body.items as { item?: unknown }).item : undefined;
  const list: unknown[] = Array.isArray(items) ? items : items && typeof items === "object" ? [items] : [];
  const photos: KtoPhoto[] = [];
  for (const raw of list) {
    const item = (raw ?? {}) as Record<string, unknown>;
    const imageUrl = text(item.galWebImageUrl);
    if (!/^https?:\/\//i.test(imageUrl)) continue;
    photos.push({
      contentId: text(item.galContentId),
      title: text(item.galTitle),
      imageUrl,
      location: text(item.galPhotographyLocation),
      photographer: text(item.galPhotographer),
      searchKeywords: text(item.galSearchKeyword),
      photographyMonth: text(item.galPhotographyMonth),
    });
  }
  const totalCount = Number(text(body.totalCount)) || photos.length;
  return { ok: true, photos, totalCount };
}

/**
 * 키가 있으면 검색 함수를, 없으면 null을 돌려준다(호출부가 이 출처를 건너뛴다).
 * `fetchFn`은 테스트 주입 지점이다.
 */
export function createKtoSearch(
  options: { serviceKey?: string | null; fetchFn?: typeof fetch; rows?: number } = {}
): KtoSearch | null {
  const serviceKey = options.serviceKey === undefined ? readKtoServiceKey() : normalizeServiceKey(options.serviceKey);
  if (!serviceKey) return null;
  const fetchFn = options.fetchFn ?? fetch;
  return async (keyword: string): Promise<KtoSearchResult> => {
    const url = buildGallerySearchUrl(serviceKey, keyword, { rows: options.rows });
    try {
      const response = await fetchFn(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      const body = await response.text();
      if (!response.ok) return { ok: false, error: `"${keyword}" HTTP ${response.status}` };
      let data: unknown;
      try {
        data = JSON.parse(body);
      } catch {
        // 인증 오류는 _type=json이어도 XML로 온다(공공데이터포털 게이트웨이). 사유 코드만 뽑는다 - 본문은 남기지 않는다.
        const reason = /<returnAuthMsg>([^<]{1,80})<\/returnAuthMsg>/.exec(body)?.[1] ?? /<resultMsg>([^<]{1,80})<\/resultMsg>/.exec(body)?.[1];
        return { ok: false, error: `"${keyword}" JSON이 아닌 응답${reason ? `(${reason})` : ""}` };
      }
      const parsed = parseGallerySearchResponse(data);
      return parsed.ok ? parsed : { ok: false, error: `"${keyword}" ${parsed.error}` };
    } catch (error) {
      // fetch 오류 문구에 URL이 섞일 수 있다 - 이름만 남긴다.
      const name = error instanceof Error ? error.name : "Error";
      return { ok: false, error: `"${keyword}" 요청 실패(${name})` };
    }
  };
}
