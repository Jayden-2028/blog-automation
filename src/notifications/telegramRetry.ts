// 텔레그램 전송이 흔들리면 다시 보낸다.
//
// 2026-11-13 실측 사고: 20시 사회 키워드 수집이 수집·점수·저장까지 다 끝내 놓고 마지막 `notify`
// 단계에서 **5.4초 만에 `fetch failed`**로 죽었다(run 43413609001). 그날 사회 트랙 Go/Pass 알림이
// 통째로 날아갔고, 사람이 `gh workflow run social-issue-keyword.yml`로 수집을 처음부터 다시
// 돌려야 했다(3분 23초). 바로 다음 run에서 같은 단계가 **17.9초**에 정상 발송됐다 - 알림 보내기는
// 원래 메시지를 여러 통 순차로 보내는 긴 작업이고, 그 중간에 네트워크가 한 번 깜빡인 것이다.
// 0.3초 뒤에 나간 실패 알림은 멀쩡히 도착했다(텔레그램이 죽은 게 아니다).
//
// **한 통 실패 = 그날 수집 전부**라는 구조가 문제였다. 2026-11-04에 수집 발화(`dispatchWorkflow`)에
// 같은 이유로 재시도를 넣었는데, 알림 쪽은 빠져 있었다.
//
// 판정·간격은 `services/github/dispatchWorkflow.ts`와 **같은 기준**이다(2·6·12초, 4xx는 즉시 포기).
// 거기 주석대로 Worker/Node가 이미 두 벌이라 세 벌째를 만들지 않으려고 그 상수를 그대로 쓴다.
//
// ⚠️ **중복 발송 가능성을 알고 받아들인다.** fetch가 거절됐다는 것은 보통 요청이 텔레그램에
// 닿지도 못했다는 뜻이지만, 서버가 처리한 뒤 응답만 못 받은 경우도 이론적으로 있다. 그러면 같은
// 메시지가 두 번 간다. sendMessage에는 멱등 키가 없어 코드로 막을 방법이 없고, **알림 한 통이
// 두 번 오는 것보다 그날 알림이 아예 안 오는 쪽이 훨씬 나쁘다**는 판단이다(위 사고가 그 증거다).
import { DISPATCH_RETRY_DELAYS_MS, isRetryableStatus } from "../services/github/dispatchWorkflow.js";

export const TELEGRAM_RETRY_DELAYS_MS = DISPATCH_RETRY_DELAYS_MS;

/** 다시 보낼 만한 실패인가. 4xx는 토큰·chat_id·본문 형식 문제라 다시 보내도 같은 답이 온다. */
export const isRetryableTelegramStatus = isRetryableStatus;

export type TelegramRetryDeps = {
  sleep?: (ms: number) => Promise<void>;
  delaysMs?: readonly number[];
  log?: (message: string) => void;
};

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 로그에 남길 문구에서 봇 토큰을 지운다.
 *
 * 텔레그램 API URL은 `https://api.telegram.org/bot<토큰>/sendMessage` 꼴이라 **주소 자체가
 * 자격증명**이다. 오류 메시지에 그 URL이 섞여 들어오면(fetch 구현·중간 프록시에 따라 다르다)
 * 그대로 찍는 순간 run 로그에 토큰이 남는다. 테스트가 이것을 단정한다.
 */
export function redactBotToken(text: string): string {
  return text.replace(/\/bot[^/\s]+/g, "/bot<토큰>");
}

/**
 * 텔레그램 API 호출 한 번을 감싸 흔들리면 다시 보낸다.
 *
 * `attempt`는 fetch 하나를 그대로 돌려준다. 이 함수는 **응답 본문을 읽지 않는다** - 상태 코드만
 * 보고 판단하므로 호출자가 평소처럼 body를 읽으면 된다.
 *
 * - fetch 자체가 거절되면(DNS·연결 끊김 - 이번 사고) 다시 보낸다.
 * - 408·429·5xx면 다시 보낸다. 그 밖의 4xx는 즉시 그 응답을 돌려준다(재시도해도 같다).
 * - 끝까지 실패하면 **마지막 오류를 그대로 던진다** - 호출자의 기존 오류 처리가 그대로 동작한다.
 *
 * @param label 로그에 찍을 이름. **URL을 넘기지 말 것** - 텔레그램 API URL에는 봇 토큰이 들어 있다.
 */
export async function sendTelegramWithRetry(
  label: string,
  attempt: () => Promise<Response>,
  deps: TelegramRetryDeps = {}
): Promise<Response> {
  const delays = deps.delaysMs ?? TELEGRAM_RETRY_DELAYS_MS;
  const sleep = deps.sleep ?? defaultSleep;
  const log = deps.log ?? ((message: string) => console.warn(message));
  const attempts = delays.length + 1;

  let lastError: unknown;
  for (let attemptNo = 1; attemptNo <= attempts; attemptNo += 1) {
    try {
      const response = await attempt();
      if (response.ok || !isRetryableTelegramStatus(response.status)) {
        if (attemptNo > 1 && response.ok) log(`ℹ️ [telegram] ${label} ${attemptNo}/${attempts}회차에 성공했습니다`);
        return response;
      }
      lastError = new Error(`Telegram ${label} 실패: HTTP ${response.status}`);
      if (attemptNo === attempts) return response;
      log(`⚠️ [telegram] ${label} HTTP ${response.status} - ${delays[attemptNo - 1]! / 1000}초 뒤 다시 보냅니다`);
    } catch (error) {
      // 네트워크 거절(fetch failed). 메시지에 URL이 섞일 수 있어 label만 찍는다.
      lastError = error;
      if (attemptNo === attempts) break;
      const reason = redactBotToken(error instanceof Error ? error.message : String(error));
      log(`⚠️ [telegram] ${label} 전송 실패(${reason}) - ${delays[attemptNo - 1]! / 1000}초 뒤 다시 보냅니다`);
    }
    await sleep(delays[attemptNo - 1]!);
  }

  throw lastError instanceof Error ? lastError : new Error(`Telegram ${label} 실패`);
}
