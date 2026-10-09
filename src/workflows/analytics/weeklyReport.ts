// 주간 검색 성과 리포트. 순수 함수만 둔다(외부 호출 없음).
//
// 속성(채널)별로 이번 주(최근 7일) vs 전주 클릭·노출·CTR·평균순위, 톱 쿼리·톱 페이지 5개,
// 이상 신호를 만든다. 순위는 노출 가중 평균이다(GSC position과 같은 방식 - normalizeSearchRows.ts).
//
// 데이터가 14일(날짜 수) 미만인 속성은 "축적 중"으로만 표기한다 - 빈약한 데이터로 추이를 말하지 않는다.

export type PerfRow = {
  date: string;
  page_url: string;
  query: string;
  clicks: number;
  impressions: number;
  position: number;
};

export type Totals = { clicks: number; impressions: number; ctr: number; position: number };

export type SiteWeek = {
  site: string;
  /** 이 속성에 데이터가 있는 서로 다른 날짜 수 */
  dataDays: number;
  /** 14일 미만이면 true - 추이 비교를 생략한다 */
  accumulating: boolean;
  current: Totals;
  previous: Totals;
  topQueries: Array<{ query: string; clicks: number; impressions: number }>;
  topPages: Array<{ page: string; clicks: number; impressions: number }>;
  /** 굵게 표시할 이상 신호 */
  alerts: string[];
};

export const MIN_DAYS_FOR_TREND = 14;
/** 클릭이 이 비율 넘게 떨어지면 경보(전주 클릭이 MIN_PREV_CLICKS 이상일 때만). */
export const DROP_RATIO = 0.5;
export const MIN_PREV_CLICKS = 10;

/** page_url의 호스트가 속성 이름이다(티스토리·블로그스팟 모두 도메인이 곧 속성). */
export function siteOf(pageUrl: string): string {
  try {
    return new URL(pageUrl).host;
  } catch {
    return "(알 수 없음)";
  }
}

function addDays(date: string, delta: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

export function totalsOf(rows: PerfRow[]): Totals {
  let clicks = 0;
  let impressions = 0;
  let weighted = 0;
  for (const r of rows) {
    clicks += r.clicks;
    impressions += r.impressions;
    weighted += r.position * r.impressions;
  }
  return {
    clicks,
    impressions,
    ctr: impressions > 0 ? clicks / impressions : 0,
    position: impressions > 0 ? weighted / impressions : 0,
  };
}

function topBy(rows: PerfRow[], key: (r: PerfRow) => string): Array<{ key: string; clicks: number; impressions: number }> {
  const map = new Map<string, { clicks: number; impressions: number }>();
  for (const r of rows) {
    const cur = map.get(key(r)) ?? { clicks: 0, impressions: 0 };
    cur.clicks += r.clicks;
    cur.impressions += r.impressions;
    map.set(key(r), cur);
  }
  return [...map.entries()]
    .map(([k, v]) => ({ key: k, ...v }))
    .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions)
    .slice(0, 5);
}

/**
 * endDate(포함)까지 7일을 이번 주, 그 앞 7일을 전주로 속성별 요약을 만든다.
 * rows는 두 주를 포함하면 되고 속성은 page_url 호스트로 나눈다. `sites`를 주면 데이터가 없어도 그 속성을 항목에 넣는다.
 */
export function buildWeeklyReport(rows: PerfRow[], endDate: string, sites: string[] = []): SiteWeek[] {
  const curStart = addDays(endDate, -6);
  const prevStart = addDays(endDate, -13);
  const prevEnd = addDays(endDate, -7);

  const bySite = new Map<string, PerfRow[]>();
  for (const s of sites) bySite.set(s, []);
  for (const r of rows) {
    const s = siteOf(r.page_url);
    bySite.set(s, [...(bySite.get(s) ?? []), r]);
  }

  return [...bySite.entries()].map(([site, siteRows]) => {
    const cur = siteRows.filter((r) => r.date >= curStart && r.date <= endDate);
    const prev = siteRows.filter((r) => r.date >= prevStart && r.date <= prevEnd);
    const dataDays = new Set(siteRows.map((r) => r.date)).size;
    const accumulating = dataDays < MIN_DAYS_FOR_TREND;
    const current = totalsOf(cur);
    const previous = totalsOf(prev);

    const alerts: string[] = [];
    if (!accumulating && previous.clicks >= MIN_PREV_CLICKS && current.clicks < previous.clicks * (1 - DROP_RATIO)) {
      alerts.push(`클릭 급락 ${previous.clicks} → ${current.clicks}`);
    }

    return {
      site,
      dataDays,
      accumulating,
      current,
      previous,
      topQueries: topBy(cur, (r) => r.query).map(({ key, clicks, impressions }) => ({ query: key, clicks, impressions })),
      topPages: topBy(cur, (r) => r.page_url).map(({ key, clicks, impressions }) => ({ page: key, clicks, impressions })),
      alerts,
    };
  });
}

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function delta(cur: number, prev: number): string {
  if (prev === 0) return cur === 0 ? "–" : "신규";
  const pct = ((cur - prev) / prev) * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(0)}%`;
}

function shortPage(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname === "/" ? u.host : u.pathname;
  } catch {
    return url;
  }
}

/** 텔레그램 HTML 문구. 속성 하나가 메시지 하나다. */
export function buildSiteMessage(week: SiteWeek, endDate: string): string {
  const lines: string[] = [];
  const start = addDays(endDate, -6);
  lines.push(`📊 <b>주간 검색 성과 · ${esc(week.site)}</b>`);
  lines.push(`${start} ~ ${endDate}`);
  lines.push("");

  for (const alert of week.alerts) lines.push(`⚠️ <b>${esc(alert)}</b>`);
  if (week.alerts.length > 0) lines.push("");

  const c = week.current;
  if (week.accumulating) {
    lines.push(`클릭 ${c.clicks} · 노출 ${c.impressions} · CTR ${(c.ctr * 100).toFixed(1)}% · 평균순위 ${c.position ? c.position.toFixed(1) : "–"}`);
    lines.push(`데이터 축적 중(${week.dataDays}/${MIN_DAYS_FOR_TREND}일) - 전주 대비 추이는 2주치가 쌓인 뒤부터 표시합니다.`);
  } else {
    const p = week.previous;
    lines.push(`클릭 ${c.clicks} (${delta(c.clicks, p.clicks)}) · 노출 ${c.impressions} (${delta(c.impressions, p.impressions)})`);
    lines.push(
      `CTR ${(c.ctr * 100).toFixed(1)}% (전주 ${(p.ctr * 100).toFixed(1)}%) · 평균순위 ${c.position ? c.position.toFixed(1) : "–"} (전주 ${p.position ? p.position.toFixed(1) : "–"})`
    );
  }

  if (week.topQueries.length > 0) {
    lines.push("", "<b>톱 쿼리</b>");
    for (const q of week.topQueries) lines.push(`· ${esc(q.query)} - 클릭 ${q.clicks} · 노출 ${q.impressions}`);
  }
  if (week.topPages.length > 0) {
    lines.push("", "<b>톱 페이지</b>");
    for (const p of week.topPages) lines.push(`· ${esc(shortPage(p.page))} - 클릭 ${p.clicks} · 노출 ${p.impressions}`);
  }
  if (week.topQueries.length === 0) lines.push("", "이번 주 검색 노출 기록이 없습니다.");

  return lines.join("\n");
}
