// "원고 준비 완료" 알림의 **블로그 발행 버튼** callback_data 규약(2026-09-19 사용자 결정).
//
// 왜 사람이 누르는가: 자동 공개 발행을 품질 게이트로 자동 판정하려 했으나, 사용자가 더 단순하고
// 안전한 방식을 골랐다 - **이미지까지 반영된 최종 원고를 원고 페이지에서 눈으로 본 뒤** 버튼을
// 누른다. 사람이 곧 게이트다. 버튼을 누르지 않은 원고는 지금처럼 뷰어에서 복사해 수동 발행한다.
//
// 형식: `publish:<job_id>` — articleReviewCallbackData(review:<action>:<jobId>)와 같은 이유로
// 간접 참조가 필요 없다(article_jobs.id가 이미 36자 UUID라 64바이트 제한에 여유가 있다).
// action이 하나뿐이라 자리를 비워 두지 않고 2토막으로 둔다 - 파서끼리 배타적이기만 하면 된다.

const PUBLISH_PREFIX = "publish";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PublishDecisionCallback = { jobId: string };

export function buildPublishDecisionCallbackData(jobId: string): string {
  if (!UUID_PATTERN.test(jobId)) {
    throw new Error(`jobId가 UUID 형식이 아닙니다: ${jobId}`);
  }
  return `${PUBLISH_PREFIX}:${jobId}`;
}

/**
 * `publish:<jobId>`를 파싱한다. 형식이 안 맞으면 null(예외 아님) - 다른 콜백 규약과 같은 원칙으로,
 * 수신 측은 어떤 문자열이 올지 통제할 수 없어 파싱 실패를 정상 흐름으로 다룬다.
 */
export function parsePublishDecisionCallbackData(data: string | undefined | null): PublishDecisionCallback | null {
  if (!data) return null;
  const parts = data.split(":");
  if (parts.length !== 2) return null;
  if (parts[0] !== PUBLISH_PREFIX) return null;
  if (!UUID_PATTERN.test(parts[1])) return null;
  return { jobId: parts[1] };
}
