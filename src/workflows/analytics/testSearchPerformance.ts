// 성과 수집의 순수 로직 테스트. 외부 호출 없음. 실행: npm run test:search-performance
import { buildAssertion, mapAnalyticsRows } from "../../services/searchConsole/SearchConsoleClient.js";
import { aggregateRows, attachJobIds, normalizePageUrl, reportDate } from "./normalizeSearchRows.js";
import { buildHealthMessage, buildReport, classifyCoverage } from "./classifyIndexHealth.js";
import { buildSiteMessage, buildWeeklyReport, siteOf } from "./weeklyReport.js";
import type { PerfRow } from "./weeklyReport.js";
import { mapGa4Rows } from "../../services/ga4/Ga4Client.js";
import { belongsToSite, resolveSiteUrls, siteLabel } from "./siteUrls.js";
import type { SearchAnalyticsRow } from "../../services/searchConsole/SearchConsoleClient.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const POST = "https://whynowissue.blogspot.com/2026/09/blog-post_21.html";

// --- 1. 주소 정규화 - 모바일 파라미터가 같은 글로 합쳐지는 근거 -------------------------------
{
  assert(normalizePageUrl(`${POST}?m=1`) === POST, "?m=1이 떨어져야 한다");
  assert(normalizePageUrl(`${POST}#comments`) === POST, "프래그먼트가 떨어져야 한다");
  assert(normalizePageUrl(`${POST}?m=1&utm_source=x`) === POST, "추적 파라미터도 떨어져야 한다");
  assert(normalizePageUrl("주소가아님") === "주소가아님", "파싱 실패는 원본 유지");
  console.log("✅ 주소 정규화 - ?m=1·프래그먼트·추적 파라미터 제거");
}

// --- 2. 모바일/데스크톱 합산 - 순위는 노출 가중 평균이어야 한다 -------------------------------
{
  const rows: SearchAnalyticsRow[] = [
    { date: "2026-09-18", pageUrl: POST, query: "공무원 수당", clicks: 3, impressions: 40, ctr: 0.075, position: 8.2 },
    { date: "2026-09-18", pageUrl: `${POST}?m=1`, query: "공무원 수당", clicks: 5, impressions: 61, ctr: 0.082, position: 7.4 },
  ];
  const merged = aggregateRows(rows);

  assert(merged.length === 1, `한 줄로 합쳐져야 한다 (${merged.length}줄)`);
  assert(merged[0].clicks === 8 && merged[0].impressions === 101, "클릭·노출은 단순 합");
  // 단순 평균이면 7.8. 노출 가중이면 (8.2*40 + 7.4*61)/101 = 7.7168...
  const expected = (8.2 * 40 + 7.4 * 61) / 101;
  assert(Math.abs(merged[0].position - expected) < 1e-9, `순위가 노출 가중 평균이어야 한다 (${merged[0].position})`);
  assert(Math.abs(merged[0].position - 7.8) > 0.05, "단순 평균(7.8)이 되면 안 된다");
  assert(Math.abs(merged[0].ctr - 8 / 101) < 1e-9, "CTR은 합산 후 다시 계산해야 한다");
  console.log("✅ 모바일/데스크톱 합산 - 순위는 노출 가중 평균, CTR은 재계산");
}

// --- 3. 다른 검색어·다른 글은 합치지 않는다 ----------------------------------------------------
{
  const rows: SearchAnalyticsRow[] = [
    { date: "2026-09-18", pageUrl: POST, query: "a", clicks: 1, impressions: 10, ctr: 0.1, position: 5 },
    { date: "2026-09-18", pageUrl: POST, query: "b", clicks: 1, impressions: 10, ctr: 0.1, position: 5 },
    { date: "2026-09-19", pageUrl: POST, query: "a", clicks: 1, impressions: 10, ctr: 0.1, position: 5 },
  ];
  assert(aggregateRows(rows).length === 3, "날짜·검색어가 다르면 별개 행이다");
  console.log("✅ 날짜·검색어가 다르면 합치지 않는다");
}

// --- 4. job 매칭 - 저장된 주소에 파라미터가 있든 없든 붙는다 -----------------------------------
{
  const merged = aggregateRows([
    { date: "2026-09-18", pageUrl: `${POST}?m=1`, query: "q", clicks: 1, impressions: 2, ctr: 0.5, position: 3 },
    { date: "2026-09-18", pageUrl: "https://whynowissue.blogspot.com/2026/09/없는글.html", query: "q", clicks: 1, impressions: 2, ctr: 0.5, position: 3 },
  ]);
  const attached = attachJobIds(merged, new Map([[POST, "job-abc"]]));

  assert(attached.find((r) => r.pageUrl === POST)?.jobId === "job-abc", "정규화 후 job이 붙어야 한다");
  assert(attached.find((r) => r.pageUrl !== POST)?.jobId === null, "모르는 글은 null - 저장은 하되 매칭만 비운다");
  console.log("✅ job 매칭 - 모바일 주소도 붙고, 모르는 글은 null로 저장");
}

