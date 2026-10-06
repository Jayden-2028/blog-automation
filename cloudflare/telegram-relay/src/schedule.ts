// cron 발화 시각(UTC) -> 깨울 워크플로 목록. 순수 함수라 Worker 밖(tsx 테스트)에서도 검증한다.
//
// 2026-10-05 개편(RESTRUCTURE-PLAN-2026-10.md §2.1): Workers 무료 플랜은 cron 트리거 5개 한도이고 이미
// 다 찼다. 그래서 키워드 수집 시각을 cron 표현식 하나(`0 0,4,9,11,12 * * *`)에 묶고, Worker가 **발화한
// UTC 시(hour)**로 워크플로를 고른다. 이전의 "cron 문자열 -> 워크플로" map은 문자열이 하나뿐이라 쓸 수 없다.
// wrangler.toml의 crons와 **반드시 같이 바꿀 것** - 여기 없는 시각에 발화하면 아무 일도 안 일어난다.

export type ScheduledDispatch = {
  workflow: string;
  /** workflow_dispatch inputs. 워크플로 yml에 선언된 입력만 넣을 것(미선언 입력은 GitHub가 422로 거부한다). */
  inputs?: Record<string, string>;
};

/** 키워드 수집 통합 cron 표현식. wrangler.toml과 동일해야 한다. */
export const KEYWORD_CRON = "0 0,4,9,11,12 * * *";

/** 발화 UTC 시 -> 워크플로 목록. KST = UTC+9. */
const KEYWORD_BY_UTC_HOUR: Record<number, ScheduledDispatch[]> = {
  0: [{ workflow: "entertainment-keyword.yml", inputs: { round: "morning" } }], // 09:00 KST 엔터 오전
  4: [{ workflow: "entertainment-keyword.yml", inputs: { round: "noon" } }], // 13:00 KST 엔터 오후
  9: [{ workflow: "entertainment-keyword.yml", inputs: { round: "evening" } }], // 18:00 KST 엔터 저녁
  11: [{ workflow: "social-issue-keyword.yml" }], // 20:00 KST 사회(2순위에서 데일리 리포트로 개편)
  // 21:00 KST 사용설명서(kscene) 주제 수집 + watchdog(개편3). watchdog은 원래 GitHub 네이티브 cron
  // (`0 12 * * *`)이었는데 10/5에 발화하지 않았다(알려진 지연·누락) - Worker 슬롯으로 옮겼다. 두 워크플로는
  // 동시에 깨어나므로 watchdog은 **이 시각의 kscene run을 기다리지 않는다**(watchdogJob.ts WATCHED_JOBS의
  // dayOffset - 전날 kscene 수집을 확인한다).
  12: [{ workflow: "kscene-topic.yml" }, { workflow: "watchdog.yml" }],
};

/** 키워드 수집 외 단독 cron. 문자열이 곧 키다. */
const SINGLE_CRONS: Record<string, ScheduledDispatch[]> = {
  "30 0 * * *": [{ workflow: "analytics-search.yml" }], // 09:30 KST - Search Console 일일 성과
  "0 1 * * 1": [{ workflow: "analytics-index-health.yml" }], // 월요일 10:00 KST - 색인 건강 점검
  // 일요일 03:00 KST(토 18:00 UTC) - Storage 정리(개편2.5 D). 기본 dry-run이고 실삭제는 워크플로의 apply 게이트가 정한다.
  "0 18 * * 6": [{ workflow: "storage-cleanup.yml" }],
};

/** 알 수 없는 cron이면 null(호출자가 던진다). 알지만 할 일이 없으면 빈 배열. */
export function resolveScheduled(cron: string, scheduledTime: number): ScheduledDispatch[] | null {
  if (cron === KEYWORD_CRON) {
    const hour = new Date(scheduledTime).getUTCHours();
    return KEYWORD_BY_UTC_HOUR[hour] ?? null;
  }
  return SINGLE_CRONS[cron] ?? null;
}
