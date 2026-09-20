// 성과 수집의 순수 로직 테스트. 외부 호출 없음. 실행: npm run test:search-performance
import { buildAssertion, mapAnalyticsRows } from "../../services/searchConsole/SearchConsoleClient.js";
import { aggregateRows, attachJobIds, normalizePageUrl, reportDate } from "./normalizeSearchRows.js";
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

console.log("\n🎉 성과 수집 로직 테스트 통과");
