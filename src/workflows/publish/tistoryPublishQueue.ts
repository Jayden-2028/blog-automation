// 티스토리 발행 대기열(TISTORY_AUTO_PUBLISH_DESIGN.md §1·§3). naverPublishQueue.ts와 같은 모양으로
// job.metadata(jsonb)에 플래그로 남긴다 - migration 없음.
//
// 네이버와 다른 한 가지: **"deferred"(로그인 대기)** 상태가 있다. 티스토리(카카오) 로그인은 주기적으로
// 풀리는데, 사회 트랙은 사용자가 바로 개입할 수 있는 트랙이라(사용자 전제) 이걸 실패로 치지 않고 대기로 둔다.
// 사용자가 맥미니에서 다시 로그인하면 폴러가 다음 주기에 대기 건을 알아서 다시 집는다. 단 3일(TISTORY_CONFIG.
// deferredMaxDays)이 지난 대기 건은 자동 재개하지 않는다 - 묵은 글이 재로그인 직후 한꺼번에 올라가는 걸 막는다
// (2026-10-06 사용자 결정). 그런 건은 버튼을 다시 눌러야 한다.
//
//   [🟠 티스토리 발행] (텔레그램 또는 뷰어) -> requestTistoryPublish()
//                                               ↓ (맥미니 launchd tistory-poll)
//                                       publishJobToTistory()
//                                         ├ 성공/실패  -> finishTistoryPublish()
//                                         └ 로그인 풀림 -> deferTistoryPublish()  (재로그인 후 자동 재개)

import { ArticleJobRepository } from "../../repositories/ArticleJobRepository.js";
import type { ArticleJobRow } from "../../types/database.js";

/** job.metadata 안의 키. 이름을 바꾸면 이미 쌓인 요청을 잃는다. */
export const TISTORY_REQUEST_KEY = "tistoryPublish";

export type TistoryPublishStatus = "requested" | "deferred" | "done" | "failed" | "published_unrecorded";

export type TistoryPublishRequest = {
  /** requested = 대기, deferred = 로그인 풀려 보류(재로그인 후 자동 재개), done = 완료, failed = 실패(사람이 보고 판단),
   * published_unrecorded = 티스토리에는 올라갔는데 publications 기록만 실패(폴러가 다시 집지 않는다 - 중복 발행 방지, 사람이 확인). */
  status: TistoryPublishStatus;
  requestedAt: string;
  /** 어디서 눌렀나. 알림 문구와 추적에만 쓴다. */
  source?: "telegram" | "viewer";
  /** deferred가 처음 기록된 시각. 3일 만료의 기준이다(재시도마다 갱신하지 않는다). */
  deferredAt?: string;
  /** 로그인 풀림 알림을 보낸 시각. 같은 사유로 폴링마다 알림이 쏟아지지 않게 한다. */
  notifiedAt?: string;
  finishedAt?: string;
  url?: string;
  error?: string;
};

export function readTistoryRequest(job: ArticleJobRow): TistoryPublishRequest | null {
  const raw = (job.metadata as Record<string, unknown> | null)?.[TISTORY_REQUEST_KEY];
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<TistoryPublishRequest>;
  const known: readonly TistoryPublishStatus[] = ["requested", "deferred", "done", "failed", "published_unrecorded"];
  if (!known.includes(value.status as TistoryPublishStatus)) return null;
  return {
    status: value.status as TistoryPublishStatus,
    requestedAt: String(value.requestedAt ?? ""),
    source: value.source,
    deferredAt: value.deferredAt,
    notifiedAt: value.notifiedAt,
    finishedAt: value.finishedAt,
    url: value.url,
    error: value.error,
  };
}

