// GSC 응답을 저장 가능한 형태로 정리한다. 순수 함수만 둔다(외부 호출 없음).
//
// 왜 정리가 필요한가 — **모바일 URL이 따로 잡힌다.** Blogger는 모바일 접속을 `?m=1`로 돌린다
// (2026-09-21 리디렉션 조사에서 확인). 그래서 같은 글이 GSC에서 두 줄로 나온다:
//
//   .../blog-post_21.html        클릭 3  노출 40  순위 8.2
//   .../blog-post_21.html?m=1    클릭 5  노출 61  순위 7.4
//
// 이걸 그대로 저장하면 글 하나의 성과가 둘로 쪼개져 "어느 글이 잘됐나"를 못 본다. 주소에서
// 쿼리스트링을 떼고 **합친다**. 합칠 때 순위는 단순 평균이 아니라 **노출 가중 평균**이어야 한다 -
// GSC의 position 자체가 노출 가중 평균이라 그래야 값이 보존된다(40회 8.2위와 61회 7.4위를
// 그냥 평균 내면 7.8위지만, 실제로는 7.72위다).

import type { SearchAnalyticsRow } from "../../services/searchConsole/SearchConsoleClient.js";

export type NormalizedRow = {
  date: string;
  pageUrl: string;
  query: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
};

/**
 * 주소에서 쿼리스트링·프래그먼트를 떼어 정규화한다(`?m=1`, `#`, 추적 파라미터 전부).
 * 파싱이 안 되는 주소는 원본을 그대로 돌려준다 - 저장은 되게 하고, 매칭만 못 할 뿐이다.
 */
export function normalizePageUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    return `${url.origin}${url.pathname}`;
  } catch {
    return rawUrl;
  }
}

/** 정규화한 주소 기준으로 같은 (날짜, 주소, 검색어)를 합친다. */
export function aggregateRows(rows: SearchAnalyticsRow[]): NormalizedRow[] {
  const merged = new Map<string, NormalizedRow & { positionWeighted: number }>();

  for (const row of rows) {
    const pageUrl = normalizePageUrl(row.pageUrl);
    const key = `${row.date}\u0000${pageUrl}\u0000${row.query}`;
    const found = merged.get(key);

    if (!found) {
      merged.set(key, {
        date: row.date,
        pageUrl,
        query: row.query,
        clicks: row.clicks,
        impressions: row.impressions,
        ctr: 0,
        position: 0,
        positionWeighted: row.position * row.impressions,
      });
      continue;
    }

    found.clicks += row.clicks;
    found.impressions += row.impressions;
    found.positionWeighted += row.position * row.impressions;
  }

  return [...merged.values()].map(({ positionWeighted, ...row }) => ({
    ...row,
    // 노출이 0이면 나눌 수 없다. GSC는 노출 0인 행을 주지 않지만 방어해 둔다.
    ctr: row.impressions > 0 ? row.clicks / row.impressions : 0,
    position: row.impressions > 0 ? positionWeighted / row.impressions : 0,
  }));
}

/**
 * 성과 행을 우리 job에 붙인다. `publications.published_url`을 같은 규칙으로 정규화해 맞춘다 -
 * 저장된 주소에 `?m=1`이 붙어 있지 않더라도 양쪽을 같은 방식으로 씻어야 짝이 맞는다.
 */
export function attachJobIds(
  rows: NormalizedRow[],
  urlToJobId: Map<string, string>
): Array<NormalizedRow & { jobId: string | null }> {
  const normalized = new Map<string, string>();
  for (const [url, jobId] of urlToJobId) normalized.set(normalizePageUrl(url), jobId);
  return rows.map((row) => ({ ...row, jobId: normalized.get(row.pageUrl) ?? null }));
}

/**
 * 조회할 날짜(Asia/Seoul 기준 YYYY-MM-DD). GSC 데이터는 2~3일 지연되므로 그만큼 뒤로 물린다 -
 * 오늘 날짜로 부르면 빈 응답이 온다.
 */
export const REPORT_LAG_DAYS = 3;

export function reportDate(now: Date = new Date(), lagDays: number = REPORT_LAG_DAYS): string {
  const kst = new Date(now.getTime() + 9 * 3600 * 1000);
  kst.setUTCDate(kst.getUTCDate() - lagDays);
  return kst.toISOString().slice(0, 10);
}
