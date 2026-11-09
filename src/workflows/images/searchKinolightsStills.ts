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
//
// 정밀도는 후보를 얼마나 잘 거르느냐가 아니라 **제목 검증 + 재시도**가 담보한다(2026-11-09 개정).
// 이 모듈은 "작품명은 키워드 맨 앞에 온다"는 가정으로 시작했는데(2026-09-24), 엔터 키워드가
// 헤드라인형으로 바뀌면서 작품명이 중간·끝에 박힌다 - 실측으로 10/20 이후 작품(ott) 원고 11건 중
// 스틸이 들어간 것은 4건뿐이었고, 그 4건은 전부 작품명이 키워드 맨 앞이었다. 그래서 ① 후보는 키워드의
// 모든 연속 구간에서 만들고 ② 검증은 구간 일치로 하며 ③ 검증에 떨어지면 다음 후보로 이어 붙인다.
// 후보 필터(경계 노이즈)는 Serper 호출을 몇 번 아끼는 용도일 뿐 맞는 작품을 가려내지 않는다.

import { parse } from "node-html-parser";

import { recordSerperUsage } from "../../services/usage/recordSerperUsage.js";
import type { recordApiUsage } from "../../services/usage/recordApiUsage.js";

/** 미디어 섹션의 스틸 버튼. 이 라벨이 이 작품의 스틸임을 보증하는 유일한 표식이다. */
const STILL_BUTTON_LABEL = /^스틸컷\s*\d+/;
/** 썸네일·원본 어느 쪽 URL에서든 원본 경로를 되뽑는다. */
const STILL_PATH = /original\/(content_still_cut\/\d{6}\/\d{2}\/[0-9a-f-]{36}\.(?:jpe?g|png|webp))/i;
/** 작품 페이지 URL. `/media`·`/reviews` 같은 하위 경로가 붙어 와도 받는다. */
const WORK_URL = /https?:\/\/(?:m\.)?kinolights\.com\/(season|movie)\/(\d+)/i;

const SEARCH_ENDPOINT = "https://google.serper.dev/search";
/**
 * goto 링크를 실제 주소로 되돌리는 엔드포인트(2026-10-30 서퍼 공지 "Changes to Google result links").
 *
 * 2026-10-30 01:30 UTC부터 구글이 검색 직후 열 수 있는 결과 링크를 제한했다 - **4위부터는 실제 주소 대신
 * `https://www.google.com/goto?url=...`** 가 온다(상위 3개만 서퍼가 자동으로 풀어 준다). 이 모듈은
 * `site:kinolights.com <제목>` 결과에서 작품 페이지 URL을 정규식으로 찾는데, goto 링크는 그 정규식에
 * 걸리지 않으므로 **작품 페이지가 4위 밖이면 조용히 못 찾는다**(실측: 상위 3개가 리디렉션 도메인·리뷰·
 * 컬렉션 페이지로 차는 경우가 있다). 실패해도 예외가 아니라 빈 결과라서, 일반 이미지 검색의 1200x630
 * 공유 이미지로 떨어지고 아무도 모른다 - 그래서 푼다.
 *
 * 비용 0크레딧이고 한 번의 추가 호출이다(실측 확인).
 */
const RESOLVE_ENDPOINT = "https://google.serper.dev/resolve";
/** goto 링크인가. */
const GOTO_LINK = /^https?:\/\/(?:www\.)?google\.com\/goto\?/i;
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
  /** 테스트 주입. 기본은 Serper 웹 검색. **후보 하나**를 받는다(후보 루프는 이 모듈 안에 있다). */
  findWorkUrl?: (title: string) => Promise<string | null>;
  /** 테스트 주입. 기본은 모바일 UA로 fetch. */
  fetchPage?: (url: string) => Promise<string | null>;
  /** 이 호출이 어느 원고 때문인지(비용 원장 job_id). 없으면 원고당 단가에 안 잡힌다. */
  jobId?: string | null;
  /** 테스트 주입. 기본은 실제 원장 기록. */
  record?: typeof recordApiUsage;
};

/** `https://m.kinolights.com/season/152343/media`처럼 미디어 탭 주소로 정규화한다. */
export function toMediaUrl(workUrl: string): string | null {
  const matched = workUrl.match(WORK_URL);
  if (!matched) return null;
  return `https://m.kinolights.com/${matched[1]}/${matched[2]}/media`;
}

