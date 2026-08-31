// 실패 원인을 문자열로 보존하는 공용 유틸.
//
// 왜 String(error)를 쓰면 안 되는가(2026-08-26 실측, CURRENT_STATE.md "에러 직렬화 결함" 참고):
// Supabase가 던지는 PostgrestError는 **Error 인스턴스가 아니라 평범한 객체**
// ({ message, details, hint, code })다. String(error)로 감싸면 "[object Object]"가 되어 실패 원인이
// 통째로 사라진다. 그때 이걸 고치지 않았으면 upsert 배치 conflict(21000) 원인을 못 찾았을 것이다.
//
// 이 파이프라인은 실패를 예외 대신 status + 문자열로 전달하는 구간이 많다(동적 소스 수집,
// buildDailyQueryPool). 그 구간에서 원인이 사라지면 Telegram 실패 알림도 "[object Object]"만
// 보내게 되므로, 문자열로 좁히는 지점마다 반드시 이 함수를 거친다.

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;

  if (error && typeof error === "object") {
    const e = error as { message?: unknown; details?: unknown; hint?: unknown; code?: unknown };
    const parts = [
      typeof e.message === "string" ? e.message : null,
      typeof e.code === "string" ? `code=${e.code}` : null,
      typeof e.details === "string" && e.details ? `details=${e.details}` : null,
      typeof e.hint === "string" && e.hint ? `hint=${e.hint}` : null,
    ].filter(Boolean);
    if (parts.length > 0) return parts.join(" | ");

    try {
      return JSON.stringify(error);
    } catch {
      // 순환 참조 등으로 직렬화조차 안 되는 경우. 최소한 타입은 남긴다.
      return Object.prototype.toString.call(error);
    }
  }

  return String(error);
}
