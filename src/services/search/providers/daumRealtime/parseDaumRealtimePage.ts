// 다음(Daum) 홈 화면에 서버 렌더링되는 "실시간 트렌드" 위젯 데이터 파서.
//
// 왜 API가 아니라 HTML인가(2026-09-08 실측): 다음은 이 데이터를 위한 공개 API를 제공하지 않는다.
// 대신 https://www.daum.net/ 을 인증 없이 그냥 GET하면(스푸핑 없는 기본 User-Agent로도 확인됨)
// 응답 HTML 안에 컴포넌트 트리 JSON이 그대로 박혀 있고, 그 안에 `"uiType":"REALTIME_TREND_TOP"`
// 노드의 `contents.data`에 순위 목록이 들어 있다. 브라우저 자동화나 로그인 세션이 필요 없다 -
// Creator Advisor보다 훨씬 가볍고, Google Trends RSS 파싱과 같은 층위다.
//
// robots.txt 확인(2026-09-08): daum.net은 대부분 경로를 막지만(`Disallow: /`), 정확히 이 데이터가
// 있는 루트 경로만 명시적으로 허용한다(`Allow: /$`). 나머지 ToS(상업적 재사용 범위)는 별도 확인
// 대상으로 남겨둔다.
//
// 왜 정규식/괄호 매칭인가: 이 프로젝트에 JS 실행 엔진이나 전체 HTML 파서를 새로 들일 이유가 없다.
// 필요한 건 마커 하나 다음에 오는 JSON 객체 하나뿐이라, 문자열 탐색 + 중괄호 balance로 충분하다.
// parseGoogleTrendsRss.ts와 같은 원칙으로 **절대 예외를 던지지 않는다** - 다음이 페이지 구조를
// 바꾸면 0건을 반환하고 넘어간다(daily job이 이 소스 하나 때문에 죽으면 안 된다).

const UI_TYPE_MARKER = '"uiType":"REALTIME_TREND_TOP"';
const DATA_KEY = '"contents":{"data":';

export type DaumRealtimeItem = {
  /** 실시간 트렌드 키워드 원문. */
  keyword: string;
  /** 모델링 내부 순위(변동 계산용). 화면 노출 순위와 다를 수 있다. */
  rank: number;
  /** 실제 화면에 노출되는 1~10 순위. 이것이 우리가 쓰는 순위다. */
  displayRank: number;
  /** "0"=변동 없음, "new"=신규 진입, 그 외 숫자 문자열은 랭킹 점수 변동 폭(부호 있음). */
  status: string;
  /** "Expansion_Q"(검색 확장) | "News"(문서 기반) | "Query"(검색 기반) 등. 없을 수 있다. */
  dataType?: string;
};

export type ParseDaumRealtimePageResult = {
  items: DaumRealtimeItem[];
  /** 위젯에 표시된 갱신 시각(ISO, 다음이 준 그대로). 없으면 undefined. */
  updatedAt?: string;
};

type RawKeywordEntry = {
  keyword?: unknown;
  rank?: unknown;
  displayRank?: unknown;
  status?: unknown;
  tiara?: { eventCustomProps?: { data_type?: unknown } };
};

/** 시작 `{`부터 중괄호 깊이가 0으로 돌아오는 지점까지의 부분 문자열 끝 index. 못 찾으면 -1. */
function findMatchingBraceEnd(html: string, start: number): number {
  let depth = 0;
  for (let i = start; i < html.length; i++) {
    const char = html[i];
    if (char === "{") depth++;
    else if (char === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export function parseDaumRealtimePage(html: string): ParseDaumRealtimePageResult {
  const empty: ParseDaumRealtimePageResult = { items: [] };

  const markerIndex = html.indexOf(UI_TYPE_MARKER);
  if (markerIndex === -1) return empty;

  const dataKeyIndex = html.indexOf(DATA_KEY, markerIndex);
  if (dataKeyIndex === -1) return empty;

  const objectStart = dataKeyIndex + DATA_KEY.length;
  if (html[objectStart] !== "{") return empty;

  const objectEnd = findMatchingBraceEnd(html, objectStart);
  if (objectEnd === -1) return empty;

  try {
    const parsed = JSON.parse(html.slice(objectStart, objectEnd + 1)) as {
      updatedAt?: unknown;
      keywords?: RawKeywordEntry[];
    };

    const items: DaumRealtimeItem[] = (Array.isArray(parsed.keywords) ? parsed.keywords : [])
      .filter(
        (entry): entry is RawKeywordEntry & { keyword: string; rank: number; displayRank: number } =>
          typeof entry.keyword === "string" &&
          entry.keyword.trim().length > 0 &&
          typeof entry.rank === "number" &&
          typeof entry.displayRank === "number"
      )
      .map((entry) => ({
        keyword: entry.keyword,
        rank: entry.rank,
        displayRank: entry.displayRank,
        status: typeof entry.status === "string" ? entry.status : "0",
        dataType:
          typeof entry.tiara?.eventCustomProps?.data_type === "string"
            ? entry.tiara.eventCustomProps.data_type
            : undefined,
      }));

    return {
      items,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : undefined,
    };
  } catch {
    return empty;
  }
}
