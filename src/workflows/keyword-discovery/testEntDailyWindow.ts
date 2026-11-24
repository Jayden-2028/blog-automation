// 엔터 하루 창 수집(2026-11-25) 오프라인 테스트. 네트워크·DB 접근이 없다 - NAVER 호출은
// globalThis.fetch를 가짜로 바꿔 흉내 낸다(자격증명도 더미).
//
// 고정하는 것:
// 1) 페이지네이션: start=1,101,201 / display=100 / sort=date, 창 밖 문서가 나오면 멈춤
// 2) 상한: 검색어당 문서 상한, 네이버 start 상한(1000), 호출 예산(첫 페이지는 항상 보장)
// 3) 창 판정: 뉴스는 시각, 블로그는 KST 날짜 단위
// 4) 최신 10건 보존: 창 밖이어도 앞 10건은 남긴다(커버리지 보존)
// 5) 하루 창을 안 넘기면 요청이 기존과 같다(start 파라미터 없음, display=10)
// 6) env 해석과 롤백 스위치(ENT_NAVER_WINDOW_HOURS=0)

import {
  ENT_DAILY_WINDOW_DEFAULTS,
  resolveEntDailyWindowConfig,
} from "../../config/entertainmentDailyWindow.js";
import {
  NaverCallBudget,
  blogWindowVerdict,
  newsWindowVerdict,
  paginateUntilWindow,
  type WindowVerdict,
} from "../../services/search/naver/naverDailyWindow.js";
import { NaverNewsKeywordProvider } from "../../services/search/providers/NaverNewsKeywordProvider.js";
import { collectNaverCandidates } from "./collectNaverCandidates.js";
import { formatRankDiagnosticLine } from "../dailyKeywordWorkflow.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

// 18:00 KST = 09:00 UTC
const NOW = new Date("2026-11-25T09:00:00.000Z");
const HOUR = 60 * 60 * 1000;

type FakeItem = { id: number; verdict: WindowVerdict };

/** position < inWindowCount 은 창 안, 그 뒤는 창 밖인 가짜 검색 결과. total개까지만 있다. */
function fakeSource(total: number, inWindowCount: number) {
  const calls: { start: number; display: number }[] = [];
  const fetchPage = async (start: number, display: number): Promise<FakeItem[]> => {
    calls.push({ start, display });
    const items: FakeItem[] = [];
    for (let position = start - 1; position < Math.min(total, start - 1 + display); position++) {
      items.push({ id: position, verdict: position < inWindowCount ? "in" : "out" });
    }
    return items;
  };
  return { calls, fetchPage };
}

