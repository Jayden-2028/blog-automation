// discovery_runs.metadata.kind 값 모음. 한 테이블에 성격이 다른 run이 섞여 있어, "이 run이 어떤
// 종류인가"를 문자열 리터럴로 여기저기 적어 두면 한 곳만 고쳐졌을 때 조용히 갈라진다.
//
// 지금 쓰는 kind(2026-10-11):
//   entertainment        엔터 키워드 수집(회차는 metadata.round) - Go/Pass 알림, keyword_rankings 있음
//   social_issue         사회 데일리 리포트 - Go/Pass 알림, keyword_rankings 있음
//   kscene_topic         사용설명서 주제 제안 - Go/Pass 알림, keyword_rankings 있음
//   entertainment-hot-star  19시 핫이슈 스타 Top 5 - **알림 전용**, keyword_rankings 없음

/** 19시 핫이슈 스타 알림 run(KEYWORD-REFRESH-2026-10.md §B). 키워드 run과 섞이면 안 된다. */
export const HOT_STAR_RUN_KIND = "entertainment-hot-star";

/**
 * 키워드 선택(Go/Pass) 알림의 재료가 될 수 없는 run 종류.
 *
 * 왜 필요한가: `fetchTopKeywordsForNotification`은 runId를 생략하면 "가장 최근 완료된 run"을 집는다
 * (`npm run notify:keywords` 수동 재발송 경로가 그렇다 - 2026-10-08에 실제로 쓰였다). 핫이슈 스타 run은
 * keyword_rankings가 없으므로 그게 최신 run이 되면 재발송이 조용히 `no_data`로 끝난다. kind로 걸러 낸다.
 */
export const NOTIFY_ONLY_RUN_KINDS: readonly string[] = [HOT_STAR_RUN_KIND];

/** 이 run이 키워드 선택 알림의 재료가 될 수 있는가. kind가 없는 옛 run은 true(하위 호환). */
export function isKeywordSelectionRunKind(kind: unknown): boolean {
  return !(typeof kind === "string" && NOTIFY_ONLY_RUN_KINDS.includes(kind));
}