// --- 5. 조회 날짜 - GSC 지연만큼 뒤로 물린다 ----------------------------------------------------
{
  // 2026-09-21 09:00 KST == 2026-09-21T00:00:00Z
  assert(reportDate(new Date("2026-09-21T00:00:00Z")) === "2026-09-18", `3일 전이어야 한다 (${reportDate(new Date("2026-09-21T00:00:00Z"))})`);
  // KST 경계: 2026-09-21 08:00 KST == 전날 23:00Z. KST 기준으로 계산해야 하루가 안 밀린다.
  assert(reportDate(new Date("2026-09-20T23:00:00Z")) === "2026-09-18", "KST 자정 이후면 같은 날로 계산해야 한다");
  console.log("✅ 조회 날짜 - KST 기준 3일 전");
}

// --- 6. 응답 매핑 - 형태가 깨진 행은 버리고 나머지는 살린다 -------------------------------------
{
  const mapped = mapAnalyticsRows({
    rows: [
      { keys: ["2026-09-18", POST, "질의"], clicks: 2.0, impressions: 30.0, ctr: 0.0666, position: 6.5 },
      { keys: ["2026-09-18", POST] }, // 축이 모자란 행
      { clicks: 1 }, // keys 없음
    ],
  });
  assert(mapped.length === 1, `깨진 행은 버려야 한다 (${mapped.length}건)`);
  assert(mapped[0].clicks === 2 && mapped[0].impressions === 30, "지표가 정수로 들어와야 한다");
  assert(mapAnalyticsRows({}).length === 0, "rows 없으면 빈 배열");
  console.log("✅ 응답 매핑 - 깨진 행 격리");
}

// --- 7. JWT 서명 - 환경변수를 거치며 굳은 "\\n"을 되돌린다 ---------------------------------------
{
  // 테스트 전용 키(이 저장소 밖에서 쓰이지 않는다).
  const { generateKeyPairSync } = await import("node:crypto");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const normal = buildAssertion({ client_email: "a@b.iam.gserviceaccount.com", private_key: pem }, new Date("2026-09-21T00:00:00Z"));
  const escaped = buildAssertion(
    { client_email: "a@b.iam.gserviceaccount.com", private_key: pem.replace(/\n/g, "\\n") },
    new Date("2026-09-21T00:00:00Z")
  );
  assert(normal === escaped, "줄바꿈이 문자열로 굳은 키도 같은 서명이 나와야 한다");
  assert(normal.split(".").length === 3, "JWT는 세 토막이어야 한다");

  const claim = JSON.parse(Buffer.from(normal.split(".")[1], "base64url").toString());
  assert(claim.scope.endsWith("webmasters.readonly"), "읽기 전용 스코프여야 한다");
  assert(claim.exp - claim.iat === 3600, "만료는 1시간");
  console.log("✅ JWT 서명 - 굳은 줄바꿈 복원, 읽기 전용 스코프");
}

// --- 8. 색인 상태 분류 - 고장만 고장으로 본다 ---------------------------------------------------
{
  // 실제 우리 블로그에서 나온 상태값들(2026-09-21 실측).
  assert(classifyCoverage("Redirect error") === "broken", "리디렉션 오류는 고장");
  assert(classifyCoverage("Not found (404)") === "broken", "404는 고장");
  assert(classifyCoverage("Server error (5xx)") === "broken", "5xx는 고장");
  assert(classifyCoverage("Blocked by robots.txt") === "broken", "robots 차단은 고장");
  assert(classifyCoverage("Excluded by 'noindex' tag") === "broken", "noindex는 고장");

  assert(classifyCoverage("Submitted and indexed") === "indexed", "색인 완료");
  assert(classifyCoverage("Indexed, not submitted in sitemap") === "indexed", "사이트맵 밖이어도 색인은 색인");

  // **여기가 핵심이다** - 신생 블로그의 정상 상태를 고장으로 치면 매주 거짓 경보가 된다.
  assert(classifyCoverage("Discovered - currently not indexed") === "pending", "발견됨은 고장이 아니다");
  assert(classifyCoverage("Crawled - currently not indexed") === "pending", "크롤링됨은 고장이 아니다");
  assert(classifyCoverage("URL is unknown to Google") === "pending", "모르는 URL은 고장이 아니다");

  // 모르는 상태를 고장으로 치지 않는다(구글이 문구를 바꿔도 거짓 경보가 안 나야 한다).
  assert(classifyCoverage("어떤 새로운 상태") === "pending", "모르는 상태는 대기로 떨어진다");
  assert(classifyCoverage("") === "pending", "빈 문자열도 대기");
  console.log("✅ 색인 상태 분류 - 대기와 고장을 가른다(거짓 경보 방지)");
}