async function testPagination(): Promise<void> {
  // 창 안 문서가 150건: 1쪽(100) + 2쪽에서 창 밖을 만나 멈춘다.
  {
    const source = fakeSource(1000, 150);
    const result = await paginateUntilWindow({ fetchPage: source.fetchPage, verdict: (i) => i.verdict, maxDocs: 300 });
    assert(source.calls.length === 2, `창 150건이면 2쪽에서 멈춰야 한다 (실제 ${source.calls.length})`);
    assert(source.calls[0].start === 1 && source.calls[1].start === 101, "start는 1, 101이어야 한다");
    assert(source.calls.every((call) => call.display === 100), "display는 100이어야 한다");
    assert(result.stopReason === "window", `멈춘 이유는 window (실제 ${result.stopReason})`);
    assert(result.items.length === 150, `창 안 150건만 남아야 한다 (실제 ${result.items.length})`);
    assert(result.droppedOutOfWindow === 50, `2쪽 창 밖 50건은 버린다 (실제 ${result.droppedOutOfWindow})`);
  }
  console.log("✅ 창 밖 문서를 만나면 그 검색어는 멈추고 창 밖은 버린다");

  // 창이 상한보다 넓다: 300에서 멈춘다(3쪽).
  {
    const source = fakeSource(1000, 900);
    const result = await paginateUntilWindow({ fetchPage: source.fetchPage, verdict: (i) => i.verdict, maxDocs: 300 });
    assert(source.calls.map((c) => c.start).join(",") === "1,101,201", "start=1,101,201");
    assert(result.stopReason === "cap" && result.items.length === 300, "검색어당 상한 300에서 멈춘다");
  }
  console.log("✅ 검색어당 상한(300)에서 멈춘다");

  // 상한이 100의 배수가 아니면 마지막 쪽 display를 줄인다.
  {
    const source = fakeSource(1000, 900);
    const result = await paginateUntilWindow({ fetchPage: source.fetchPage, verdict: (i) => i.verdict, maxDocs: 150 });
    assert(source.calls.map((c) => c.display).join(",") === "100,50", "상한 150이면 display 100, 50");
    assert(result.items.length === 150, "150건");
  }
  console.log("✅ 상한이 쪽 경계가 아니면 마지막 쪽 display를 줄인다");

  // 결과가 적으면(마지막 쪽이 덜 찼다) 멈춘다.
  {
    const source = fakeSource(42, 42);
    const result = await paginateUntilWindow({ fetchPage: source.fetchPage, verdict: (i) => i.verdict, maxDocs: 300 });
    assert(source.calls.length === 1 && result.stopReason === "exhausted" && result.items.length === 42, "42건이면 1쪽으로 끝");
  }
  console.log("✅ 결과가 다 떨어지면 멈춘다");

  // 네이버 start 상한(1000): start=901 다음(1001)은 요청하지 않는다.
  {
    const source = fakeSource(5000, 5000);
    const result = await paginateUntilWindow({ fetchPage: source.fetchPage, verdict: (i) => i.verdict, maxDocs: 3000 });
    assert(source.calls.length === 10 && source.calls[9].start === 901, `start 901까지 10쪽 (실제 ${source.calls.length})`);
    assert(result.stopReason === "startLimit" && result.items.length === 1000, "start 상한에서 1000건으로 멈춘다");
  }
  console.log("✅ 네이버 start 상한(1000)을 넘는 쪽은 요청하지 않는다");

  // 최신 10건 보존: 창 안이 3건뿐이어도 앞 10건은 남긴다(기존 수집분).
  {
    const source = fakeSource(1000, 3);
    const result = await paginateUntilWindow({ fetchPage: source.fetchPage, verdict: (i) => i.verdict, maxDocs: 300 });
    assert(source.calls.length === 1, "1쪽에서 창 밖을 만나 멈춘다");
    assert(result.items.length === 10, `앞 10건은 창 밖이어도 남긴다 (실제 ${result.items.length})`);
    assert(result.items.map((i) => i.id).join(",") === "0,1,2,3,4,5,6,7,8,9", "남는 것은 앞 10건이다");
    assert(result.droppedOutOfWindow === 90, "나머지 90건은 버린다");
  }
  console.log("✅ 창 밖이어도 앞 10건(기존 수집분)은 남긴다");

  // 날짜 모름은 버리지 않고 멈출 근거로도 쓰지 않는다.
  {
    const fetchPage = async (start: number, display: number): Promise<FakeItem[]> =>
      Array.from({ length: display }, (_, i) => ({ id: start - 1 + i, verdict: "unknown" as const }));
    const result = await paginateUntilWindow({ fetchPage, verdict: (i) => i.verdict, maxDocs: 200 });
    assert(result.stopReason === "cap" && result.items.length === 200, "날짜 모름은 창 안처럼 계속 받는다");
  }
  console.log("✅ 날짜를 모르는 문서는 버리지 않는다");

  // 추가 쪽 실패: 앞 쪽은 살린다. 첫 쪽 실패: 그대로 던진다(provider의 검색어 단위 실패 처리).
  {
    const source = fakeSource(1000, 900);
    const failing = async (start: number, display: number) => {
      if (start > 1) throw new Error("boom");
      return source.fetchPage(start, display);
    };
    const result = await paginateUntilWindow({ fetchPage: failing, verdict: (i) => i.verdict, maxDocs: 300 });
    assert(result.stopReason === "pageError" && result.items.length === 100, "2쪽 실패면 1쪽 100건으로 끝");

    let threw = false;
    try {
      await paginateUntilWindow({
        fetchPage: async () => {
          throw new Error("first");
        },
        verdict: () => "in",
        maxDocs: 300,
      });
    } catch {
      threw = true;
    }
    assert(threw, "첫 쪽 실패는 던져야 한다");
  }
  console.log("✅ 추가 쪽 실패는 앞 쪽을 살리고, 첫 쪽 실패는 던진다");
}

