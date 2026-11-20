// publish-poll 진행 상황을 작은 JSON 파일로 남긴다. 경로는 env PUBLISH_POLL_STATE_FILE이고
// 비어 있으면 아무것도 하지 않는다(맥 로컬 폴러·테스트에는 영향 없음).
//
// 왜 필요한가(2026-11-20, run 44688103846): 원고 준비 중 DB 문장 시간 초과(57014)로 run이 죽었는데,
// 실패 알림(scripts/notifyWorkflowFailure.mjs)은 "준비 대기 큐"로 job을 찾았다. 그런데 그 job은
// 이미 channelManuscriptsReadyAt이 찍혀 큐에서 빠진 뒤라 "job 식별 실패"만 나갔다. 알림이 읽는 쪽이
// DB가 아니라 이 파일이면, DB가 흔들려도(바로 그 사고가 DB 장애였다) 어느 원고가 어느 단계에서
// 무엇 때문에 멈췄는지 알린다.
//
// 이 기록은 보조다 - 쓰다 실패해도 절대 job 밖으로 던지지 않는다.
import { writeFileSync } from "node:fs";

export type PublishPollStateJob = {
  id: string;
  keyword: string;
  category: string | null;
  /** 알림이 트랙 봇을 고를 때 쓴다(trackOfJob이 metadata.track만 본다). */
  metadata: { track?: unknown };
};

export type PublishPollState = {
  jobs: PublishPollStateJob[];
  stage: string;
  error?: { code: string; message: string };
};

let current: PublishPollState | null = null;

function flush(): void {
  const path = process.env.PUBLISH_POLL_STATE_FILE;
  if (!path || !current) return;
  try {
    writeFileSync(path, JSON.stringify(current), "utf8");
  } catch (error) {
    console.warn(`⚠️ [publish-poll] 상태 파일 기록 실패(무시): ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function recordPublishPollStage(
  stage: string,
  jobs?: Array<{ id: string; keyword: string; category?: string | null; metadata?: Record<string, unknown> | null }>
): void {
  try {
    const nextJobs =
      jobs?.map((j) => ({
        id: j.id,
        keyword: j.keyword,
        category: j.category ?? null,
        metadata: { track: j.metadata?.track },
      })) ?? current?.jobs ?? [];
    current = { jobs: nextJobs, stage };
    flush();
  } catch {
    // 보조 기록이다 - 삼킨다.
  }
}

/** 토큰·키처럼 보이는 긴 문자열은 지운다. 알림 본문에 그대로 나가기 때문이다. */
function scrub(text: string): string {
  return text
    .replace(/Bearer\s+\S+/gi, "Bearer ***")
    .replace(/[A-Za-z0-9_\-.]{32,}/g, "***")
    .slice(0, 300);
}

export function recordPublishPollError(error: unknown): void {
  try {
    const rawCode = (error as { code?: unknown } | null)?.code;
    const code = typeof rawCode === "string" || typeof rawCode === "number" ? String(rawCode) : "";
    // supabase-js의 PostgrestError는 Error 인스턴스가 아닌 평범한 객체로 온다(2026-11-20 run 로그가 그랬다) -
    // String(error)면 "[object Object]"가 되니 message 필드부터 본다.
    const rawMessage = (error as { message?: unknown } | null)?.message;
    const message =
      typeof rawMessage === "string" ? rawMessage : typeof error === "string" ? error : JSON.stringify(error) ?? String(error);
    current = { jobs: current?.jobs ?? [], stage: current?.stage ?? "", error: { code, message: scrub(message) } };
    flush();
  } catch {
    // 삼킨다.
  }
}
