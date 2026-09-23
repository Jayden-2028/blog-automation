// 키노라이츠에서 작품의 **공식 스틸컷**을 직접 가져온다(2026-09-24 사용자 지시).
//
// 왜 일반 이미지 검색으로 안 되나(실측): 이미지 색인은 키노라이츠 작품 페이지의 **OG 공유
// 이미지(1200x630)** 까지만 긁어 둔다. 미디어 섹션 안의 개별 스틸은 색인에 없어서, 검색어에
// `키노라이츠`를 붙여도 정작 쓸 만한 스틸은 안 나온다. 페이지를 직접 열어야 한다.
//
//   일반 이미지 검색 상위    1200x630  file-dit.kinolights.com  (OG 공유 이미지)
//   이 모듈이 가져오는 것     3000x2000 file.kinolights.com      (원본 스틸)
//
// 두 단계다.
//   1) 제목으로 **작품 페이지 URL**을 찾는다 - Serper 웹 검색 `site:kinolights.com <제목>`.
//      비공식 API(api.kinolights.com)를 역설계하지 않는 이유: 언제 바뀌어도 알 수 없다.
//   2) 그 페이지의 **미디어 섹션만** 긁는다 - 페이지 전체를 긁으면 추천작 스틸까지 섞인다
//      (실측: 전체 68장 중 이 작품 것은 4장뿐이었다).

import { parse } from "node-html-parser";

/** 미디어 섹션의 스틸 버튼. 이 라벨이 이 작품의 스틸임을 보증하는 유일한 표식이다. */
const STILL_BUTTON_LABEL = /^스틸컷\s*\d+/;
/** 썸네일·원본 어느 쪽 URL에서든 원본 경로를 되뽑는다. */
const STILL_PATH = /original\/(content_still_cut\/\d{6}\/\d{2}\/[0-9a-f-]{36}\.(?:jpe?g|png|webp))/i;
/** 작품 페이지 URL. `/media`·`/reviews` 같은 하위 경로가 붙어 와도 받는다. */
const WORK_URL = /https?:\/\/(?:m\.)?kinolights\.com\/(season|movie)\/(\d+)/i;

const SEARCH_ENDPOINT = "https://google.serper.dev/search";
/** 모바일 UA로 받아야 미디어 섹션이 서버 렌더링된 HTML로 온다. */
const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

export type KinolightsStill = {
  /** 원본 이미지 URL(리사이즈 안 된 것). */
  imageUrl: string;
  /** 이 스틸이 실린 작품 페이지. 출처 표기와 검증에 쓴다. */
  sourcePage: string;
};

export type SearchKinolightsOptions = {
  /** 테스트 주입. 기본은 Serper 웹 검색. */
  findWorkUrl?: (title: string) => Promise<string | null>;
  /** 테스트 주입. 기본은 모바일 UA로 fetch. */
  fetchPage?: (url: string) => Promise<string | null>;
};

/** `https://m.kinolights.com/season/152343/media`처럼 미디어 탭 주소로 정규화한다. */
export function toMediaUrl(workUrl: string): string | null {
  const matched = workUrl.match(WORK_URL);
  if (!matched) return null;
  return `https://m.kinolights.com/${matched[1]}/${matched[2]}/media`;
}

/**
 * job 키워드에서 **작품명 후보**를 짧은 순서로 만든다(2026-09-24 실측).
 *
 * 키워드는 작품명이 아니다. `연애박사 안판석 감독 유작 추영우 김소현`처럼 감독·배우·플랫폼이
 * 줄줄이 붙어 있어서 그대로 검색하면 0건이다. 실측:
 *
 *   "연애박사 안판석 감독 유작 추영우 김소현"  -> 0장
 *   "연애박사"                                  -> 4장
 *
 * 작품명은 보통 **맨 앞**에 온다. 그래서 앞에서부터 1~4단어를 잘라 본다.
 * 플랫폼 이름(넷플릭스·티빙…)이 앞에 붙는 경우가 있어 그것부터 걷어낸다.
 *
 * **긴 후보부터 시도한다.** 짧은 것부터 가면 한 글자짜리가 엉뚱한 작품을 물어 온다 -
 * 실측: `티빙 오리지널 M 리부트`가 `M`으로 잘려 다른 작품(스틸 1장)을 찾았고, `M 리부트`로는
 * 제대로 된 작품(20장)을 찾았다. 한 글자 후보는 다른 후보가 있으면 아예 쓰지 않는다.
 */