async function testBudget(): Promise<void> {
  // 검색어 3개 x (뉴스) 첫 쪽 예약 3, 상한 5 -> 추가 쪽은 2번만 허용.
  const budget = new NaverCallBudget(5, 3);
  const pagesPerQuery: number[] = [];
  for (let q = 0; q < 3; q++) {
    const source = fakeSource(1000, 900);
    const result = await paginateUntilWindow({
      fetchPage: source.fetchPage,
      verdict: (i) => i.verdict,
      maxDocs: 300,
      budget,
    });
    pagesPerQuery.push(result.pages);
  }
  assert(budget.used === 5, `호출은 상한 5를 넘지 않는다 (실제 ${budget.used})`);
  assert(pagesPerQuery.join(",") === "3,1,1", `첫 검색어가 추가 2쪽, 나머지는 첫 쪽만 (실제 ${pagesPerQuery})`);
  assert(budget.denied === 2, `거절된 추가 쪽 2건 (실제 ${budget.denied})`);

  // 첫 쪽 예약분이 상한보다 많아도 첫 쪽은 항상 받는다.
  const tight = new NaverCallBudget(1, 3);
  for (let q = 0; q < 3; q++) {
    const source = fakeSource(1000, 900);
    const result = await paginateUntilWindow({ fetchPage: source.fetchPage, verdict: (i) => i.verdict, maxDocs: 300, budget: tight });
    assert(result.pages === 1 && result.stopReason === "budget", "첫 쪽만 받고 예산에서 멈춘다");
  }
  console.log("✅ 호출 예산: 추가 쪽만 막고 모든 검색어의 첫 쪽은 보장한다");
}

function testVerdicts(): void {
  const rfc = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * HOUR).toUTCString();
  assert(newsWindowVerdict(rfc(9), NOW, 24) === "in", "오전 9시 기사(9시간 전)는 창 안");
  assert(newsWindowVerdict(rfc(23.9), NOW, 24) === "in", "23.9시간 전은 창 안");
  assert(newsWindowVerdict(rfc(24.1), NOW, 24) === "out", "24.1시간 전은 창 밖");
  assert(newsWindowVerdict(rfc(-1), NOW, 24) === "in", "미래 시각은 창 안");
  assert(newsWindowVerdict("not a date", NOW, 24) === "unknown", "파싱 실패는 unknown");
  assert(newsWindowVerdict("Tue, 25 Nov 2026 09:05:00 +0900", NOW, 24) === "in", "RFC 822 +0900 오전 기사");

  // 18:00 KST 실행 -> 창 시작 11/24 18:00 KST -> 블로그는 11/24 글부터 창 안.
  assert(blogWindowVerdict("20261125", NOW, 24) === "in", "오늘 블로그는 창 안");
  assert(blogWindowVerdict("20261124", NOW, 24) === "in", "어제 블로그는 창 안(날짜 단위)");
  assert(blogWindowVerdict("20261123", NOW, 24) === "out", "그제 블로그는 창 밖");
  assert(blogWindowVerdict("2026112", NOW, 24) === "unknown", "형식 오류는 unknown");
  // 00:30 KST 실행(= 전날 15:30 UTC)이면 창 시작은 전날 00:30 KST -> 전날 글부터.
  const lateNight = new Date("2026-11-25T15:30:00.000Z"); // 11/26 00:30 KST
  assert(blogWindowVerdict("20261125", lateNight, 24) === "in", "자정 넘은 실행: 전날 글은 창 안");
  assert(blogWindowVerdict("20261124", lateNight, 24) === "out", "자정 넘은 실행: 그 전날은 창 밖");
  console.log("✅ 창 판정: 뉴스는 시각, 블로그는 KST 날짜 단위");
}

