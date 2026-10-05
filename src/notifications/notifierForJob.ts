// job을 다루는 알림이 "어느 봇으로 보낼지"를 고르는 한 곳(RESTRUCTURE-PLAN-2026-10.md §3.1).
// job.metadata.track이 곧 봇이다(telegramTracks.ts 주석). 트랙 값이 없으면 메인봇(엔터).
import { TelegramNotifier } from "./TelegramNotifier.js";
import { DEFAULT_TRACK, trackOfJob } from "./telegramTracks.js";

export function notifierForJob(job: { metadata?: unknown } | null | undefined): TelegramNotifier {
  return TelegramNotifier.fromEnv(trackOfJob(job));
}

/**
 * jobId만 알 때. job 조회가 실패해도 알림을 포기하지 않고 메인봇으로 보낸다 - 실패 알림이 조회 오류
 * 때문에 통째로 사라지는 것이 오배송보다 나쁘다(사용자는 어느 쪽이든 "실패했다"는 사실을 받아야 한다).
 * Supabase client를 늦게 불러오는 이유: 이 모듈을 import만 하는 테스트가 DB 환경변수를 요구하지 않게.
 */
export async function notifierForJobId(jobId: string): Promise<TelegramNotifier> {
  try {
    const { ArticleJobRepository } = await import("../repositories/ArticleJobRepository.js");
    const job = await ArticleJobRepository.findById(jobId);
    return TelegramNotifier.fromEnv(trackOfJob(job));
  } catch {
    return TelegramNotifier.fromEnv(DEFAULT_TRACK);
  }
}