/**
 * 플랫폼 이름(넷플릭스·티빙…)이 키워드 앞에 붙는 경우가 있어 그것부터 걷어낸다.
 */
const PLATFORM = /^(넷플릭스|티빙|웨이브|쿠팡플레이|디즈니\+?|디즈니플러스|왓챠|애플tv\+?|ENA|JTBC|SBS|KBS|MBC|tvN)\s+/i;

/** 플랫폼·장르 수식을 걷어낸 키워드. */
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
 * 키워드 단어 목록의 **어느 연속 구간과** 작품 제목이 일치하는지(단어 경계에 정렬) 본다.
 * 단순 `includes`가 아니다 - 단어 중간에서 걸리는 오탐을 막는다.
 */
function matchesAnySpan(title: string, words: readonly string[]): boolean {
  for (let i = 0; i < words.length; i += 1) {
    let joined = "";
    for (let j = i; j < words.length; j += 1) {
      joined += normalize(words[j]);
      if (joined === title) return true;
      if (joined.length > title.length) break;
    }
  }
  return false;
}

/**
 * 찾아낸 작품이 **이 키워드의 작품이 맞는지** 본다(2026-09-24 실측 사고, 2026-11-09 개정).
 *
 * 왜 필요한가: 제목 후보를 줄여 가며 검색하면 엉뚱한 작품이 걸린다. 실측에서
 * `티빙 오리지널 M 리부트`가 **헬보이**(season/69963, 스틸 20장)를 물어 왔다. 그대로 뒀으면
 * 한국 드라마 원고에 헬보이 스틸이 20장 들어갔을 것이다 - **빈 자리보다 나쁘다.**
 *
 * 기준: 작품 제목이 키워드 단어들의 **어느 연속 구간과든 일치**해야 한다(단어 경계 정렬).
 * 처음엔 "정제된 키워드의 앞머리와 일치"였는데, 그건 작품명이 맨 앞이라는 가정이었다. 엔터 키워드가
 * 헤드라인형(`19.5% 닥터X 제쳤다 …`, `중드 가금채 줄거리 …`)으로 바뀌어 작품명이 중간에 오면 올바른
 * 작품 페이지를 찾고도 여기서 버렸다. 앞머리 일치는 구간 일치의 특수한 경우라 기존 통과 케이스는 그대로다.
 * 헬보이(`M 리부트` 어느 구간도 아님)·`여친, 빌리겠습니다 3기`·`감각의 제국`은 계속 떨어진다.
 */
export function titleMatchesKeyword(workTitle: string, keyword: string): boolean {
  const title = normalize(workTitle);
  if (title.length < 2) return false;
  const words = keyword.trim().split(/\s+/).filter(Boolean);
  return matchesAnySpan(title, words);
}

/**
 * 후보 개수 상한. 후보 하나가 Serper를 최대 2건(site: 질의 + 키노라이츠 질의) 쓰므로 최악 12건이다 -
 * 옛 후보 루프의 최악(5후보 x 2 = 10건)과 비슷한 수준으로 묶는다. **비용 가드**라서 늘리면 호출당 단가가
 * 그대로 늘어난다(원고 1건 = 이미지 자리마다 한 번씩 돈다).
 */
const MAX_CANDIDATES = 6;
/** 후보에 쓸 연속 구간의 최대 단어 수. 더 긴 작품명은 키워드 전체 후보가 맡는다. */
const MAX_SPAN_WORDS = 4;
/**
 * 상한 안에서 **한 단어 후보**에 주는 자리. 헤드라인형 키워드의 작품명은 대개 1~2단어이고, 긴 구간
 * (`연애는 달달 현실은 씁쓸`)은 거의 항상 쓰레기라서 긴 것부터 자리를 채우면 뒤쪽 작품명에 닿지 못한다.
 */
const SINGLE_WORD_SLOTS = 3;

/**
 * 작품명이 아닌 말. 구간의 **첫 단어나 끝 단어**가 여기 있으면 후보로 만들지 않는다 - 작품 제목은
 * 이런 말로 시작하거나 끝나지 않는다. 불완전해도 된다: 정밀도는 이 목록이 아니라 제목 검증과 재시도가
 * 담보하고, 여기서는 Serper 호출 몇 번을 아낄 뿐이다. 그래서 목록을 늘리려 애쓰지 않는다.
 */