type FetchCall = { path: string; params: URLSearchParams };

function installFakeFetch(handler: (call: FetchCall) => unknown): { calls: FetchCall[]; restore: () => void } {
  const realFetch = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const call = { path: url.pathname, params: url.searchParams };
    calls.push(call);
    return new Response(JSON.stringify(handler(call)), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = realFetch) };
}

function pubDateHoursAgo(hours: number): string {
  return new Date(NOW.getTime() - hours * HOUR).toUTCString();
}

async function testProviderRequests(): Promise<void> {
  process.env.NAVER_CLIENT_ID = "dummy-id";
  process.env.NAVER_CLIENT_SECRET = "dummy-secret";

  // 하루 창 없이: 기존 요청 그대로(display=10, start 없음).
  {
    const fake = installFakeFetch(() => ({ lastBuildDate: "", total: 0, start: 1, display: 10, items: [] }));
    try {
      await new NaverNewsKeywordProvider({ queries: ["캐스팅"], requestDelayMs: 0 }).fetchKeywords();
    } finally {
      fake.restore();
    }
    assert(fake.calls.length === 1, "기존 경로는 1회 호출");
    assert(fake.calls[0].params.get("display") === "10", "기존 경로 display=10");
    assert(!fake.calls[0].params.has("start"), "기존 경로는 start를 보내지 않는다");
    assert(fake.calls[0].params.get("sort") === "date", "기존 경로 sort=date");
  }
  console.log("✅ 하루 창을 안 넘기면 NAVER 요청이 기존과 같다");

  // 하루 창: 뉴스 130건이 창 안(0.1h 간격), 그 뒤는 30시간 전.
  {
    const newsItem = (position: number) => ({
      title: `<b>캐스팅</b> 기사 ${position}`,
      originallink: `https://news.example/${position}`,
      link: `https://n.news.example/${position}`,
      description: "설명",
      pubDate: position < 130 ? pubDateHoursAgo(position * 0.1) : pubDateHoursAgo(30 + position),
    });
    const fake = installFakeFetch((call) => {
      const start = Number(call.params.get("start") ?? "1");
      const display = Number(call.params.get("display"));
      return {
        lastBuildDate: "",
        total: 5000,
        start,
        display,
        items: Array.from({ length: display }, (_, i) => newsItem(start - 1 + i)),
      };
    });
    let keywords;
    const provider = new NaverNewsKeywordProvider({
      queries: ["캐스팅"],
      requestDelayMs: 0,
      dailyWindow: { windowHours: 24, maxDocsPerQuery: 300, now: NOW },
    });
    try {
      keywords = await provider.fetchKeywords();
    } finally {
      fake.restore();
    }
    assert(fake.calls.length === 2, `2쪽 호출 (실제 ${fake.calls.length})`);
    assert(fake.calls[1].params.get("start") === "101", "2쪽 start=101");
    assert(fake.calls.every((c) => c.params.get("sort") === "date" && c.params.get("display") === "100"), "sort=date, display=100");
    assert(keywords.length === 130, `창 안 130건 (실제 ${keywords.length})`);
    const stats = provider.getWindowStats();
    assert(stats.length === 1 && stats[0].stopReason === "window" && stats[0].pages === 2, "통계: window에서 2쪽");
  }
  console.log("✅ 뉴스 provider: 하루 창 페이지네이션 요청(start/display/sort)과 창 컷");
}

