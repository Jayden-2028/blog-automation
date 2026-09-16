// 비용 원장(api_usage) -> 대시보드가 읽는 집계(cost.json). 순수 함수다 - DB도 파일도 건드리지 않아
// 테스트에서 그대로 검증할 수 있다(buildStatusReportHtml/buildJobsReportHtml과 같은 구조).
//
// 집계 축을 SQL이 아니라 여기서 내는 이유: "오늘/이번 달/원고당" 같은 축은 앞으로도 계속 바뀔
// 텐데, DB 함수로 만들면 바꿀 때마다 migration 승인 게이트를 다시 통과해야 한다.
//
// 날짜 경계는 전부 **Asia/Seoul**이다. UTC로 자르면 한국 시간 오전 9시 이전 지출이 전날로 밀려
// "오늘 얼마 썼나"가 매일 아침 틀린다.

import type { FixedCostEntry } from "../../config/fixedCosts.js";
import { listPricedModels } from "../../config/apiPricing.js";
import type { ApiUsageRow } from "../../types/database.js";

const TIME_ZONE = "Asia/Seoul";

/** ISO 시각 -> Asia/Seoul 기준 YYYY-MM-DD. en-CA 로케일이 정확히 이 형식을 준다(기존 코드와 동일). */
export function seoulDate(iso: string | Date): string {
  const date = typeof iso === "string" ? new Date(iso) : iso;
  return date.toLocaleDateString("en-CA", { timeZone: TIME_ZONE });
}

export type CostBucket = {
  /** 계측된 금액 합계(USD). 단가 미등록 행은 빠져 있다. */
  costUsd: number;
  calls: number;
  /** 금액을 모르는 호출 수. 0이 아니면 costUsd는 **하한**이다. */
  unknownCostCalls: number;
};

export type CostSummary = {
  generatedAt: string;
  timezone: string;
  today: CostBucket & { date: string };
  month: CostBucket & { month: string };
  /** 오늘 포함 최근 7일. 오래된 날짜부터. */
  daily: Array<{ date: string } & CostBucket>;
  /** 이번 달 기준, 많이 쓴 순. */
  byModel: Array<{ provider: string; model: string; operation: string } & CostBucket>;
  /** 이번 달 원고 1건당 평균. job_id가 붙은 행만 본다. */
  perManuscript: { jobs: number; costUsd: number; avgCostUsd: number | null };
  fixed: { entries: FixedCostEntry[]; knownMonthlyUsd: number; missingCount: number };
  /** 대시보드에 그대로 띄울 한계·주의사항. 숫자만 보고 오해하지 않도록 함께 내려보낸다. */
  notes: string[];
  pricedModels: ReturnType<typeof listPricedModels>;
};

function emptyBucket(): CostBucket {
  return { costUsd: 0, calls: 0, unknownCostCalls: 0 };
}

function addRow(bucket: CostBucket, row: ApiUsageRow): void {
  bucket.calls += 1;
  if (row.cost_usd == null) bucket.unknownCostCalls += 1;
  else bucket.costUsd += Number(row.cost_usd);
}

/** 부동소수 누적 오차를 표시 자리수에서 걷어낸다(이미지 1장 $0.0036이라 6자리까지 의미가 있다). */
function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function finalize<T extends CostBucket>(bucket: T): T {
  bucket.costUsd = round6(bucket.costUsd);
  return bucket;
}

export type BuildCostSummaryInput = {
  /** 최소 최근 7일 + 이번 달을 덮는 구간. 정렬 순서는 상관없다. */
  rows: ApiUsageRow[];
  fixedCosts: FixedCostEntry[];
  now?: Date;
};

export function buildCostSummary(input: BuildCostSummaryInput): CostSummary {
  const now = input.now ?? new Date();
  const todayDate = seoulDate(now);
  const monthKey = todayDate.slice(0, 7);

  const today = { date: todayDate, ...emptyBucket() };
  const month = { month: monthKey, ...emptyBucket() };

  // 최근 7일 슬롯을 **미리 만들어 둔다** - 지출이 없는 날을 빼 버리면 그래프에서 그날이 사라져
  // "안 썼다"가 "기록이 없다"처럼 보인다.
  const dailyKeys: string[] = [];
  for (let i = 6; i >= 0; i--) {
    dailyKeys.push(seoulDate(new Date(now.getTime() - i * 24 * 60 * 60 * 1000)));
  }
  const dailyMap = new Map<string, CostBucket>(dailyKeys.map((key) => [key, emptyBucket()]));

  const modelMap = new Map<string, { provider: string; model: string; operation: string } & CostBucket>();
  const jobCost = new Map<string, number>();

  for (const row of input.rows) {
    const date = seoulDate(row.occurred_at);

    if (date === todayDate) addRow(today, row);

    const daily = dailyMap.get(date);
    if (daily) addRow(daily, row);

    if (!date.startsWith(monthKey)) continue;

    addRow(month, row);

    const key = `${row.provider}|${row.model}|${row.operation}`;
    let entry = modelMap.get(key);
    if (!entry) {
      entry = { provider: row.provider, model: row.model, operation: row.operation, ...emptyBucket() };
      modelMap.set(key, entry);
    }
    addRow(entry, row);

    if (row.job_id && row.cost_usd != null) {
      jobCost.set(row.job_id, (jobCost.get(row.job_id) ?? 0) + Number(row.cost_usd));
    }
  }

  const perManuscriptTotal = [...jobCost.values()].reduce((sum, value) => sum + value, 0);
  const jobs = jobCost.size;

  const knownFixed = input.fixedCosts.filter((entry) => entry.monthlyUsd != null);
  const notes = [
    "금액은 호출 시점에 우리가 직접 계측한 값이다(공급자 청구액 API가 아니다). 공급자 최종 청구서와 소수점 단위 차이가 날 수 있다.",
    "Claude는 정액 구독이라 호출당 금액이 존재하지 않는다 - 아래 고정비에만 잡힌다.",
  ];
  if (month.unknownCostCalls > 0) {
    notes.push(
      `이번 달 ${month.unknownCostCalls}건은 단가 미등록이거나 공급자가 usage를 주지 않아 금액을 모른다 - 표시 금액은 하한이다.`
    );
  }
  if (input.fixedCosts.some((entry) => entry.monthlyUsd == null)) {
    notes.push("고정비 중 금액 미입력 항목이 있다(환경변수로 채우면 합계에 들어간다).");
  }

  return {
    generatedAt: now.toISOString(),
    timezone: TIME_ZONE,
    today: finalize(today),
    month: finalize(month),
    daily: dailyKeys.map((date) => ({ date, ...finalize(dailyMap.get(date) ?? emptyBucket()) })),
    byModel: [...modelMap.values()].map(finalize).sort((a, b) => b.costUsd - a.costUsd),
    perManuscript: {
      jobs,
      costUsd: round6(perManuscriptTotal),
      avgCostUsd: jobs > 0 ? round6(perManuscriptTotal / jobs) : null,
    },
    fixed: {
      entries: input.fixedCosts,
      knownMonthlyUsd: round6(knownFixed.reduce((sum, entry) => sum + (entry.monthlyUsd ?? 0), 0)),
      missingCount: input.fixedCosts.length - knownFixed.length,
    },
    notes,
    pricedModels: listPricedModels(),
  };
}
