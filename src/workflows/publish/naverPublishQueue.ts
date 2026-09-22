// 네이버 발행 대기열. job.metadata에 플래그로 남긴다(2026-09-22 사용자 결정 - A안).
//
// 왜 큐가 필요한가: Blogspot은 공식 API라 텔레그램 버튼 -> GitHub Actions에서 바로 끝난다.
// 네이버는 공식 API가 없어 **로그인된 브라우저**가 필요하고, 그건 GitHub Actions에서 못 돌린다.
// 그래서 클라우드는 "올려달라"는 요청만 남기고, 맥의 로컬 폴러가 집어 간다.
//
//   [🟢 네이버 발행] -> Cloudflare Worker -> GH Actions: requestNaverPublish()
//                                                  ↓ (맥 launchd 폴러)
//                                          publishJobToNaver()
//
// 전용 테이블을 만들지 않은 이유: job.metadata(jsonb)는 이미 channelMeta·images·imagesReadyAt을
// 담고 있어 패턴이 같고, 마이그레이션이 필요 없다. 큐 길이도 하루 몇 건이라 테이블을 쓸 만큼
// 크지 않다. 나중에 커지면 그때 옮긴다.

import { ArticleJobRepository } from "../../repositories/ArticleJobRepository.js";
import type { ArticleJobRow } from "../../types/database.js";

/** job.metadata 안의 키. 이름을 바꾸면 이미 쌓인 요청을 잃는다. */
export const NAVER_REQUEST_KEY = "naverPublish";

export type NaverPublishRequest = {
  /** "requested" = 대기, "done" = 처리 완료, "failed" = 실패(사람이 보고 판단). */
  status: "requested" | "done" | "failed";
  requestedAt: string;
  finishedAt?: string;
  url?: string;
  error?: string;
};

export function readNaverRequest(job: ArticleJobRow): NaverPublishRequest | null {
  const raw = (job.metadata as Record<string, unknown> | null)?.[NAVER_REQUEST_KEY];
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<NaverPublishRequest>;
  if (value.status !== "requested" && value.status !== "done" && value.status !== "failed") return null;
  return { status: value.status, requestedAt: String(value.requestedAt ?? ""), finishedAt: value.finishedAt, url: value.url, error: value.error };
}

export type NaverQueueOptions = {
  mergeMetadata?: (jobId: string, patch: Record<string, unknown>) => Promise<unknown>;
  listRecentJobs?: (limit?: number) => Promise<ArticleJobRow[]>;
  now?: () => Date;
};

/**
 * 발행 요청을 남긴다(클라우드 쪽에서 호출).
 *
 * 이미 대기 중이면 덮어쓰지 않는다 - 버튼을 두 번 눌러도 요청 시각이 밀리지 않게 한다.
 * 실패했던 건은 다시 요청할 수 있다(사람이 고치고 다시 누르는 경로).
 */
export async function requestNaverPublish(
  job: ArticleJobRow,
  options: NaverQueueOptions = {}
): Promise<{ queued: boolean; reason?: string }> {
  const mergeMetadata = options.mergeMetadata ?? ((id, patch) => ArticleJobRepository.mergeMetadata(id, patch));
  const now = options.now ?? (() => new Date());

  const existing = readNaverRequest(job);
  if (existing?.status === "requested") return { queued: false, reason: "이미 대기 중입니다." };
  if (existing?.status === "done") return { queued: false, reason: "이미 네이버에 올라갔습니다." };

  const request: NaverPublishRequest = { status: "requested", requestedAt: now().toISOString() };
  await mergeMetadata(job.id, { [NAVER_REQUEST_KEY]: request });
  return { queued: true };
}

/** 처리 결과를 적는다(로컬 폴러 쪽에서 호출). */
export async function finishNaverPublish(
  jobId: string,
  outcome: { ok: true; url: string } | { ok: false; error: string },
  options: NaverQueueOptions = {}
): Promise<void> {
  const mergeMetadata = options.mergeMetadata ?? ((id, patch) => ArticleJobRepository.mergeMetadata(id, patch));
  const now = options.now ?? (() => new Date());
  const request: NaverPublishRequest = outcome.ok
    ? { status: "done", requestedAt: "", finishedAt: now().toISOString(), url: outcome.url }
    : { status: "failed", requestedAt: "", finishedAt: now().toISOString(), error: outcome.error };
  await mergeMetadata(jobId, { [NAVER_REQUEST_KEY]: request });
}

/**
 * 대기 중인 요청을 오래된 것부터 돌려준다(로컬 폴러가 쓴다).
 *
 * listRecent를 쓰는 이유: metadata jsonb 안의 키로 거르는 쿼리는 인덱스를 못 타고, 어차피
 * 최근 job 몇십 건만 보면 된다. 발행 요청이 며칠 묵는 일은 없다.
 */
export async function listPendingNaverRequests(options: NaverQueueOptions = {}): Promise<ArticleJobRow[]> {
  const listRecentJobs = options.listRecentJobs ?? ((limit) => ArticleJobRepository.listRecent(limit));
  const jobs = await listRecentJobs(100);
  return jobs
    .filter((job) => readNaverRequest(job)?.status === "requested")
    .sort((a, b) => {
      const at = readNaverRequest(a)?.requestedAt ?? "";
      const bt = readNaverRequest(b)?.requestedAt ?? "";
      return at.localeCompare(bt);
    });
}
