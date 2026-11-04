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
  /**
   * 뒤늦게 따라잡아도 되는 수집인가(기본 true). false면 그 시각을 놓쳐도 다시 깨우지 않는다.
   * 수집 산출물이 없는 워크플로(watchdog 같은 감시·보고)는 뒤늦게 깨워도 쓸모가 없고, 자기 시각이
   * 아닌 때 돌면 판정이 엉킨다.
   */
  catchUp?: boolean;
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
  12: [{ workflow: "kscene-topic.yml" }, { workflow: "watchdog.yml", catchUp: false }],
};

/** 키워드 수집 외 단독 cron. 문자열이 곧 키다. */
const SINGLE_CRONS: Record<string, ScheduledDispatch[]> = {
  // 09:30 KST - Search Console 일일 성과 + 발행 이미지 생존 점검(2026-11-03). 둘은 서로 독립이라
  // 같이 깨워도 된다. 이미지 점검에 새 cron 슬롯을 쓰지 않은 이유는 마지막 1칸이 예약이기 때문이다.
  "30 0 * * *": [{ workflow: "analytics-search.yml" }, { workflow: "kscene-image-health.yml" }],
  // **일요일** 10:00 KST - 색인 건강 점검 + 네이버 문체 학습(style-learn, 2026-10-29). 새 cron 슬롯을
  // 쓰지 않고 동승한다
  //
  // ⚠️ 표현식은 `* * 1`(월요일)인데 **실제 발화는 일요일이다** - 10/18·10/25·11/01 세 주 연속
  // 일요일 01:00 UTC에 깨어났고 월요일에는 깨어나지 않았다(2026-11-02 run 이력 실측). 주 1회라는
  // 성질은 그대로이고 두 워크플로 모두 상태를 저장하지 않아 요일은 중요하지 않으므로 표현식은
  // 건드리지 않는다. 다만 **"월요일에 돌았겠지"로 run을 찾으면 못 찾는다** - 일요일 자리를 본다.
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

/**
 * 이 발화보다 **앞선 시각**에 돌았어야 하는 수집들(따라잡기 대상). 호출자가 "오늘 run이 있는가"를
 * GitHub에 물어 없는 것만 다시 깨운다.
 *
 * 왜 필요한가(2026-11-04): GitHub 장애(09:49~11:30 UTC, impact major)에 10·11 UTC 회차가 통째로
 * 사라졌다. dispatch 재시도(약 20초)로는 그만큼 긴 장애를 못 넘고, 다음 기회는 24시간 뒤였다.
 * 그런데 **같은 cron이 한 시간 뒤에 또 깨어난다** - 그때 앞 시각을 돌아보면 공짜로 따라잡을 수 있다.
 * 새 cron 슬롯도 새 토큰도 필요하지 않다(마지막 1칸은 계속 예약).
 *
 * 경계: 키워드 cron의 시각은 9~12 UTC로 **같은 UTC 날짜 안**에 있고, 수집일 경계(KST 05:00 =
 * 전날 20:00 UTC)도 그 사이에 없다. 그래서 "오늘 run이 있는가"를 UTC 날짜로 물어도 수집일과 어긋나지
 * 않는다. 시각을 이 범위 밖으로 옮기면 이 전제를 다시 봐야 한다.
 *
 * 마지막 시각(12 UTC)을 놓친 경우는 따라잡지 못한다 - 뒤에 깨어날 발화가 없다. 그건 watchdog 알림을
 * 보고 사람이 돌린다.
 */
export function catchUpTargets(cron: string, scheduledTime: number): ScheduledDispatch[] {
  if (cron !== KEYWORD_CRON) return [];
  const hour = new Date(scheduledTime).getUTCHours();
  return Object.entries(KEYWORD_BY_UTC_HOUR)
    .filter(([h]) => Number(h) < hour)
    .sort(([a], [b]) => Number(a) - Number(b))
    .flatMap(([, targets]) => targets)
    .filter((target) => target.catchUp !== false);
}
