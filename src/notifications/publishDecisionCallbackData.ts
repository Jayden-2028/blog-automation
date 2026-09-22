// "원고 준비 완료" 알림 버튼들의 callback_data 규약.
//
// 왜 사람이 누르는가(2026-09-19 사용자 결정): 자동 공개 발행을 품질 게이트로 자동 판정하려 했으나,
// 사용자가 더 단순하고 안전한 방식을 골랐다 - **이미지까지 반영된 최종 원고를 원고 페이지에서 눈으로
// 본 뒤** 버튼을 누른다. 사람이 곧 게이트다.
//
// 형식: `publish:<action>:<jobId>` (2026-09-22 확장)
//
//   blogspot — 구글 Blogspot 공개 발행. 공식 API라 GitHub Actions에서 바로 끝난다.
//   naver    — 네이버 블로그 공개 발행. 공식 API가 없어 로그인된 브라우저가 필요하고,
//              GitHub Actions에서는 돌릴 수 없다 - 맥의 로컬 폴러가 집어 간다.
//   images   — 이미지 재수집. 빈 자리는 자동으로, 마음에 안 드는 자리는 사용자가 번호와
//              요구사항을 답장해서 지정한다.
//
// **하위 호환**: 2026-09-22 이전에 보낸 알림에는 `publish:<jobId>`(2토막)가 박혀 있고, 텔레그램
// 메시지는 우리가 고칠 수 없다. 사용자가 옛 알림의 버튼을 눌러도 죽지 않도록 2토막은 `blogspot`으로
// 읽는다 - 그때는 그 버튼이 곧 Blogspot 발행이었다.

const PUBLISH_PREFIX = "publish";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const PUBLISH_ACTIONS = ["blogspot", "naver", "images"] as const;
export type PublishDecisionAction = (typeof PUBLISH_ACTIONS)[number];

export type PublishDecisionCallback = { action: PublishDecisionAction; jobId: string };

export function buildPublishDecisionCallbackData(jobId: string, action: PublishDecisionAction = "blogspot"): string {
  if (!UUID_PATTERN.test(jobId)) {
    throw new Error(`jobId가 UUID 형식이 아닙니다: ${jobId}`);
  }
  return `${PUBLISH_PREFIX}:${action}:${jobId}`;
}

/**
 * `publish:<action>:<jobId>`를 파싱한다. 옛 형식 `publish:<jobId>`는 blogspot으로 읽는다.
 *
 * 형식이 안 맞으면 null(예외 아님) - 다른 콜백 규약과 같은 원칙으로, 수신 측은 어떤 문자열이
 * 올지 통제할 수 없어 파싱 실패를 정상 흐름으로 다룬다.
 */
export function parsePublishDecisionCallbackData(data: string | undefined | null): PublishDecisionCallback | null {
  if (!data) return null;
  const parts = data.split(":");
  if (parts[0] !== PUBLISH_PREFIX) return null;

  // 옛 형식: publish:<jobId> - 그때는 버튼이 Blogspot 발행 하나뿐이었다.
  if (parts.length === 2) {
    return UUID_PATTERN.test(parts[1]) ? { action: "blogspot", jobId: parts[1] } : null;
  }

  if (parts.length !== 3) return null;
  const action = parts[1] as PublishDecisionAction;
  if (!PUBLISH_ACTIONS.includes(action)) return null;
  if (!UUID_PATTERN.test(parts[2])) return null;
  return { action, jobId: parts[2] };
}