async function testCollectWithWindow(): Promise<void> {
  // 검색어 2개. 뉴스: "넓은" 시드는 창이 상한보다 넓고, "좁은" 시드는 20건. 블로그: 둘 다 오늘 글 150건.
  const queries = ["넓은 시드", "좁은 시드"];
  const fake = installFakeFetch((call) => {
    const query = call.params.get("query") ?? "";
    const start = Number(call.params.get("start") ?? "1");
    const display = Number(call.params.get("display"));
    if (call.path.endsWith("/news")) {
      const total = query === "넓은 시드" ? 5000 : 20;
      const count = Math.max(0, Math.min(display, total - (start - 1)));
      return {
        items: Array.from({ length: count }, (_, i) => ({
          title: `${query} 뉴스 ${start + i}`,
          originallink: `https://news.example/${encodeURIComponent(query)}/${start + i}`,
          link: "",
          description: query,
          pubDate: pubDateHoursAgo(((start - 1 + i) % 200) * 0.05),
        })),
      };
    }
    if (call.path.endsWith("/blog")) {
      return {
        items: Array.from({ length: display }, (_, i) => ({
          title: `${query} 블로그 ${start + i}`,
          link: `https://blog.example/${encodeURIComponent(query)}/${start + i}`,
          description: query,
          bloggername: "b",
          bloggerlink: "",
          postdate: "20261125",
        })),
      };
    }
    return {
      items: Array.from({ length: Number(call.params.get("display")) }, (_, i) => ({
        title: `${query} 웹 ${i}`,
        link: `https://web.example/${encodeURIComponent(query)}/${i}`,
        description: query,
      })),
    };
  });

  let result;
  try {
    result = await collectNaverCandidates(queries, {
      requestDelayMs: 0,
      now: NOW,
      dailyWindow: { windowHours: 24, maxNewsPerQuery: 300, maxBlogPerQuery: 100, maxCalls: 500 },
    });
  } finally {
    fake.restore();
  }

  const summary = result.dailyWindow;
  assert(summary, "하루 창 요약이 있어야 한다");
  assert(summary.news.kept === 320, `뉴스 300 + 20 = 320 (실제 ${summary.news.kept})`);
  assert(summary.news.cappedQueries.join(",") === "넓은 시드", "상한 도달 검색어는 넓은 시드뿐");
  assert(summary.blog.kept === 200, `블로그는 검색어당 100 (실제 ${summary.blog.kept})`);
  assert(summary.callsUsed === 3 + 1 + 1 + 1, `뉴스 3+1, 블로그 1+1 = 6회 (실제 ${summary.callsUsed})`);
  const webCalls = fake.calls.filter((c) => c.path.endsWith("/webkr"));
  assert(webCalls.length === 2 && webCalls.every((c) => c.params.get("display") === "10"), "웹문서는 기존대로 10건 1쪽");
  assert(result.countsByQuery["넓은 시드"].naver_news === 300, "countsByQuery도 하루 창 건수");
  console.log(
    `✅ collectNaverCandidates 하루 창: 뉴스 ${summary.news.kept} · 블로그 ${summary.blog.kept} · 호출 ${summary.callsUsed} · 웹문서는 10건 유지`
  );

  // 예산이 빡빡하면 추가 쪽만 막힌다: 상한 4 = 첫 쪽 4(검색어 2 x 뉴스·블로그)뿐.
  const fake2 = installFakeFetch((call) => {
    const display = Number(call.params.get("display"));
    const start = Number(call.params.get("start") ?? "1");
    return {
      items: Array.from({ length: display }, (_, i) => ({
        title: `${call.params.get("query")} ${call.path} ${start + i}`,
        originallink: `https://x.example/${call.path}/${call.params.get("query")}/${start + i}`,
        link: `https://x.example/${call.path}/${call.params.get("query")}/${start + i}`,
        description: "",
        pubDate: pubDateHoursAgo(0.5),
        postdate: "20261125",
        bloggername: "",
        bloggerlink: "",
      })),
    };
  });
  let tight;
  try {
    tight = await collectNaverCandidates(queries, {
      requestDelayMs: 0,
      now: NOW,
      dailyWindow: { windowHours: 24, maxNewsPerQuery: 300, maxBlogPerQuery: 300, maxCalls: 4 },
    });
  } finally {
    fake2.restore();
  }
  assert(tight.dailyWindow?.callsUsed === 4, `호출 4회로 끝 (실제 ${tight.dailyWindow?.callsUsed})`);
  assert((tight.dailyWindow?.budgetDeniedPages ?? 0) === 4, "추가 쪽 4건 거절");
  console.log("✅ 호출 상한: 첫 쪽(검색어 x 뉴스·블로그)은 보장, 추가 쪽만 거절");
}