// --- 9. 알림 문구 - 평소엔 짧게, 고장이면 목록을 붙인다 -----------------------------------------
{
  const inspect = (url: string, coverageState: string) => ({
    url, coverageState, verdict: "NEUTRAL", robotsTxtState: "", pageFetchState: "",
    lastCrawlTime: null as string | null, googleCanonical: null,
  });

  const healthy = buildReport([
    inspect("https://b.com/a.html", "Submitted and indexed"),
    inspect("https://b.com/b.html", "Discovered - currently not indexed"),
  ]);
  const healthyMsg = buildHealthMessage(healthy, 2);
  assert(!healthyMsg.includes("고장 발견"), "고장이 없으면 경보 제목이 아니어야 한다");
  assert(healthyMsg.includes("색인됨 1"), "집계가 들어가야 한다");
  assert(!healthyMsg.includes("손봐야 할 글"), "고장이 없으면 목록을 붙이지 않는다");

  const broken = inspect("https://b.com/2026/09/57.html", "Redirect error");
  broken.lastCrawlTime = "2026-09-20T18:07:42Z"; // KST 2026-09-21 03:07
  const brokenMsg = buildHealthMessage(buildReport([broken]), 1);
  assert(brokenMsg.includes("고장 발견"), "고장이 있으면 제목이 바뀌어야 한다");
  assert(brokenMsg.includes("/2026/09/57.html") && brokenMsg.includes("Redirect error"), "어느 글이 왜인지 나와야 한다");

  // **마지막 크롤링 시각이 반드시 있어야 한다**(2026-09-21 실측): API가 보는 건 과거 기록이라,
  // 시각이 없으면 이미 해결된 문제로 사람을 불러내게 된다. 실제로 홈페이지가 API로는 고장인데
  // GSC 실시간 테스트는 통과했다.
  assert(brokenMsg.includes("2026-09-21 03:07"), `마지막 크롤링 시각(KST)이 나와야 한다 (${brokenMsg})`);
  assert(brokenMsg.includes("실제 URL 테스트"), "현재 상태를 확인하라는 안내가 있어야 한다");

  // 전부 대기인 신생 블로그 - 걱정할 일이 아님을 같이 알린다(오늘 우리 상태가 이것이다).
  const freshMsg = buildHealthMessage(buildReport([inspect("https://b.com/a.html", "URL is unknown to Google")]), 1);
  assert(freshMsg.includes("2~4주"), "전부 대기면 기다리면 된다는 안내가 있어야 한다");
  assert(buildHealthMessage(healthy, 2, "wooahpapa.tistory.com").includes("wooahpapa.tistory.com"), "속성 이름이 제목에 붙는다");
  console.log("✅ 알림 문구 - 정상이면 짧게, 고장이면 목록 첨부");
}

// --- 8. 다중 속성 - 목록 해석·단일 폴백·타 채널 job 매칭 무해성 -------------------------------
{
  const A = "https://whynowissue.blogspot.com/";
  const B = "https://thekoreamanual.blogspot.com/";
  const T = "https://wooahpapa.tistory.com/";

  assert(resolveSiteUrls({ GSC_SITE_URLS: `${A}, ${B} ,,${T},${A}` }).join("|") === [A, B, T].join("|"), "콤마 분리·공백/빈칸/중복 제거·순서 유지");
  assert(resolveSiteUrls({ GSC_SITE_URL: A }).join("|") === A, "GSC_SITE_URLS가 없으면 단일 값 폴백");
  assert(resolveSiteUrls({ GSC_SITE_URLS: "  ", GSC_SITE_URL: A }).join("|") === A, "빈 목록은 단일 값 폴백");
  assert(resolveSiteUrls({ GSC_SITE_URLS: B, GSC_SITE_URL: A }).join("|") === B, "목록이 있으면 목록이 이긴다");
  assert(resolveSiteUrls({}).length === 0, "둘 다 없으면 빈 목록");

  assert(siteLabel(T) === "wooahpapa.tistory.com" && siteLabel("sc-domain:x.com") === "x.com", "표시 이름");

  assert(belongsToSite(`${A}2026/09/a.html`, A) && !belongsToSite(`${B}2026/10/b.html`, A), "접두어 속성 소속");
  assert(belongsToSite("https://m.x.com/a", "sc-domain:x.com") && !belongsToSite("https://notx.com/a", "sc-domain:x.com"), "도메인 속성은 하위 도메인까지, 접미 우연 일치는 제외");

  // 타 채널 URL이 매칭표에 섞여 있어도 각 행은 자기 URL로만 붙고, 없으면 null(무해).
  const merged = aggregateRows([
    { date: "2026-10-05", pageUrl: `${B}2026/10/guide.html?m=1`, query: "q", clicks: 1, impressions: 3, ctr: 0.3, position: 4 },
    { date: "2026-10-05", pageUrl: `${T}12`, query: "q", clicks: 0, impressions: 5, ctr: 0, position: 9 },
  ]);
  const attached = attachJobIds(merged, new Map([[`${A}2026/09/x.html`, "job-a"], [`${B}2026/10/guide.html`, "job-b"]]));
  assert(attached[0].jobId === "job-b", "TKM 글은 자기 job에 붙는다");
  assert(attached[1].jobId === null, "매칭표에 없는 티스토리 글은 null로 비켜 간다");
  console.log("✅ 다중 속성 - 목록 해석·단일 폴백·소속 판정·타 채널 job 매칭 무해");
}

