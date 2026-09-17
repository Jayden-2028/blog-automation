// 표 데이터 추출 + HTML 조립 테스트. 브라우저는 띄우지 않는다(렌더 자체는 실측으로 확인했다).

import { extractTableData } from "./extractTableData.js";
import { buildTableHtml } from "./renderTableImage.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

function main(): void {
  console.log("▶ 표 이미지 테스트 시작\n");

  // 1) 글머리 목록 + 콜론 -> label/value. 실제 원고 모양(청년미래적금 신청 일정).
  const schedule = extractTableData(
    ["신청 첫 이틀은 출생연도 끝자리별로 배정됩니다.\n- 10월 7일: 끝자리 홀수\n- 10월 8일: 끝자리 짝수\n- 10월 12일~16일: 누구나"],
    "폴백 제목"
  );
  assert(schedule?.rows.length === 3, `3행이어야 한다 (${JSON.stringify(schedule)})`);
  assert(schedule.rows[0].label === "10월 7일" && schedule.rows[0].value === "끝자리 홀수", "콜론 앞뒤로 갈라야 한다");
  assert(schedule.rows[2].label === "10월 12일~16일", "값 안의 물결·범위 표기가 깨지면 안 된다");
  assert(schedule.title === "폴백 제목", "소제목이 없으면 폴백 제목을 쓴다");

  // 2) 소제목이 있으면 그것이 이미지 제목이 된다.
  const titled = extractTableData(["**화제성과 시청률**\n- 1회 2.6%\n- 2회 2.8%"], "폴백");
  assert(titled?.title === "화제성과 시청률", `소제목을 제목으로 써야 한다 (${titled?.title})`);
  assert(titled.rows.every((r) => r.value === ""), "콜론이 없으면 전체가 label이다");

  // 3) 마크다운 표도 읽는다(구분선은 건너뛴다).
  const table = extractTableData(["| 차수 | 금액 | 신청처 |\n|---|---|---|\n| 1차 | 25만 원 | 정부24 |\n| 2차 | 15만 원 | 주민센터 |"], "표");
  assert(table?.rows.length === 3, `헤더 포함 3행이어야 한다 (${JSON.stringify(table?.rows)})`);
  assert(table.rows[1].label === "1차" && table.rows[1].value === "25만 원 · 정부24", "열이 3개면 첫 열이 키, 나머지를 합친다");

  // 4) 표도 목록도 없으면 null - 억지로 그리지 않는다(빈 자리로 남기고 사유를 알린다).
  assert(extractTableData(["그냥 평범한 문단입니다."], "제목") === null, "데이터가 없으면 null이어야 한다");
  assert(extractTableData(["- 한 줄뿐"], "제목") === null, "1행짜리는 표로 그릴 가치가 없다");

  // 5) 가까운 블록부터 본다 - 마커 바로 앞이 설명 문단이어도 그 앞 목록을 찾는다.
  const backtrack = extractTableData(["- A: 1\n- B: 2", "이 표는 다음과 같이 읽습니다."], "제목");
  assert(backtrack?.rows.length === 2, "한 칸 거슬러 올라가 목록을 찾아야 한다");
  console.log("✅ 데이터 추출 - 목록/표/소제목/폴백/없음/역추적");

  // 6) HTML: 값이 있으면 키 컬럼, 없으면 전폭 불릿. 한글이 그대로 들어가고 이스케이프된다.
  const html = buildTableHtml({
    title: "제목 <script>",
    rows: [
      { label: "10월 7일", value: "끝자리 홀수" },
      { label: "값 없는 항목", value: "" },
    ],
  });
  assert(html.includes("제목 &lt;script&gt;"), "제목이 이스케이프돼야 한다(HTML 주입 방지)");
  assert(html.includes('class="label"') && html.includes('class="value"'), "값 있는 행은 키/값 컬럼");
  assert(html.includes('class="single"'), "값 없는 행은 전폭 불릿");
  assert(html.includes("1536px") && html.includes("864px"), "16:9 규격이어야 한다");
  assert(html.includes("Noto Sans CJK KR"), "한글 폰트를 지정해야 한다(러너에 설치 필요)");
  console.log("✅ HTML 조립 - 이스케이프 + 키/값 vs 전폭 + 16:9 + 한글 폰트");

  console.log("\n✅ 표 이미지 테스트 전체 통과");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
