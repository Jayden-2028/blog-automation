// 의학 주제 교차확인 알림의 인라인 버튼 callback_data 규약(SPRINT_2_DESIGN.md 5-2절).
//
// telegramCallbackData.ts(키워드 선택, sel/go/pass)와 다른 이유: 그쪽은 keyword_rankings가
// (run_id, rank)로만 조회되고 참조 키가 64바이트 제한에 걸려 간접 참조를 썼다. 여기서는
// article_jobs.id가 UUID라 이미 짧고(36자), job을 직접 가리키는 유일한 키이므로 간접 참조가
// 필요 없다 - "review:<action>:<jobId>"로 job.id를 그대로 담는다(예: "review:confirm:054bfe0b-...").
//
// 형식: review:<action>:<job_id>

export type ArticleReviewAction = "confirm" | "edit" | "discard";

const REVIEW_PREFIX = "review";
const VALID_ACTIONS: readonly ArticleReviewAction[] = ["confirm", "edit", "discard"];

// article_jobs.id는 gen_random_uuid()로 생성되는 표준 UUID다.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ArticleReviewCallback = {
  action: ArticleReviewAction;
  jobId: string;
};

export function buildArticleReviewCallbackData(action: ArticleReviewAction, jobId: string): string {
  if (!UUID_PATTERN.test(jobId)) {
    throw new Error(`jobId가 UUID 형식이 아닙니다: ${jobId}`);
  }
  return `${REVIEW_PREFIX}:${action}:${jobId}`;
}

/**
 * "review:<action>:<jobId>"를 파싱한다. 형식이 안 맞으면 null(예외 아님) - telegramCallbackData.ts와
 * 같은 원칙으로, 수신 측은 어떤 문자열이 올지 통제할 수 없어 파싱 실패를 정상 흐름으로 다룬다.
 */
export function parseArticleReviewCallbackData(data: string | undefined | null): ArticleReviewCallback | null {
  if (!data) return null;

  const parts = data.split(":");
  if (parts.length !== 3) return null;
  if (parts[0] !== REVIEW_PREFIX) return null;

  const action = parts[1];
  if (!VALID_ACTIONS.includes(action as ArticleReviewAction)) return null;

  const jobId = parts[2];
  if (!UUID_PATTERN.test(jobId)) return null;

  return { action: action as ArticleReviewAction, jobId };
}