const BOUNDARY_NOISE = new Set(
  (
    "줄거리 결말 몇부작 출연진 원작 총정리 리뷰 관전 포인트 공개 첫방 재개봉 무삭제 완전판 예매율 시청률 " +
    "정보 편성 반응 해외 논란 및 왜 등 하루 만에 직후 넷플릭스 티빙 웨이브 쿠팡플레이 디즈니플러스 디즈니+ " +
    "왓챠 중드 일드 미드 드라마 영화 시리즈 오리지널"
  ).split(" ")
);

function isNoiseWord(word: string): boolean {
  // `첫방,`처럼 문장부호가 붙어 와도 걸러진다. `디즈니+`의 +는 남긴다.
  const bare = word.replace(/^[^\p{L}\p{N}+]+|[^\p{L}\p{N}+]+$/gu, "");
  return BOUNDARY_NOISE.has(bare);
}

/** 양 끝에서 안쪽으로 번갈아 나열한다(왼쪽, 오른쪽, 왼쪽+1, 오른쪽-1…). */
function fromBothEnds<T>(items: readonly T[]): T[] {
  const out: T[] = [];
  let lo = 0;
  let hi = items.length - 1;
  while (lo <= hi) {
    out.push(items[lo]);
    lo += 1;
    if (lo <= hi) {
      out.push(items[hi]);
      hi -= 1;
    }
  }
  return out;
}

type Span = { text: string; start: number; size: number };

/**
 * job 키워드에서 **작품명 후보**를 만든다(2026-09-24 실측, 2026-11-09 개정).
 *
 * 키워드는 작품명이 아니다. `연애박사 안판석 감독 유작 추영우 김소현`처럼 감독·배우·플랫폼이
 * 줄줄이 붙어 있어서 그대로 검색하면 0건이다. 실측:
 *
 *   "연애박사 안판석 감독 유작 추영우 김소현"  -> 0장
 *   "연애박사"                                  -> 4장
 *
 * 처음엔 "작품명은 보통 맨 앞에 온다"며 앞에서부터 1~4단어만 잘랐다. 엔터 키워드가 헤드라인형으로 바뀐 뒤로
 * 깨졌다 - `연애는 달달 현실은 씁쓸 청춘의 반짝거림 그린 연애박사`는 후보에 `연애박사`가 아예 없었다
 * (10/20 이후 작품 원고 11건 중 4건만 성공, 그 4건은 전부 작품명이 맨 앞). 그래서 **모든 연속 구간**
 * (1~4단어)을 후보로 삼고, 틀린 구간은 제목 검증이 떨어뜨린 뒤 다음 후보로 넘어간다.
 *
 * 시도 순서: 키워드 전체 -> **긴 것 먼저, 같은 길이면 왼쪽 먼저.** 짧은 것부터 가면 엉뚱한 작품을 문다 -
 * `100일의 거짓말`보다 `거짓말`이 먼저 가면 1999년 영화 `거짓말`이 걸리고, `티빙 오리지널 M 리부트`는
 * `M`으로 잘려 다른 작품(스틸 1장)을 찾았다(제대로 된 작품은 `M 리부트`, 20장). 한 글자 후보는 다른
 * 후보가 있으면 아예 쓰지 않는다.
 *
 * **상한(MAX_CANDIDATES)은 시도 순서와 별개로 고른다.** 긴 것부터 앞에서 6개를 자르면 8단어 키워드의
 * 4단어 구간(5개)이 자리를 다 차지해서 끝에 있는 `연애박사`에 닿지 못한다(구간 30개 중 6개). 그래서
 * 한 단어 후보 몫(SINGLE_WORD_SLOTS)을 따로 두고, 각 길이 안에서는 양 끝부터 안쪽으로 고른다 -
 * 작품명이 머리(`연애박사 안판석…`)나 꼬리(`…그린 연애박사`)에 오는 경우가 많다.
 */
