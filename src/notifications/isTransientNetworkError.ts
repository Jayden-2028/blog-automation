// DNS/네트워크 장애로 보이는 에러인지 판정한다.
//
// 왜 필요한가(2026-09-02 실측): Supabase 도메인 DNS가 몇 시간 죽어있는 동안 telegramPollJob이
// 매번 실패했는데, pollOnce가 "실패한 update도 offset을 전진시킨다"는 설계 때문에 GO 클릭이
// 영구히 유실됐다. 코드/데이터 문제(만료된 callback_data 등)는 재시도해도 똑같이 실패하니 건너뛰고
// 넘어가는 게 맞지만, 인프라 장애는 재시도하면 성공한다 - 둘을 구분해야 offset 전진 여부를 정할 수 있다.
//
// Supabase-js는 fetch 자체가 던진 예외를 { message, details, hint, code } 형태로 감싸 던지고,
// 원본 네트워크 에러(ENOTFOUND 등)는 message가 아니라 details 문자열 안에 들어간다. 네이티브
// fetch TypeError는 .cause 체인에 실제 코드가 있다. 둘 다 봐야 한다.
const TRANSIENT_NETWORK_MARKERS = [
  "fetch failed",
  "ENOTFOUND",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENETUNREACH",
  "socket hang up",
];

function collectErrorText(error: unknown, depth = 0): string {
  if (depth > 5 || error === null || error === undefined) return "";
  if (typeof error === "string") return error;
  if (typeof error !== "object") return String(error);

  const record = error as Record<string, unknown> & { cause?: unknown };
  const parts: string[] = [];
  if (typeof record.message === "string") parts.push(record.message);
  if (typeof record.details === "string") parts.push(record.details);
  if (record.cause !== undefined) parts.push(collectErrorText(record.cause, depth + 1));
  return parts.join("\n");
}

/** DNS 조회 실패·연결 거부·타임아웃 등 재시도하면 성공할 수 있는 인프라 장애인지 판정한다. */
export function isTransientNetworkError(error: unknown): boolean {
  const text = collectErrorText(error);
  return TRANSIENT_NETWORK_MARKERS.some((marker) => text.includes(marker));
}
