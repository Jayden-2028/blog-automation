// buildCostSummary 회귀 테스트. 외부 호출 없음(순수 함수 + 고정 fixture).
//
// 특히 **날짜 경계**를 고정한다. UTC로 자르면 한국 시간 자정~오전 9시 사이의 지출이 전날로 밀려
// "오늘 얼마 썼나"가 매일 아침 틀리는데, 금액이 작아 눈으로는 알아채기 어렵다.
import { buildCostSummary, seoulDate } from "./buildCostSummary.js";
import type { FixedCostEntry } from "../../config/fixedCosts.js";
import type { ApiUsageRow } from "../../types/database.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

let seq = 0;
function row(overrides: Partial<ApiUsageRow> & { occurred_at: string }): ApiUsageRow {
  seq += 1;
  return {
    id: `row-${seq}`,
    provider: "openai",
    model: "gpt-image-2",
    operation: "image.generate",
    input_tokens: 30,
    output_tokens: 120,
    total_tokens: 150,
    quantity: 1,
    cost_usd: 0.0036,
    cost_source: "metered",
    job_id: null,
    metadata: {},
    created_at: overrides.occurred_at,
    ...overrides,
  };
}

const FIXED: FixedCostEntry[] = [
  { name: "Claude (Max 구독)", plan: "정액 구독", monthlyUsd: null, envVar: "FIXED_COST_CLAUDE_USD", note: "" },
  { name: "Telegram", plan: "무료", monthlyUsd: 0, envVar: "-", note: "" },
];

async function main(): Promise<void> {
  console.log("▶ buildCostSummary 테스트 시작\n");

  // 한국 시간 2026-09-16 13:00.
  const now = new Date("2026-09-16T04:00:00Z");

  const rows: ApiUsageRow[] = [
    // UTC로는 09-15지만 한국 시간으로는 09-16 00:30 - "오늘"에 들어가야 한다.
    row({ occurred_at: "2026-09-15T15:30:00Z", job_id: "job-a" }),
    row({ occurred_at: "2026-09-16T03:00:00Z", job_id: "job-a" }),
    // 이틀 전(한국 시간 09-14). 이번 달이지만 오늘은 아니다.
    row({ occurred_at: "2026-09-14T02:00:00Z", job_id: "job-b", cost_usd: 0.01 }),
    // 금액 미상 - 합계에 0으로 섞이면 안 되고 별도 카운트로만 잡혀야 한다.
    row({ occurred_at: "2026-09-16T03:30:00Z", job_id: "job-b", cost_usd: null, model: "미등록모델" }),
    // 지난달(한국 시간 08-31 19:00). 이번 달에도 최근 7일에도 들어오면 안 된다.
    row({ occurred_at: "2026-08-31T10:00:00Z", cost_usd: 99 }),
  ];

  const summary = buildCostSummary({ rows, fixedCosts: FIXED, now });

  // 1) 날짜 경계 - 한국 시간 기준.
  assert(seoulDate("2026-09-15T15:30:00Z") === "2026-09-16", "UTC 09-15 15:30 = 한국 09-16");
  assert(summary.today.date === "2026-09-16", `오늘은 2026-09-16 (실제: ${summary.today.date})`);
  assert(summary.today.calls === 3, `오늘 호출 3건 (실제: ${summary.today.calls})`);
  assert(summary.today.costUsd === 0.0072, `오늘 $0.0072 (실제: ${summary.today.costUsd})`);
  console.log("✅ 오늘 집계 - 한국 시간 자정 경계 포함");

  // 2) 이번 달에 지난달 행이 새어 들어오면 안 된다($99가 섞였는지로 확인).
  assert(summary.month.month === "2026-09", `이번 달 2026-09 (실제: ${summary.month.month})`);
  assert(summary.month.calls === 4, `이번 달 호출 4건 (실제: ${summary.month.calls})`);
  assert(summary.month.costUsd === 0.0172, `이번 달 $0.0172 (실제: ${summary.month.costUsd})`);
  console.log("✅ 이번 달 집계 - 지난달 유입 없음");

  // 3) 금액 미상은 0으로 더하지 않고 따로 센다.
  assert(summary.month.unknownCostCalls === 1, `금액 미상 1건 (실제: ${summary.month.unknownCostCalls})`);
  assert(
    summary.notes.some((note) => note.includes("하한")),
    "금액 미상이 있으면 '하한'이라는 주의가 붙어야 한다"
  );
  console.log("✅ 금액 미상 분리 + 주의 문구");

  // 4) 최근 7일은 지출 0인 날도 슬롯이 남아야 한다(빼면 '안 썼다'가 '기록 없음'처럼 보인다).
  assert(summary.daily.length === 7, `7일치 (실제: ${summary.daily.length})`);
  assert(summary.daily[6].date === "2026-09-16", "마지막 칸이 오늘");
  assert(summary.daily[0].date === "2026-09-10", `첫 칸이 09-10 (실제: ${summary.daily[0].date})`);
  const quietDay = summary.daily.find((day) => day.date === "2026-09-15");
  assert(quietDay && quietDay.calls === 0, "지출 없는 날도 칸이 남아야 한다");
  console.log("✅ 최근 7일 - 빈 날 슬롯 유지");

  // 5) 원고당 평균은 job_id가 붙은 금액만 본다.
  assert(summary.perManuscript.jobs === 2, `원고 2건 (실제: ${summary.perManuscript.jobs})`);
  assert(summary.perManuscript.avgCostUsd === 0.0086, `평균 $0.0086 (실제: ${summary.perManuscript.avgCostUsd})`);
  console.log("✅ 원고 1건당 평균");

  // 6) 모델별은 많이 쓴 순.
  assert(summary.byModel[0].model === "gpt-image-2", "가장 비싼 모델이 먼저");
  assert(summary.byModel.some((entry) => entry.model === "미등록모델"), "미등록 모델도 목록에는 남는다");
  console.log("✅ 모델별 정렬");

  // 7) 고정비 - 미입력은 합계에 넣지 않고 개수로만 드러낸다.
  assert(summary.fixed.knownMonthlyUsd === 0, "미입력 항목은 합계에서 빠진다");
  assert(summary.fixed.missingCount === 1, `미입력 1건 (실제: ${summary.fixed.missingCount})`);
  console.log("✅ 고정비 - 미입력 분리");

  // 8) 기록이 하나도 없어도 죽지 않는다(첫 배포 직후 상태).
  const empty = buildCostSummary({ rows: [], fixedCosts: FIXED, now });
  assert(empty.today.costUsd === 0 && empty.today.calls === 0, "빈 원장 - 0으로 시작");
  assert(empty.perManuscript.avgCostUsd === null, "원고가 없으면 평균은 null(0이 아니다)");
  assert(empty.daily.length === 7, "빈 원장에도 7일 슬롯은 있다");
  console.log("✅ 빈 원장");

  console.log("\n✅ 전체 통과");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