// --- 9. 주간 리포트 - 추이·축적 중 분기·경보·속성 분리 ----------------------------------------
{
  const A = "https://a.blogspot.com/p1.html";
  const T = "https://t.tistory.com/1";
  const mk = (date: string, page_url: string, clicks: number, impressions = clicks * 10): PerfRow =>
    ({ date, page_url, query: "q" + (clicks % 3), clicks, impressions, position: 5 });
  const end = "2026-10-20";
  const days = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => {
    const d = new Date("2026-10-20T00:00:00Z"); d.setUTCDate(d.getUTCDate() - (to - i)); return d.toISOString().slice(0, 10);
  });

  // A: 14일 이상, 전주 20/일 → 이번 주 2/일(급락). T: 3일치만.
  const rows: PerfRow[] = [
    ...days(0, 13).map((d, i) => mk(d, A, i < 7 ? 20 : 2)),
    ...days(0, 2).map((d) => mk(d, T, 1)),
  ];
  const weeks = buildWeeklyReport(rows, end, ["a.blogspot.com", "t.tistory.com", "empty.example"]);
  const a = weeks.find((w) => w.site === "a.blogspot.com")!;
  const t = weeks.find((w) => w.site === "t.tistory.com")!;
  const e = weeks.find((w) => w.site === "empty.example")!;

  assert(siteOf(A) === "a.blogspot.com", "호스트가 속성");
  assert(!a.accumulating && a.previous.clicks === 140 && a.current.clicks === 14, `주 합계 (${a.previous.clicks}/${a.current.clicks})`);
  assert(a.alerts.length === 1 && a.alerts[0].includes("급락"), "클릭 급락 경보");
  assert(t.accumulating && t.alerts.length === 0, "3일치는 축적 중, 경보 없음");
  assert(e.accumulating && e.current.clicks === 0, "데이터 없는 속성도 항목은 있다");
  assert(buildSiteMessage(t, end).includes("축적 중") && !buildSiteMessage(t, end).includes("(전주"), "축적 중이면 추이 생략");
  assert(buildSiteMessage(a, end).includes("<b>⚠") === false && buildSiteMessage(a, end).includes("⚠️ <b>클릭 급락"), "경보는 굵게");
  assert(buildSiteMessage(e, end).includes("노출 기록이 없습니다"), "빈 속성 문구");
  // 목록에서 빠진(폐쇄한) 속성의 과거 행은 리포트에 나오지 않는다.
  const closed = buildWeeklyReport([...rows, mk("2026-10-19", "https://closed.blogspot.com/x.html", 5)], end, ["a.blogspot.com", "t.tistory.com"]);
  assert(!closed.some((w) => w.site === "closed.blogspot.com") && closed.length === 2, "목록 밖 호스트 제외");
  console.log("✅ 주간 리포트 - 추이·축적 중 분기·경보·속성 분리");
}

// --- 10. GA4 응답 매핑 - 날짜 형식·깨진 행 격리 -------------------------------------------------
{
  const rows = mapGa4Rows({
    rows: [
      { dimensionValues: [{ value: "20261008" }, { value: "Organic Search" }], metricValues: [{ value: "3" }, { value: "2" }, { value: "7" }] },
      { dimensionValues: [{ value: "bad" }, { value: "Direct" }], metricValues: [{ value: "1" }, { value: "1" }, { value: "1" }] },
      { dimensionValues: [{ value: "20261008" }], metricValues: [] },
    ],
  });
  assert(rows.length === 1, `정상 행만 남는다 (${rows.length})`);
  assert(rows[0].date === "2026-10-08" && rows[0].channelGroup === "Organic Search", "날짜 YYYY-MM-DD 변환");
  assert(rows[0].sessions === 3 && rows[0].totalUsers === 2 && rows[0].pageViews === 7, "지표 매핑");
  assert(mapGa4Rows({}).length === 0, "rows 없으면 빈 배열(데이터 없음)");
  console.log("✅ GA4 응답 매핑 - 날짜 변환·깨진 행 격리");
}

console.log("\n🎉 성과 수집 로직 테스트 통과");