export function workTitleCandidates(keyword: string): string[] {
  const whole = keyword.trim();
  const words = cleanKeyword(keyword).split(/\s+/).filter(Boolean);
  if (!whole) return [];

  const spans: Span[] = [];
  for (let size = 1; size <= Math.min(MAX_SPAN_WORDS, words.length); size += 1) {
    for (let start = 0; start + size <= words.length; start += 1) {
      // 경계 노이즈: 첫 단어나 끝 단어가 작품명이 아닌 말이면 버린다.
      if (isNoiseWord(words[start]) || isNoiseWord(words[start + size - 1])) continue;
      spans.push({ text: words.slice(start, start + size).join(" "), start, size });
    }
  }

  // 한 글자 후보(`M`)는 아무 작품이나 문다. 다른 후보가 있으면 버린다(키워드 전체도 후보다).
  const multiChar = whole.length > 1 || spans.some((span) => span.text.length > 1);
  const pool = multiChar ? spans.filter((span) => span.text.length > 1) : spans;

  const singles = fromBothEnds(pool.filter((span) => span.size === 1 && span.text !== whole));
  const multis = [2, 3, 4].flatMap((size) => fromBothEnds(pool.filter((span) => span.size === size && span.text !== whole)));

  const room = MAX_CANDIDATES - 1; // 키워드 전체가 한 자리를 쓴다.
  const singleTake = Math.min(singles.length, Math.max(SINGLE_WORD_SLOTS, room - multis.length));
  const multiTake = Math.min(multis.length, room - singleTake);
  const picked = [...singles.slice(0, singleTake), ...multis.slice(0, multiTake)];

  // 시도 순서: 긴 것 먼저, 같은 길이면 왼쪽 먼저. 같은 글자 구간은 하나만.
  picked.sort((a, b) => b.size - a.size || a.start - b.start);
  const candidates = [whole];
  for (const span of picked) if (!candidates.includes(span.text)) candidates.push(span.text);
  return candidates;
}

/**
 * goto 링크 묶음을 실제 주소로 되돌린다. 실패하면 빈 배열이다 - 여기서 예외를 던져 스틸 수집 전체를
 * 막지 않는다(못 풀면 일반 이미지 검색으로 떨어지는 기존 동작 그대로다).
 */
export async function resolveGotoLinks(
  links: readonly string[],
  apiKey: string,
  fetchImpl: typeof fetch = fetch
): Promise<string[]> {
  if (links.length === 0) return [];
  try {
    const res = await fetchImpl(RESOLVE_ENDPOINT, {
      method: "POST",
      headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ links: [...links] }),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { links?: unknown };
    return Array.isArray(json.links) ? json.links.filter((l): l is string => typeof l === "string") : [];
  } catch {
    return [];
  }
}

/**
 * 제목으로 작품 페이지를 찾는다. Serper 웹 검색을 쓴다.
 *
 * `site:` 한정을 먼저 걸고, 결과가 없으면 `키노라이츠 <제목>`으로 한 번 더 본다 - 색인에 따라
 * 한쪽만 걸리는 경우가 있다(실측 두 질의 모두 같은 작품을 찾았다).
 */
