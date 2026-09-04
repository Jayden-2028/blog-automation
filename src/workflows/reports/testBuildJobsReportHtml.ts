// buildJobsReportHtml 테스트. DB 없이 순수 변환만 검증한다.

import { buildJobsReportHtml, displayTitle, formatSeoulDateTime } from "./buildJobsReportHtml.js";
import type { JobsReportRow } from "./buildJobsReportHtml.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const ROWS: JobsReportRow[] = [
  {
    jobId: "87d25d04-1111-2222-3333-444455556666",
    articleTitle: "두리랜드에 250억 쓴 임채무 빚과 운영 이유",
    headline: "임채무 두리랜드 근황",
    keyword: "임채무 두리랜드",
    category: "entertainment",
    status: "approved",
    selectedAt: "2026-09-03T12:20:50.000Z",
  },
  {
    jobId: "1b7e635e-aaaa-bbbb-cccc-ddddeeeeffff",
    articleTitle: null,
    headline: "가을장마 언제까지",
    keyword: "가을장마",
    category: "living",
    status: "writing",
    selectedAt: "2026-09-03T01:00:00.000Z",
  },
  {
    jobId: "deadbeef-0000-1111-2222-333344445555",
    articleTitle: null,
    headline: null,
    keyword: "<script>alert(1)</script>",
    category: null,
    status: "rejected",
    selectedAt: "2026-09-02T23:00:00.000Z",
  },
];

function main(): void {
  console.log("▶ buildJobsReportHtml 테스트 시작\n");

  // 표시용 제목 우선순위: 원고 제목 > headline > keyword
  assert(displayTitle(ROWS[0]) === "두리랜드에 250억 쓴 임채무 빚과 운영 이유", "원고 제목이 있으면 그것을 쓴다");
  assert(displayTitle(ROWS[1]) === "가을장마 언제까지", "원고가 없으면 headline으로 대체");
  assert(displayTitle(ROWS[2]) === "<script>alert(1)</script>", "headline도 없으면 keyword로 대체");
  console.log("✅ 제목 대체 순서(원고 제목 > headline > keyword)");

  // KST 변환: 2026-09-03T12:20:50Z = 2026-09-03 21:20 KST
  assert(formatSeoulDateTime("2026-09-03T12:20:50.000Z") === "2026-09-03 21:20", `KST 변환 (실제: ${formatSeoulDateTime("2026-09-03T12:20:50.000Z")})`);
  assert(formatSeoulDateTime("깨진 날짜") === "깨진 날짜", "파싱 실패 시 원본 유지");
  console.log("✅ 선택 시각 KST 변환");

  const html = buildJobsReportHtml(ROWS, new Date("2026-09-03T13:00:00.000Z"));

  assert(html.startsWith("<!doctype html>"), "완결된 HTML 문서여야 한다");
  for (const row of ROWS) {
    assert(html.includes(row.jobId), `jobId 전체가 data-id에 들어가야 한다: ${row.jobId}`);
    assert(html.includes(row.jobId.slice(0, 8)), "화면에는 앞 8자만 표시");
  }
  console.log("✅ 전체 jobId는 복사용으로, 표시는 축약형으로");

  // XSS: 키워드에 태그가 섞여도 실행 가능한 마크업이 되면 안 된다.
  assert(!html.includes("<script>alert(1)</script>"), "키워드의 태그가 그대로 들어가면 안 된다");
  assert(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), "이스케이프된 형태로 들어가야 한다");
  console.log("✅ 제목·키워드 HTML 이스케이프");

  // 검색용 문자열에 제목·키워드·jobId가 모두 들어간다.
  assert(html.includes('data-search="두리랜드에 250억 쓴 임채무 빚과 운영 이유 임채무 두리랜드'), "검색 문자열에 제목+키워드 포함");
  assert(/data-search="[^"]*87d25d04/.test(html), "검색 문자열에 jobId 포함");
  console.log("✅ 검색 대상(제목·키워드·jobId·상태) 결합");

  assert(html.includes("승인됨(발행 대기)") && html.includes("집필 중") && html.includes("반려"), "status 한글 라벨");
  assert(html.includes("npm run job:write -- &lt;jobId&gt;"), "jobId를 쓰는 명령 안내 포함");
  console.log("✅ 상태 라벨 + 명령 안내");

  // 빈 목록도 깨지지 않는다.
  const empty = buildJobsReportHtml([]);
  assert(empty.includes("아직 job이 없습니다"), "빈 목록 안내");
  assert(empty.startsWith("<!doctype html>"), "빈 목록도 완결된 문서");
  console.log("✅ job 0건일 때 안내 문구");

  console.log("\n✅ buildJobsReportHtml 테스트 완료");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