function testEnvConfig(): void {
  const defaults = resolveEntDailyWindowConfig({});
  assert(defaults !== null, "기본은 켜짐");
  assert(defaults.windowHours === ENT_DAILY_WINDOW_DEFAULTS.windowHours, "기본 24h");
  assert(defaults.maxNewsPerQuery === 300 && defaults.maxBlogPerQuery === 100 && defaults.maxCalls === 500, "기본 상한");
  assert(defaults.scoringProfile.freshness.fullScoreWithinHours === 24, "점수 프로필 창 = 수집 창");
  assert(defaults.diagnosticTopN === 50, "진단 상위 50");

  assert(resolveEntDailyWindowConfig({ ENT_NAVER_WINDOW_HOURS: "0" }) === null, "0이면 꺼짐(롤백)");
  assert(resolveEntDailyWindowConfig({ ENT_NAVER_WINDOW_HOURS: "" })?.windowHours === 24, "빈 값은 기본");
  assert(resolveEntDailyWindowConfig({ ENT_NAVER_WINDOW_HOURS: "abc" })?.windowHours === 24, "숫자 아님은 기본");
  const custom = resolveEntDailyWindowConfig({
    ENT_NAVER_WINDOW_HOURS: "36",
    ENT_NAVER_MAX_NEWS_PER_QUERY: "200",
    ENT_NAVER_MAX_BLOG_PER_QUERY: "0",
    ENT_NAVER_MAX_CALLS: "800",
  });
  assert(custom?.windowHours === 36 && custom.maxNewsPerQuery === 200 && custom.maxCalls === 800, "env 덮어쓰기");
  assert(custom.maxBlogPerQuery === 100, "0 이하 상한은 기본으로 되돌린다");
  assert(custom.scoringProfile.newsVelocity.recentWindowHours === 36, "점수 프로필도 창을 따라간다");
  console.log("✅ env 해석과 롤백 스위치(ENT_NAVER_WINDOW_HOURS=0)");
}

function testDiagnosticLine(): void {
  const line = formatRankDiagnosticLine({
    rank: 7,
    keyword: "수지 현혹 공개일 확정",
    seedQuery: "공개일 확정",
    totalScore: 61,
    scoreBreakdown: {
      trendMomentum: 18,
      newsVelocity: 14,
      contentDemand: 9,
      freshness: 15,
      crossSourceSignal: 6,
      clickPotential: 8,
      total: 61,
    },
    newsCount: 17,
    blogCount: 4,
    webCount: 0,
    earliestPublishedAt: "2026-11-25T00:12:00.000Z",
    latestPublishedAt: "2026-11-25T07:40:00.000Z",
  });
  for (const fragment of [
    "# 7  61점",
    "[추세 18 뉴스 14 수요 9 신선 15 교차 6 클릭 8]",
    "기사 17·블로그 4·웹 0",
    "(11/25 09:12 ~ 11/25 16:40)",
    "수지 현혹 공개일 확정  <- 시드: 공개일 확정",
  ]) {
    assert(line.includes(fragment), `진단 줄에 "${fragment}"가 있어야 한다: ${line}`);
  }
  console.log(`✅ 점수 진단 한 줄: ${line}`);
}

async function main(): Promise<void> {
  console.log("▶ 엔터 하루 창 수집 테스트 (오프라인)\n");
  await testPagination();
  await testBudget();
  testVerdicts();
  await testProviderRequests();
  await testCollectWithWindow();
  testEnvConfig();
  testDiagnosticLine();
  console.log("\n✅ 엔터 하루 창 수집 테스트 완료");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