async function findWorkUrlForTitle(
  title: string,
  usage: { jobId?: string | null; record?: typeof recordApiUsage } = {}
): Promise<string | null> {
  const key = process.env.SERPER_API_KEY;
  if (!key) return null;

  for (const q of [`site:kinolights.com ${title}`, `키노라이츠 ${title}`]) {
    let responded = false;
    try {
      const res = await fetch(SEARCH_ENDPOINT, {
        method: "POST",
        headers: { "X-API-KEY": key, "Content-Type": "application/json" },
        body: JSON.stringify({ q, gl: "kr", hl: "ko", num: 10 }),
      });
      responded = true;
      recordSerperUsage({ endpoint: "search", ok: res.ok, status: res.status, jobId: usage.jobId, record: usage.record });
      if (!res.ok) continue;
      const json = (await res.json()) as { organic?: { link?: string }[] };
      const links = (json.organic ?? []).map((item) => item.link).filter((l): l is string => typeof l === "string");

      // 먼저 그대로 본다(상위 3개는 이미 실제 주소다). 여기서 걸리면 추가 호출이 없다.
      const direct = links.find((link) => WORK_URL.test(link));
      if (direct) return direct;

      // 못 찾았으면 goto 링크만 풀어서 다시 본다(0크레딧).
      const resolved = await resolveGotoLinks(links.filter((link) => GOTO_LINK.test(link)), key);
      const found = resolved.find((link) => WORK_URL.test(link));
      if (found) return found;
    } catch {
      // 한 질의가 실패해도 다음 질의로 넘어간다. 응답을 못 받은 네트워크 실패만 여기서 기록한다.
      if (!responded) recordSerperUsage({ endpoint: "search", ok: false, status: 0, jobId: usage.jobId, record: usage.record });
    }
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
 * 페이지 받기 상한. 검증 탈락이 연달아 나도 무한히 긁지 않는다.
 *
 * 페이지 받기는 키노라이츠 HTML 한 번이라 **API 비용이 0**이다 - 비용이 드는 건 Serper 호출이고 그건
 * MAX_CANDIDATES가 묶는다. 그래서 이 상한은 비용 가드가 아니라 **지연·예절 가드**다. 3으로 시작했다가 5로 올렸다:
 * 새 후보 순서에서는 작품명이 뒤쪽에 온다(`…그린 연애박사`는 `연애박사`가 6번째, `19.5% 닥터X …`는 `닥터X`가
 * 5번째). 앞선 후보가 각각 다른 틀린 작품 페이지를 물면 3건에서 끊겨 맞는 후보에 닿지 못한다 - 이번 수정이
 * 고치려던 실패가 다른 모양으로 남는다.
 */
const MAX_PAGE_FETCHES = 5;

/**
 * 작품 제목으로 공식 스틸을 가져온다. 못 찾으면 빈 배열 - 호출부가 일반 검색으로 간다.
 *
 * **후보 하나마다 「작품 URL 찾기 -> 미디어 페이지 받기 -> og:title 검증」을 끝까지 돌리고, 검증을 통과한
 * 첫 후보의 스틸을 돌려준다.** 탈락하면 다음 후보로 이어 간다(2026-11-09). 전에는 URL 찾기 루프가
 * 검증 바깥에 있어서 첫 URL이 엉뚱한 작품이면 남은 후보를 시도하지 않고 빈 배열로 끝났다. 라이브 실측:
 *
 *   "거짓말 4K 무삭제"      -> season/121101  og:title "여친, 빌리겠습니다 3기"  탈락 -> 0장 종료
 *   "시한부 1년 남자를 사다" -> season/15784   og:title "감각의 제국"            탈락 -> 0장 종료
 *
 * 검증은 제 일을 했다(헬보이 20장 사고의 방어선). 모자랐던 건 탈락 뒤에 이어 가는 것이다.
 *
 * 예외를 던지지 않는다. 이미지 하나 때문에 원고가 막히면 안 된다.
 */
export async function searchKinolightsStills(
  title: string,
  options: SearchKinolightsOptions = {}
): Promise<KinolightsStill[]> {
  const trimmed = title.trim();
  if (!trimmed) return [];

  const findWorkUrl =
    options.findWorkUrl ?? ((candidate: string) => findWorkUrlForTitle(candidate, { jobId: options.jobId, record: options.record }));
  const fetchPage = options.fetchPage ?? defaultFetchPage;

  const triedPages = new Set<string>();
  let fetched = 0;
  for (const candidate of workTitleCandidates(trimmed)) {
    if (fetched >= MAX_PAGE_FETCHES) break;

    const workUrl = await findWorkUrl(candidate).catch(() => null);
    if (!workUrl) continue;

    const mediaUrl = toMediaUrl(workUrl);
    // 이미 받아 검증한 페이지를 다른 후보가 또 물어 와도 다시 받지 않는다(받기 상한을 아낀다).
    if (!mediaUrl || triedPages.has(mediaUrl)) continue;
    triedPages.add(mediaUrl);

    fetched += 1;
    const html = await fetchPage(mediaUrl).catch(() => null);
    if (!html) continue;

    // **이 작품이 맞는지 확인하고 쓴다.** 아니면 다음 후보로 - 틀린 작품의 스틸은 빈 자리보다 나쁘다.
    const workTitle = readWorkTitle(html);
    if (!workTitle || !titleMatchesKeyword(workTitle, trimmed)) continue;

    return extractStills(html, mediaUrl);
  }
  return [];
}
