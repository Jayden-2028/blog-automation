// Serper 선지불 크레딧 잔여 추정(2026-10-06 재가동, SERPER-REVIVAL C·D-2). 순수 함수만 둔다 -
// cost.json 게이지(buildCostSummary)와 소진 경보(watchdogJob)가 같은 계산을 쓴다.
//
// 모델: 잔여 추정 = 구매량 - 구매일 이후 api_usage의 **성공** serper 쿼리 누적. 실패 행(operation이
// `.failed`)은 크레딧을 안 쓰므로 세지 않는다. 1호출=1크레딧은 **추정**이다(E: 1주 뒤 대조).

export type SerperCreditsConfig = {
  purchased: number;
  /** YYYY-MM-DD (Asia/Seoul 날짜). */
  purchasedAt: string;
};

export type SerperCreditsBlock = {
  purchased: number;
  purchasedAt: string;
  /** 구매일 +6개월(유효기간). */
  expiresAt: string;
  usedEst: number;
  remainingEst: number;
  /** 0~100. */
  remainingPct: number;
  /** 최근 7일 평균 소진 기준 남은 일수. 소진이 0이면 null. */
  runwayDays: number | null;
  /** 구매일로부터 지난 일수(경보 판정용). */
  daysSincePurchase: number;
};

/** 환경값 2개. 하나라도 없거나 잘못되면 null - 게이지도 경보도 꺼진다(조용히). */
export function readSerperCreditsConfig(env: NodeJS.ProcessEnv = process.env): SerperCreditsConfig | null {
  const purchased = Number.parseInt(env.SERPER_CREDITS_PURCHASED?.trim() ?? "", 10);
  const purchasedAt = env.SERPER_CREDITS_PURCHASED_AT?.trim() ?? "";
  if (!Number.isFinite(purchased) || purchased <= 0) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(purchasedAt) || Number.isNaN(Date.parse(`${purchasedAt}T00:00:00+09:00`))) return null;
  return { purchased, purchasedAt };
}

/** 구매일 00:00 KST. 이 시각 이후 행만 구매분에서 차감된 것으로 본다. */
export function purchaseStart(config: SerperCreditsConfig): Date {
  return new Date(`${config.purchasedAt}T00:00:00+09:00`);
}

/** YYYY-MM-DD에 월을 더한다(말일 보정 포함). 유효기간 6개월 계산용. */
export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

export type SerperUsageRow = { provider: string; operation: string; quantity: number | null; occurred_at: string };

/** 크레딧을 실제로 쓴 serper 행인가. */
export function isBilledSerperRow(row: Pick<SerperUsageRow, "provider" | "operation">): boolean {
  return row.provider === "serper" && !row.operation.endsWith(".failed");
}

export type ComputeSerperCreditsInput = {
  config: SerperCreditsConfig;
  /** 구매일 이후 성공 쿼리 누적. 행이 많아 DB의 count로 따로 받는다. */
  usedEst: number;
  /** 최근 7일(적어도) 행. 평균 소진 계산용. */
  recentRows: readonly SerperUsageRow[];
  now?: Date;
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function computeSerperCredits(input: ComputeSerperCreditsInput): SerperCreditsBlock {
  const now = input.now ?? new Date();
  const { config } = input;
  const start = purchaseStart(config);

  const used = Math.max(0, input.usedEst);
  const remaining = Math.max(0, config.purchased - used);

  const daysSincePurchase = Math.max(0, Math.floor((now.getTime() - start.getTime()) / DAY_MS));

  // 최근 7일 평균. 구매 후 7일이 안 됐으면 지난 날수로 나눈다(적어도 1일) - 7로 나누면 초반 소진이 과소평가된다.
  const windowStart = new Date(Math.max(now.getTime() - 7 * DAY_MS, start.getTime()));
  const recentUsed = input.recentRows
    .filter((row) => isBilledSerperRow(row) && new Date(row.occurred_at) >= windowStart)
    .reduce((sum, row) => sum + (row.quantity ?? 1), 0);
  const windowDays = Math.max(1, Math.min(7, (now.getTime() - start.getTime()) / DAY_MS));
  const avgDaily = recentUsed / windowDays;

  return {
    purchased: config.purchased,
    purchasedAt: config.purchasedAt,
    expiresAt: addMonths(config.purchasedAt, 6),
    usedEst: used,
    remainingEst: remaining,
    remainingPct: Math.round((remaining / config.purchased) * 1000) / 10,
    runwayDays: avgDaily > 0 ? Math.floor(remaining / avgDaily) : null,
    daysSincePurchase,
  };
}

export const SERPER_LOW_CREDITS = 5000;
export const SERPER_LOW_RUNWAY_DAYS = 30;
export const SERPER_EXPIRY_CHECK_DAYS = 150;
export const SERPER_EXPIRY_REMAINING_PCT = 40;

export type SerperCreditAlert = { kind: "low_credits" | "low_runway" | "expiry_risk"; text: string };

/** 경보 조건 판정. 순수 함수 - 아무것도 안 보낸다. */
export function evaluateSerperCredits(block: SerperCreditsBlock): SerperCreditAlert[] {
  const alerts: SerperCreditAlert[] = [];
  const nf = (n: number) => n.toLocaleString("en-US");

  if (block.remainingEst < SERPER_LOW_CREDITS) {
    alerts.push({
      kind: "low_credits",
      text: `Serper 잔여 크레딧 추정 ${nf(block.remainingEst)}건 (기준 ${nf(SERPER_LOW_CREDITS)}건 미만)`,
    });
  }
  if (block.runwayDays != null && block.runwayDays < SERPER_LOW_RUNWAY_DAYS) {
    alerts.push({
      kind: "low_runway",
      text: `최근 7일 소진 속도라면 약 ${block.runwayDays}일 뒤 소진 (기준 ${SERPER_LOW_RUNWAY_DAYS}일 미만)`,
    });
  }
  if (block.daysSincePurchase >= SERPER_EXPIRY_CHECK_DAYS && block.remainingPct >= SERPER_EXPIRY_REMAINING_PCT) {
    alerts.push({
      kind: "expiry_risk",
      text: `구매 ${block.daysSincePurchase}일째인데 잔여 ${block.remainingPct}% - ${block.expiresAt} 만료 전에 다 쓰기 어렵습니다. 소진 속도 조절을 검토하세요`,
    });
  }
  return alerts;
}

export function formatSerperCreditAlert(block: SerperCreditsBlock, alerts: SerperCreditAlert[]): string {
  const nf = (n: number) => n.toLocaleString("en-US");
  return [
    "⚠️ Serper 크레딧 경고",
    "",
    ...alerts.map((alert) => `• ${alert.text}`),
    "",
    `구매 ${nf(block.purchased)} (${block.purchasedAt}) · 사용 추정 ${nf(block.usedEst)} · 잔여 추정 ${nf(block.remainingEst)} (${block.remainingPct}%)`,
    `만료 ${block.expiresAt}${block.runwayDays != null ? ` · 현재 속도 기준 ${block.runwayDays}일치` : ""}`,
    "",
    "충전: serper.dev 대시보드. 사용량 추정은 1호출=1크레딧 가정이라 Serper Usage와 대조가 필요합니다.",
  ].join("\n");
}
