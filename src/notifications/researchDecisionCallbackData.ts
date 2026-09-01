// 자료조사 미리보기 알림의 인라인 버튼 callback_data 규약(SPRINT_2_DESIGN.md 13-3절 ①).
//
// articleReviewCallbackData.ts(review:<action>:<jobId>)와 같은 원칙을 쓴다: article_jobs.id가
// UUID라 이미 짧고(36자) job을 직접 가리키는 유일한 키이므로 간접 참조가 필요 없다.
//
// 왜 필요해졌는가(2026-08-28, 사용자 피드백): 조사 미리보기 메시지가 "npm run job:write --
// <jobId>"를 텍스트로만 안내해, 폰에서 진행/중단하려면 터미널로 명령어를 옮겨 쳐야 했다 -
// review 콜백은 이미 버튼으로 되는데 조사 체크포인트만 빠져 있었다.
//
// 형식: research:<action>:<job_id>
//
// "retry"(2026-09-01 추가): write 실패 후 job이 "writing"에 멈춰 재시도할 방법이 없던 문제
// (runArticleJob.ts §runWritingStageInner 주석 참고 - writer 실패 시 status는 의도적으로
// writing 유지) 대응. TelegramBot이 오래(WRITE_TIMEOUT_MS+버퍼) writing에 머문 job에만
// 이 버튼을 붙여준다.

export type ResearchDecisionAction = "write" | "reject" | "retry";

const RESEARCH_PREFIX = "research";
const VALID_ACTIONS: readonly ResearchDecisionAction[] = ["write", "reject", "retry"];

// article_jobs.id는 gen_random_uuid()로 생성되는 표준 UUID다.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ResearchDecisionCallback = {
  action: ResearchDecisionAction;
  jobId: string;
};

export function buildResearchDecisionCallbackData(action: ResearchDecisionAction, jobId: string): string {
  if (!UUID_PATTERN.test(jobId)) {
    throw new Error(`jobId가 UUID 형식이 아닙니다: ${jobId}`);
  }
  return `${RESEARCH_PREFIX}:${action}:${jobId}`;
}

/**
 * "research:<action>:<jobId>"를 파싱한다. 형식이 안 맞으면 null(예외 아님) - 수신 측은 어떤
 * 문자열이 올지 통제할 수 없어 파싱 실패를 정상 흐름으로 다룬다.
 */
export function parseResearchDecisionCallbackData(data: string | undefined | null): ResearchDecisionCallback | null {
  if (!data) return null;

  const parts = data.split(":");
  if (parts.length !== 3) return null;
  if (parts[0] !== RESEARCH_PREFIX) return null;

  const action = parts[1];
  if (!VALID_ACTIONS.includes(action as ResearchDecisionAction)) return null;

  const jobId = parts[2];
  if (!UUID_PATTERN.test(jobId)) return null;

  return { action: action as ResearchDecisionAction, jobId };
}
