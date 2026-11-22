// scenepick 트랙(2026-11-21 사용자 결정)의 공통 타입·상수. 네이버 블로그 "scenepick"(몽상가N의 쓸데없는 궁금증들,
// https://blog.naver.com/scenepick-)의 원고를 **맥미니 Codex가 조사·집필·이미지까지 직접** 만든다 - 우리 researcher/writer
// (job-research/job-write)는 이 트랙에 쓰지 않는다. 우리 코드는 형식만 검사하고 뷰어(scenepick.html)에 올린다.
//
// 상태는 job.metadata.scenepickCodex 한 키에 둔다(전용 컬럼·migration 없이 - 승인 게이트를 피하고 기존 대기열들과 같은 방식).
//   requested -> running -> done | failed

/** 블로그 카테고리(2026-11-21 사용자 지정). Codex가 이 중 하나를 고르고, 뷰어에 그대로 보인다. */
export const SCENEPICK_CATEGORIES = [
  "알아두면 쓸모있을",
  "일상 속 과학",
  "세상의 별별 이야기",
  "잡다구리 노트",
  "AI시대 살아남기",
] as const;
export type ScenepickCategory = (typeof SCENEPICK_CATEGORIES)[number];

export function isScenepickCategory(value: unknown): value is ScenepickCategory {
  return typeof value === "string" && (SCENEPICK_CATEGORIES as readonly string[]).includes(value);
}

export const SCENEPICK_TRACK = "scenepick" as const;
export const SCENEPICK_SOURCE = "scenepick_input" as const;

/**
 * 접수 출처(metadata.scenepickOrigin, 2026-11-22). 없으면 사회 봇 접수(옛 job 포함)다. 변환기(인스타 포스팅 변환기 봇)에서 💡 상식을
 * 고른 job은 "converter"이고 **scenepickMessageId를 남기지 않는다** - 그 키는 사회 봇 채팅 메시지 번호로 접수 중복을 막는 데 쓰이는데
 * (findScenepickJobByMessageId), 채팅이 다르면 번호가 겹칠 수 있어 변환기 번호를 넣으면 사회 봇의 새 주제가 "중복"으로 버려진다.
 * 변환기 job은 converterQueueId(수신함 행 id = 큐 id)·converterMessageId를 따로 남긴다. 완료·실패 알림은 출처와 무관하게
 * job 트랙의 봇(사회 봇)으로 가고 reply_to를 걸지 않는다(scenepickPollJob.notify).
 */
export const SCENEPICK_ORIGIN_CONVERTER = "converter" as const;

/**
 * article_jobs.category에 넣는 값. 테이블에 category 제약은 없지만(20260827014817 migration - status만 check) **기존 값**을 쓴다:
 * 종합 키워드 입력 툴의 일상(living) 트랙이 쓰는 값이다. 블로그 카테고리(위 다섯)는 Codex가 원고를 보고 고르므로 job을 만들 때는
 * 모른다 - 그 값은 manifest topic.category(뷰어 표시)와 scenepickCodex.category에 남는다.
 */
export const SCENEPICK_JOB_CATEGORY = "living";

export type ScenepickCodexStatus = "requested" | "running" | "done" | "failed";

export type ScenepickCodexState = {
  status: ScenepickCodexStatus;
  requestedAt: string;
  /** Codex를 부른 횟수(첫 발주 + 재작업 주문). 2회가 상한이다(MAX_CODEX_RUNS). */
  attempts: number;
  /** 폴러가 집은 횟수. 60분 넘게 소식이 없는 running을 다시 집을 때 늘어난다(MAX_CLAIMS). */
  claims?: number;
  claimId?: string;
  startedAt?: string;
  /** Codex를 부를 때마다 갱신한다 - 2회 x 40분이 잔재 판정(60분)을 넘지 않게 하는 심장 박동이다. */
  heartbeatAt?: string;
  finishedAt?: string;
  error?: string;
  /** 형식 검사에서 걸린 항목(마지막 회차). 재작업 주문에 그대로 실린다. */
  failures?: string[];
  durationSec?: number;
  /** codex exec가 출력한 "tokens used" 합계(회차 합). 못 읽으면 없다. */
  tokensUsed?: number;
  title?: string;
  category?: string;
  imageCount?: number;
};

export function readScenepickState(metadata: unknown): ScenepickCodexState | null {
  if (!metadata || typeof metadata !== "object") return null;
  const raw = (metadata as Record<string, unknown>).scenepickCodex;
  if (!raw || typeof raw !== "object") return null;
  const state = raw as Partial<ScenepickCodexState>;
  if (typeof state.requestedAt !== "string" || typeof state.status !== "string") return null;
  return { ...state, attempts: Number(state.attempts ?? 0) || 0 } as ScenepickCodexState;
}

export function isScenepickJob(job: { metadata?: unknown } | null | undefined): boolean {
  const metadata = job?.metadata;
  return Boolean(metadata && typeof metadata === "object" && (metadata as Record<string, unknown>).track === SCENEPICK_TRACK);
}

/** KST 기준 YYYY-MM-DD. 뷰어 날짜 그룹과 주문서의 "오늘 날짜"가 같은 기준을 쓴다. */
export function kstDateString(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(at);
}