const PLATFORM = /^(넷플릭스|티빙|웨이브|쿠팡플레이|디즈니\+?|디즈니플러스|왓챠|애플tv\+?|ENA|JTBC|SBS|KBS|MBC|tvN)\s+/i;

/** 플랫폼·장르 수식을 걷어낸 키워드. 작품명은 이 앞머리에 있다. */
export function cleanKeyword(keyword: string): string {
  let text = keyword.trim();
  // 플랫폼·수식어가 앞에 여러 개 붙기도 한다.
  for (let i = 0; i < 3; i += 1) text = text.replace(PLATFORM, "").trim();
  return text.replace(/^(오리지널|드라마|영화|시리즈)\s+/i, "").trim();
}

/** 비교용 정규화 - 공백·문장부호를 없애고 소문자로. */
function normalize(text: string): string {
  return text.replace(/[\s'"“”‘’<>《》「」()[\]]/g, "").toLowerCase();
}

/**
 * 찾아낸 작품이 **이 키워드의 작품이 맞는지** 본다(2026-09-24 실측 사고).
 *
 * 왜 필요한가: 제목 후보를 줄여 가며 검색하면 엉뚱한 작품이 걸린다. 실측에서
 * `티빙 오리지널 M 리부트`가 **헬보이**(season/69963, 스틸 20장)를 물어 왔다. 그대로 뒀으면
 * 한국 드라마 원고에 헬보이 스틸이 20장 들어갔을 것이다 - **빈 자리보다 나쁘다.**
 *
 * 기준: 작품 제목이 정제된 키워드의 **앞머리와 일치**해야 한다. 작품명은 키워드 맨 앞에 오기
 * 때문이다. `리부트`는 `M리부트`의 앞머리가 아니므로 떨어진다.
 */
export function titleMatchesKeyword(workTitle: string, keyword: string): boolean {
  const title = normalize(workTitle);
  if (title.length < 2) return false;
  const cleaned = normalize(cleanKeyword(keyword));
  return cleaned.startsWith(title) || normalize(keyword).startsWith(title);
}

export function workTitleCandidates(keyword: string): string[] {
  const text = cleanKeyword(keyword);
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const candidates: string[] = [];
  // 긴 것부터. 원본 키워드를 맨 앞에 둔다 - 작품명이 통째로 긴 경우가 있다.
  const whole = keyword.trim();
  if (whole && whole !== text) candidates.push(whole);
  for (let take = Math.min(4, words.length); take >= 1; take -= 1) {
    const candidate = words.slice(0, take).join(" ");
    // 한 글자 후보(`M`)는 아무 작품이나 문다. 다른 후보가 있으면 버린다.
    if (candidate.length <= 1 && candidates.length > 0) continue;
    if (!candidates.includes(candidate)) candidates.push(candidate);
  }
  return candidates;
}

/**
 * 제목으로 작품 페이지를 찾는다. Serper 웹 검색을 쓴다.
 *
 * `site:` 한정을 먼저 걸고, 결과가 없으면 `키노라이츠 <제목>`으로 한 번 더 본다 - 색인에 따라
 * 한쪽만 걸리는 경우가 있다(실측 두 질의 모두 같은 작품을 찾았다).
 */
async function findWorkUrlForTitle(title: string): Promise<string | null> {
  const key = process.env.SERPER_API_KEY;
  if (!key) return null;

  for (const q of [`site:kinolights.com ${title}`, `키노라이츠 ${title}`]) {
    try {
      const res = await fetch(SEARCH_ENDPOINT, {
        method: "POST",
        headers: { "X-API-KEY": key, "Content-Type": "application/json" },
        body: JSON.stringify({ q, gl: "kr", hl: "ko", num: 10 }),
      });
      if (!res.ok) continue;
      const json = (await res.json()) as { organic?: { link?: string }[] };
      for (const item of json.organic ?? []) {
        if (item.link && WORK_URL.test(item.link)) return item.link;
      }
    } catch {
      // 한 질의가 실패해도 다음 질의로 넘어간다.
    }
  }
  return null;
}

/** 후보 제목을 짧은 것부터 시도한다. 하나라도 걸리면 거기서 멈춘다. */
async function defaultFindWorkUrl(keyword: string): Promise<string | null> {
  for (const title of workTitleCandidates(keyword)) {
    const url = await findWorkUrlForTitle(title);
    if (url) return url;
  }
  return null;
}

async function defaultFetchPage(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": MOBILE_UA } });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/**
 * og:title에서 작품명을 읽는다. 페이지마다 형식이 다르다(실측).
 *
 * ```
 * /season/152343         "연애박사 다시보기 | 키노라이츠 #리뷰 #평가"
 * /season/152343/media   "연애박사 · 미디어"
 * ```
 *
 * 그래서 꼬리(`· 미디어`, `다시보기 | …`)를 걷어낸 앞부분만 쓴다.
 */
export function readWorkTitle(html: string): string | null {
  const matched = html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i);
  if (!matched) return null;
  return matched[1]
    .split("·")[0]
    .replace(/\s*다시보기\s*\|.*$/, "")
    .replace(/\s*\|.*$/, "")
    .trim() || null;
}

/**
 * 미디어 섹션의 스틸만 뽑는다.
 *
 * **페이지 전체를 긁지 않는다.** 작품 페이지에는 "비슷한 작품" 추천이 함께 실려서, 통째로
 * 긁으면 다른 작품 스틸이 섞인다(실측: 전체 68장 중 이 작품 것은 4장). `aria-label`이
 * `스틸컷 N …`인 버튼 안쪽만 본다 - 그게 이 작품의 미디어 섹션임을 보증하는 표식이다.
 */
export function extractStills(html: string, sourcePage: string): KinolightsStill[] {
  const root = parse(html);
  const seen = new Set<string>();
  const stills: KinolightsStill[] = [];

  for (const button of root.querySelectorAll("button[aria-label]")) {
    const label = (button.getAttribute("aria-label") ?? "").trim();
    if (!STILL_BUTTON_LABEL.test(label)) continue;

    // 버튼 안의 img/source 어느 쪽이든 원본 경로가 들어 있다(srcset은 크기만 다르다).
    const matched = button.innerHTML.match(STILL_PATH);
    if (!matched) continue;

    const imageUrl = `https://file.kinolights.com/original/${matched[1]}`;
    if (seen.has(imageUrl)) continue;
    seen.add(imageUrl);
    stills.push({ imageUrl, sourcePage });
  }

  return stills;
}

/**
 * 작품 제목으로 공식 스틸을 가져온다. 못 찾으면 빈 배열 - 호출부가 일반 검색으로 간다.
 *
 * 예외를 던지지 않는다. 이미지 하나 때문에 원고가 막히면 안 된다.
 */
export async function searchKinolightsStills(
  title: string,
  options: SearchKinolightsOptions = {}
): Promise<KinolightsStill[]> {
  const trimmed = title.trim();
  if (!trimmed) return [];

  const findWorkUrl = options.findWorkUrl ?? defaultFindWorkUrl;
  const fetchPage = options.fetchPage ?? defaultFetchPage;

  const workUrl = await findWorkUrl(trimmed).catch(() => null);
  if (!workUrl) return [];

  const mediaUrl = toMediaUrl(workUrl);
  if (!mediaUrl) return [];

  const html = await fetchPage(mediaUrl).catch(() => null);
  if (!html) return [];

  // **이 작품이 맞는지 확인하고 쓴다.** 아니면 빈 배열 - 틀린 작품의 스틸은 빈 자리보다 나쁘다.
  const workTitle = readWorkTitle(html);
  if (!workTitle || !titleMatchesKeyword(workTitle, trimmed)) return [];

  return extractStills(html, mediaUrl);
}