export type TistoryQueueOptions = {
  mergeMetadata?: (jobId: string, patch: Record<string, unknown>) => Promise<unknown>;
  listRecentJobs?: (limit?: number) => Promise<ArticleJobRow[]>;
  now?: () => Date;
  /** deferred가 이 일수를 넘기면 자동 재개 대상에서 뺀다. 기본은 TISTORY_CONFIG.deferredMaxDays(3). */
  deferredMaxDays?: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function defaultDeferredMaxDays(): number {
  const raw = Number.parseInt(process.env.TISTORY_DEFERRED_MAX_DAYS ?? "", 10);
  return Number.isNaN(raw) ? 3 : raw;
}

/**
 * 발행 요청을 남긴다(텔레그램·뷰어 어느 쪽에서든 같은 함수).
 *
 * 이미 대기·보류 중이면 덮어쓰지 않는다 - 버튼을 두 번 눌러도 요청 시각이 밀리지 않게 한다. **만료된 보류
 * 건**(3일 초과)은 다시 누르면 새 요청으로 받는다 - 그게 "사람이 다시 눌러야 한다"의 뜻이다.
 * 실패했던 건도 다시 요청할 수 있다(사람이 고치고 다시 누르는 경로).
 */
export async function requestTistoryPublish(
  job: ArticleJobRow,
  options: TistoryQueueOptions & { source?: "telegram" | "viewer" } = {}
): Promise<{ queued: boolean; reason?: string }> {
  const mergeMetadata = options.mergeMetadata ?? ((id, patch) => ArticleJobRepository.mergeMetadata(id, patch));
  const now = options.now ?? (() => new Date());

  const existing = readTistoryRequest(job);
  if (existing?.status === "requested") return { queued: false, reason: "이미 대기 중입니다." };
  if (existing?.status === "deferred" && !isDeferredExpired(existing, now(), options.deferredMaxDays)) {
    return { queued: false, reason: "로그인 대기 중입니다. 맥미니에서 티스토리에 다시 로그인하면 올라갑니다." };
  }
  if (existing?.status === "done") return { queued: false, reason: "이미 티스토리에 올라갔습니다." };
  if (existing?.status === "published_unrecorded") {
    return { queued: false, reason: "티스토리에는 올라갔지만 기록이 실패했습니다. 중복 발행을 막기 위해 다시 올리지 않습니다 - 티스토리를 직접 확인해 주세요." };
  }

  const request: TistoryPublishRequest = {
    status: "requested",
    requestedAt: now().toISOString(),
    ...(options.source ? { source: options.source } : {}),
  };
  await mergeMetadata(job.id, { [TISTORY_REQUEST_KEY]: request });
  return { queued: true };
}

/** 처리 결과를 적는다(맥미니 폴러 쪽에서 호출). */
export async function finishTistoryPublish(
  jobId: string,
  outcome: { ok: true; url: string } | { ok: false; error: string } | { ok: "unrecorded"; url: string; error: string },
  options: TistoryQueueOptions = {}
): Promise<void> {
  const mergeMetadata = options.mergeMetadata ?? ((id, patch) => ArticleJobRepository.mergeMetadata(id, patch));
  const now = options.now ?? (() => new Date());
  const finishedAt = now().toISOString();
  const request: TistoryPublishRequest =
    outcome.ok === true
      ? { status: "done", requestedAt: "", finishedAt, url: outcome.url }
      : outcome.ok === "unrecorded"
        ? { status: "published_unrecorded", requestedAt: "", finishedAt, url: outcome.url, error: outcome.error }
        : { status: "failed", requestedAt: "", finishedAt, error: outcome.error };
  await mergeMetadata(jobId, { [TISTORY_REQUEST_KEY]: request });
}

/**
 * 로그인이 풀려 처리를 미룬다. 처음 미룰 때의 시각(deferredAt)과 요청 시각은 보존한다 - 만료 판단과
 * 처리 순서가 재시도 때마다 밀리면 안 된다. `notified`가 true면 알림 시각도 함께 적는다.
 */
export async function deferTistoryPublish(
  job: ArticleJobRow,
  options: TistoryQueueOptions & { notified?: boolean } = {}
): Promise<TistoryPublishRequest> {
  const mergeMetadata = options.mergeMetadata ?? ((id, patch) => ArticleJobRepository.mergeMetadata(id, patch));
  const now = options.now ?? (() => new Date());
  const existing = readTistoryRequest(job);
  const nowIso = now().toISOString();
  const request: TistoryPublishRequest = {
    status: "deferred",
    requestedAt: existing?.requestedAt || nowIso,
    source: existing?.source,
    deferredAt: existing?.deferredAt ?? nowIso,
    notifiedAt: options.notified ? nowIso : existing?.notifiedAt,
  };
  await mergeMetadata(job.id, { [TISTORY_REQUEST_KEY]: request });
  return request;
}

export function isDeferredExpired(
  request: TistoryPublishRequest,
  now: Date,
  deferredMaxDays: number = defaultDeferredMaxDays()
): boolean {
  if (request.status !== "deferred") return false;
  const since = new Date(request.deferredAt ?? request.requestedAt).getTime();
  if (Number.isNaN(since)) return true;
  return now.getTime() - since > deferredMaxDays * DAY_MS;
}

/**
 * 폴러가 집어 갈 건: 대기(requested) + 만료되지 않은 보류(deferred). 오래된 요청부터.
 * listRecent를 쓰는 이유는 naverPublishQueue와 같다(jsonb 키 필터는 인덱스를 못 타고, 최근 100건이면 충분).
 */
export async function listPendingTistoryRequests(options: TistoryQueueOptions = {}): Promise<ArticleJobRow[]> {
  const listRecentJobs = options.listRecentJobs ?? ((limit) => ArticleJobRepository.listRecent(limit));
  const now = options.now ?? (() => new Date());
  const jobs = await listRecentJobs(100);
  return jobs
    .filter((job) => {
      const request = readTistoryRequest(job);
      if (!request) return false;
      if (request.status === "requested") return true;
      return request.status === "deferred" && !isDeferredExpired(request, now(), options.deferredMaxDays);
    })
    .sort((a, b) => {
      const at = readTistoryRequest(a)?.requestedAt ?? "";
      const bt = readTistoryRequest(b)?.requestedAt ?? "";
      return at.localeCompare(bt);
    });
}

/** 만료된 보류 건(사람이 다시 눌러야 하는 것). 폴러가 하루 한 번 알려 주는 데 쓴다. */
export function listExpiredDeferred(jobs: ArticleJobRow[], now: Date, deferredMaxDays?: number): ArticleJobRow[] {
  return jobs.filter((job) => {
    const request = readTistoryRequest(job);
    return !!request && isDeferredExpired(request, now, deferredMaxDays);
  });
}
