// 구글 트렌드 "Trending now" RSS 파서.
//
// 왜 RSS인가(2026-08-29 조사):
// - 공식 Google Trends API는 2025-07-24에 발표됐지만 1년이 지나도 신청 승인제 alpha다. 지금 못 쓴다.
// - `pytrends`는 2025-04에 아카이브됐다. 참고 대상이 아니다.
// - RSS는 인증/키가 필요 없고 응답이 가볍다. 엔드포인트는 `/trending/rss?geo=KR`이며,
//   구 엔드포인트(`/trends/trendingsearches/daily/rss`)는 폐기됐다.
//
// 왜 XML 라이브러리를 안 쓰는가: 이 프로젝트에는 node-html-parser만 있고, 필요한 건 고정된 소수
// 태그의 텍스트뿐이다. RSS 구조가 얕고 항목이 20개 안팎이라 정규식 추출로 충분하다. 대신 파서를
// **절대 예외를 던지지 않는 방향**으로 만든다 - 외부 피드 구조가 바뀌었을 때 daily job이 죽는 것보다
// 0건을 반환하고 넘어가는 편이 낫다(호출자가 status로 처리한다).
//
// ⚠️ 실측 미검증: 이 세션은 외부 egress가 차단돼 있어 실제 피드로 확인하지 못했다. 필드 구성은
// 공개된 스키마 기준이며, 맥에서 `npm run collect:google-trends`(기본 dry-run)로 먼저 확인해야 한다.
// 그래서 approx_traffic/news_item/pubDate는 전부 optional로 두고, 없어도 항목을 버리지 않는다.

export type GoogleTrendsNewsItem = {
  title: string;
  url?: string;
  source?: string;
};

export type GoogleTrendsItem = {
  /** 급상승 검색어 자체. 이것이 곧 keyword가 된다. */
  keyword: string;
  /** 피드에 표시된 대략적 검색량 원문(예: "50,000+"). 파싱 값은 approxTrafficValue에 둔다. */
  approxTraffic?: string;
  /** approxTraffic에서 쉼표/기호를 걷어낸 정수. 없으면 undefined. */
  approxTrafficValue?: number;
  link?: string;
  /** RFC 822 원문. ISO 변환은 호출자가 한다(변환 실패를 여기서 삼키지 않기 위함). */
  pubDate?: string;
  newsItems: GoogleTrendsNewsItem[];
};

const ITEM_PATTERN = /<item>([\s\S]*?)<\/item>/g;
const NEWS_ITEM_PATTERN = /<ht:news_item>([\s\S]*?)<\/ht:news_item>/g;

/** XML 엔티티를 되돌린다. RSS는 제목 안의 <>&'" 를 전부 엔티티로 감싸서 준다. */
export function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    // &amp;는 반드시 마지막이다. 먼저 풀면 "&amp;lt;"가 "<"로 이중 디코딩된다.
    .replace(/&amp;/g, "&");
}

/** CDATA도 함께 벗겨낸다(피드에 따라 제목이 CDATA로 올 수 있다). */
function readTag(xml: string, tagName: string): string | undefined {
  const pattern = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)</${tagName}>`);
  const match = pattern.exec(xml);
  if (!match) return undefined;

  const raw = match[1].replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, "$1");
  const value = decodeXmlEntities(raw).replace(/\s+/g, " ").trim();
  return value || undefined;
}

/** "50,000+" -> 50000. 숫자를 못 찾으면 undefined. */
export function parseApproxTraffic(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const digits = text.replace(/[^\d]/g, "");
  if (!digits) return undefined;
  const value = Number.parseInt(digits, 10);
  return Number.isFinite(value) ? value : undefined;
}

function parseNewsItems(itemXml: string): GoogleTrendsNewsItem[] {
  const newsItems: GoogleTrendsNewsItem[] = [];

  NEWS_ITEM_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = NEWS_ITEM_PATTERN.exec(itemXml)) !== null) {
    const block = match[1];
    const title = readTag(block, "ht:news_item_title");
    if (!title) continue; // 제목 없는 뉴스 항목은 근거로 쓸 수 없다.

    newsItems.push({
      title,
      url: readTag(block, "ht:news_item_url"),
      source: readTag(block, "ht:news_item_source"),
    });
  }

  return newsItems;
}

/**
 * RSS 본문 -> 급상승 검색어 목록. 어떤 입력에도 예외를 던지지 않는다(빈 문자열/HTML 오류 페이지/
 * 구조 변경 전부 빈 배열로 처리). 피드 순서를 그대로 유지하므로 배열 index가 곧 순위다.
 */
export function parseGoogleTrendsRss(xml: string): GoogleTrendsItem[] {
  if (!xml) return [];

  const items: GoogleTrendsItem[] = [];

  ITEM_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ITEM_PATTERN.exec(xml)) !== null) {
    const block = match[1];

    const keyword = readTag(block, "title");
    // 검색어가 없는 항목은 조용히 버린다 - 이게 이 파서에서 유일하게 "필수"인 필드다.
    if (!keyword) continue;

    const approxTraffic = readTag(block, "ht:approx_traffic");

    items.push({
      keyword,
      approxTraffic,
      approxTrafficValue: parseApproxTraffic(approxTraffic),
      link: readTag(block, "link"),
      pubDate: readTag(block, "pubDate"),
      newsItems: parseNewsItems(block),
    });
  }

  return items;
}
