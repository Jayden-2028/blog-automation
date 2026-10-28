// cron 발화 시각(UTC) -> 깨울 워크플로 목록. 순수 함수라 Worker 밖(tsx 테스트)에서도 검증한다.
//
// 2026-10-05 개편(RESTRUCTURE-PLAN-2026-10.md §2.1): Workers 무료 플랜은 cron 트리거 5개 한도이고 이미
// 다 찼다. 그래서 키워드 수집 시각을 cron 표현식 하나(`0 9,10,11,12 * * *`)에 묶고, Worker가 **발화한
// UTC 시(hour)**로 워크플로를 고른다. 이전의 "cron 문자열 -> 워크플로" map은 문자열이 하나뿐이라 쓸 수 없다.
// wrangler.toml의 crons와 **반드시 같이 바꿀 것** - 여기 없는 시각에 발화하면 아무 일도 안 일어난다.
//
// 2026-10-11 키워드 개편(KEYWORD-REFRESH-2026-10.md §A·§B): 엔터 키워드가 하루 3회(09/13/18시)에서
// **18시 1회**로 줄었다(09·13시 알림 중복이 많았다 - 사용자 판단). 비운 0·4 UTC 대신 10 UTC(19:00 KST)에
// 핫이슈 스타 알림을 새로 넣었다. 표현식의 시각 수는 5 -> 4로 줄었고 cron 슬롯 수(4/5)는 그대로다.

export type ScheduledDispatch = {
  workflow: string;
  /** workflow_dispatch inputs. 워크플로 yml에 선언된 입력만 넣을 것(미선언 입력은 GitHub가 422로 거부한다). */
  inputs?: Record<string, string>;
};

/** 키워드 수집 통합 cron 표현식. wrangler.toml과 동일해야 한다. */
export const KEYWORD_CRON = "0 9,10,11,12 * * *";

/** 발화 UTC 시 -> 워크플로 목록. KST = UTC+9. */
const KEYWORD_BY_UTC_HOUR: Record<number, ScheduledDispatch[]> = {
  // 18:00 KST 엔터 키워드 - 2026-10-11부터 이 회차 하나만 돈다(09·13시 폐지). round 입력은 계속 싣는다:
  // 수동 dispatch와 시각 추정 안전망이 같은 값을 쓰고, watchdog이 metadata.round로 이 회차를 찾는다.
  9: [{ workflow: "entertainment-keyword.yml", inputs: { round: "evening" } }],
  // 19:00 KST 핫이슈 스타 Top 5(§B 신설). 18시 회차 수집(09 UTC, ~10분)이 끝난 뒤라 그날 데이터가 가장
  // 신선하다. **알림 전용**이라 Go/제작 버튼이 없고 discovery_runs에는 kind=entertainment-hot-star로 남는다.
  10: [{ workflow: "entertainment-hot-star.yml" }],
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
  // 월요일 10:00 KST - 색인 건강 점검 + 네이버 문체 학습(style-learn, 2026-10-29). 새 cron 슬롯을 쓰지 않고 동승한다
  // (wrangler.toml 변경 없음). 두 워크플로는 서로 독립이라 동시에 깨워도 된다.
  "0 1 * * 1": [{ workflow: "analytics-index-health.yml" }, { workflow: "style-learn.yml" }],
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
