// 자동 발행을 하지 않는 job(2026-10-14 사용자 결정, PERSON-PROFILE-IMPL §F).
//
// person(인물 백과) 트랙은 "핫스타 수집 -> 인물 선택 -> 자료조사 -> 집필 -> 검수 -> 뷰어 반영 + 통합 알림"까지다.
// 네이버 업로드는 사용자가 뷰어에서 복사해 직접 붙여넣는다. 통합 알림에 발행 버튼을 붙이지 않아도 오래된 메시지·
// 수동 CLI·뷰어 요청 경로가 남으므로, 발행 진입점들이 같은 판정을 쓴다(한 곳에서 정의).

/** 자동 발행하지 않는 카테고리. */
const MANUAL_PUBLISH_ONLY_CATEGORIES: ReadonlySet<string> = new Set(["person"]);

export const MANUAL_PUBLISH_ONLY_REASON =
  "인물 백과(person) 원고는 자동 발행하지 않습니다. 뷰어에서 복사해 네이버에 직접 붙여넣어 주세요.";

export function isManualPublishOnly(job: { category?: string | null }): boolean {
  return MANUAL_PUBLISH_ONLY_CATEGORIES.has(job.category ?? "");
}

/**
 * 🟢 네이버 발행 버튼 일시 해제(2026-10-16 사용자 요청 - 미스클릭 방지). 사회(🟠 티스토리)·
 * TKM(🔵 Blogger) 버튼은 유지한다. 복원 = 이 값을 false로 바꾸는 1커밋.
 * 알림 키보드(notifyManuscriptsReady)와 옛 메시지의 버튼 콜백(TelegramBot) 양쪽이 이 값을 본다.
 */
export const NAVER_PUBLISH_BUTTON_PAUSED = true;

export const NAVER_PUBLISH_PAUSED_REASON =
  "🟢 네이버 발행 버튼은 일시 해제 중입니다(미스클릭 방지, 2026-10-16). 발행은 뷰어에서 복사해 직접 올려주세요.";

/** 이 발행 액션이 일시 해제 상태인가. 지금은 naver만 해당한다. */
export function isPublishActionPaused(action: string): boolean {
  return NAVER_PUBLISH_BUTTON_PAUSED && action === "naver";
}
