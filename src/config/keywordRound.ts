// 엔터 트랙 키워드 수집 회차(2026-10-05 개편 - RESTRUCTURE-PLAN-2026-10.md §2).
// 하루 3회(KST 09:00 / 13:00 / 18:00) 같은 job을 돌리므로, 알림 제목과 discovery_runs.metadata에
// "몇 시 회차인지"를 남긴다.
//
// 회차는 두 경로로 정해진다. ① 명시: 워크플로 입력 `round` -> 환경변수 KEYWORD_ROUND(Worker가 cron
// 시각에서 계산해 넘긴다). ② 생략: 실행 시각(KST)으로 추정. 수동 dispatch나 GitHub 지연에도 job이
// 항상 하나의 회차를 갖게 하려는 안전망이다. 시각 추정 경계는 "회차 시각 직전"이 아니라 **다음 회차
// 시각 - 1시간**쯤으로 잡아, 몇 시간 늦게 도는 실행도 자기 회차로 분류한다.

export const KEYWORD_ROUNDS = ["morning", "noon", "evening"] as const;
export type KeywordRound = (typeof KEYWORD_ROUNDS)[number];

export type KeywordRoundInfo = {
  round: KeywordRound;
  /** 알림 제목에 붙는 짧은 표기. 예: "오전(09시) 회차". */
  label: string;
  /** 회차 기준 시각(KST 시). */
  hourKst: number;
};

const ROUND_INFO: Record<KeywordRound, KeywordRoundInfo> = {
  morning: { round: "morning", label: "오전(09시) 회차", hourKst: 9 },
  noon: { round: "noon", label: "오후(13시) 회차", hourKst: 13 },
  evening: { round: "evening", label: "저녁(18시) 회차", hourKst: 18 },
};

export function isKeywordRound(value: unknown): value is KeywordRound {
  return typeof value === "string" && (KEYWORD_ROUNDS as readonly string[]).includes(value);
}

export function getKeywordRoundInfo(round: KeywordRound): KeywordRoundInfo {
  return ROUND_INFO[round];
}

/**
 * KST 시각 -> 회차. 11시 미만은 오전, 16시 미만은 오후, 그 외는 저녁.
 * 자정을 넘겨 도는 지연 실행(예: 18시 회차가 새벽 1시에 뜸)도 저녁으로 떨어진다 - 오전 회차는
 * 05~10시대만 해당하게 하려고 0~4시는 저녁으로 본다.
 */
export function inferKeywordRound(now: Date): KeywordRound {
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Seoul", hour: "2-digit", hourCycle: "h23" }).format(now)
  );
  if (hour >= 5 && hour < 11) return "morning";
  if (hour >= 11 && hour < 16) return "noon";
  return "evening";
}

/** 환경변수(KEYWORD_ROUND)가 올바르면 그 값, 아니면 시각 추정. 잘못된 값은 조용히 무시하지 않고 경고한다. */
export function resolveKeywordRound(
  env: Record<string, string | undefined> = process.env,
  now: Date = new Date()
): KeywordRoundInfo {
  const raw = env.KEYWORD_ROUND?.trim();
  if (raw) {
    if (isKeywordRound(raw)) return ROUND_INFO[raw];
    console.warn(`⚠️ KEYWORD_ROUND="${raw}"는 알 수 없는 값입니다(${KEYWORD_ROUNDS.join("/")}). 실행 시각으로 추정합니다.`);
  }
  return ROUND_INFO[inferKeywordRound(now)];
}

/** 엔터 알림 제목. */
export function formatEntertainmentHeader(info: KeywordRoundInfo): string {
  return `🎬 <b>엔터 키워드 — ${info.label}</b>`;
}
