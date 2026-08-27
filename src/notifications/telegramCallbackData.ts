// Telegram 인라인 버튼의 callback_data 규약.
//
// 발송 측(sendKeywordNotification)과 수신 측(TelegramBot)이 반드시 같은 형식을 써야 하므로
// 양쪽이 이 모듈 하나만 참조하게 한다. 문자열을 각자 조립하면 한쪽만 바뀌었을 때 버튼이 조용히
// 동작하지 않는다.
//
// 형식: sel:<run_id>:<rank>   예) sel:18:3
//
// 키워드를 넣지 않는 이유가 두 가지다.
// 1. Telegram의 callback_data는 UTF-8 기준 64바이트 제한이다. 한글 키워드는 글자당 3바이트라
//    "양준모 재혼 상대 양지원, 임신 소식" 같은 실제 키워드 하나로도 초과한다.
// 2. 참조 키만 담으면 수신 측이 keyword_rankings에서 다시 읽어야 하는데, 이게 곧 검증이 된다 -
//    위조된 callback_data로 임의 키워드를 주입해도 (run_id, rank)로 조회되지 않으면 거부된다.

/** Telegram callback_data 최대 길이(UTF-8 바이트). Bot API 규격. */
export const CALLBACK_DATA_MAX_BYTES = 64;

const SELECT_PREFIX = "sel";

export type KeywordSelectionCallback = {
  runId: number;
  rank: number;
};

/** `sel:<run_id>:<rank>` 문자열을 만든다. 64바이트를 넘으면 던진다(설계상 넘을 수 없다). */
export function buildKeywordSelectionCallbackData(runId: number, rank: number): string {
  if (!Number.isInteger(runId) || runId < 0) {
    throw new Error(`runId는 0 이상의 정수여야 합니다 (받은 값: ${runId})`);
  }
  if (!Number.isInteger(rank) || rank < 1) {
    throw new Error(`rank는 1 이상의 정수여야 합니다 (받은 값: ${rank})`);
  }

  const data = `${SELECT_PREFIX}:${runId}:${rank}`;

  // 숫자만 담으므로 현실적으로 넘을 수 없지만, 형식을 바꿀 때 조용히 깨지지 않도록 확인한다.
  const bytes = Buffer.byteLength(data, "utf8");
  if (bytes > CALLBACK_DATA_MAX_BYTES) {
    throw new Error(`callback_data가 ${CALLBACK_DATA_MAX_BYTES}바이트를 초과합니다 (${bytes}바이트): ${data}`);
  }

  return data;
}

/**
 * callback_data를 파싱한다. 형식이 맞지 않으면 null을 반환한다(던지지 않는다).
 *
 * 수신 측은 어떤 문자열이 올지 통제할 수 없다 - 봇이 들어 있는 대화의 오래된 메시지, 다른 기능의
 * 버튼, 악의적으로 조작된 값이 모두 도착할 수 있다. 그래서 파싱 실패는 예외가 아니라 "무시할
 * update"라는 정상 흐름으로 다룬다.
 */
export function parseKeywordSelectionCallbackData(data: string | undefined | null): KeywordSelectionCallback | null {
  if (!data) return null;

  const parts = data.split(":");
  if (parts.length !== 3) return null;
  if (parts[0] !== SELECT_PREFIX) return null;

  // Number()는 "" 와 " 1 " 을 통과시키므로 정수 형태인지 먼저 정규식으로 확인한다.
  if (!/^\d+$/.test(parts[1]) || !/^\d+$/.test(parts[2])) return null;

  const runId = Number(parts[1]);
  const rank = Number(parts[2]);
  if (!Number.isSafeInteger(runId) || !Number.isSafeInteger(rank)) return null;
  if (rank < 1) return null;

  return { runId, rank };
}
