// 맥미니 자료조사 대기열(2026-11-01). RESEARCH_PROVIDER=codex일 때만 쓰인다.
//
// 왜 DB 큐가 아니라 job.metadata인가: tistoryPublish/naverPublish 대기열과 같은 이유다 - 맥에서만
// 돌 수 있는 단계를 클라우드가 "요청"으로만 남기고 맥 폴러가 집어 간다. migration이 없어 되돌리기도
// 쉽다(키를 안 보면 그만이다).
//
//   [Go 버튼] / [인스타 job 생성]  -> requestLocalResearch()      (status는 selected 그대로)
//                                      ↓ (맥미니 launchd research-poll, 60초)
//                                  claimLocalResearch()           (running - 같은 job을 두 번 집지 않는다)
//                                      ↓
//                                  runResearchStage(provider: "codex")   최대 25분
//                                      ↓
//                                  finishLocalResearch()          (done / failed)
//
// **status를 새로 만들지 않는다**(사용자 지시). 조사 대기는 기존 모델 그대로 `selected`이고,
// "조사를 기다리는 중"임은 이 metadata 표식이 드러낸다 - Actions 경로에서도 큐에 올린 job은
// 디스패치될 때까지 selected로 기다리므로 두 경로의 상태 모델이 같다. 폴러가 집는 순간
// runResearchStage가 researching으로 올린다.

import { ArticleJobRepository } from "../../repositories/ArticleJobRepository.js";
import type { ArticleJobRow } from "../../types/database.js";

/** job.metadata 안의 키. 이름을 바꾸면 이미 쌓인 요청을 잃는다. */
export const LOCAL_RESEARCH_KEY = "localResearch";

export type LocalResearchStatus = "requested" | "running" | "done" | "failed";

export type LocalResearchRequest = {
  status: LocalResearchStatus;
  /** 이 대기열은 Codex 전용이다. 다른 값이 들어오면 폴러가 집지 않는다(불변식 ① 방어선). */
  provider: "codex";
  requestedAt: string;
  /** 폴러가 집어 간 시각. running이 이 시각부터 STALE_CLAIM_MS를 넘기면 잔재로 보고 다시 집는다. */
  claimedAt?: string;
  finishedAt?: string;
  error?: string;
};

/**
 * running 표식이 이 시간을 넘기면 죽은 프로세스의 잔재로 보고 다시 집는다. Codex 조사 1건의 실측
 * 상한이 840초(14분)이고 실행기 타임아웃이 25분이라, 그보다 넉넉히 둔다 - 짧게 잡으면 아직 돌고
 * 있는 조사를 두 번 돌린다.
 */
export const STALE_CLAIM_MS = 40 * 60 * 1000;

export function readLocalResearchRequest(job: Pick<ArticleJobRow, "metadata">): LocalResearchRequest | null {
  const raw = (job.metadata as Record<string, unknown> | null)?.[LOCAL_RESEARCH_KEY];
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<LocalResearchRequest>;
  const known: readonly LocalResearchStatus[] = ["requested", "running", "done", "failed"];
  if (!known.includes(value.status as LocalResearchStatus)) return null;
  if (value.provider !== "codex") return null;
  return {
    status: value.status as LocalResearchStatus,
    provider: "codex",
    requestedAt: String(value.requestedAt ?? ""),
    claimedAt: value.claimedAt,
    finishedAt: value.finishedAt,
    error: value.error,
  };
}

export type LocalResearchQueueOptions = {
  mergeMetadata?: (jobId: string, patch: Record<string, unknown>) => Promise<unknown>;
  listRecentJobs?: (limit?: number) => Promise<Pick<ArticleJobRow, "id" | "metadata">[]>;
  now?: () => Date;
  staleClaimMs?: number;
};

function mergeMetadataFn(options: LocalResearchQueueOptions) {
  return options.mergeMetadata ?? ((id: string, patch: Record<string, unknown>) => ArticleJobRepository.mergeMetadata(id, patch));
}

/**
 * 조사 요청을 맥미니 대기열에 남긴다. Actions로는 아무것도 보내지 않는다.
 *
 * 이미 대기·진행 중이면 덮어쓰지 않는다 - 버튼을 두 번 눌러도 요청 시각이 밀리거나 돌고 있는
 * 조사가 처음부터 다시 시작되지 않게 한다. 끝난 건(done/failed)은 다시 요청할 수 있다(사람이
 * 고치고 다시 누르는 경로).
 */
export async function requestLocalResearch(
  jobId: string,
  options: LocalResearchQueueOptions & { existing?: LocalResearchRequest | null } = {}
): Promise<{ queued: boolean; reason?: string }> {
  const now = options.now ?? (() => new Date());
  const existing =
    options.existing !== undefined
      ? options.existing
      : await (async () => {
          const job = await ArticleJobRepository.findById(jobId);
          return job ? readLocalResearchRequest(job) : null;
        })();

  if (existing && (existing.status === "requested" || existing.status === "running")) {
    return { queued: false, reason: `이미 맥미니 조사 대기열에 있습니다 (${existing.status})` };
  }

  const request: LocalResearchRequest = {
    status: "requested",
    provider: "codex",
    requestedAt: now().toISOString(),
  };
  await mergeMetadataFn(options)(jobId, { [LOCAL_RESEARCH_KEY]: request, researchProvider: "codex" });
  return { queued: true };
}

/** 이번 주기에 집을 수 있는 건(요청 중 + 잔재가 된 running). 요청 시각 오름차순. */
export function filterDueLocalResearch<T extends Pick<ArticleJobRow, "metadata">>(
  jobs: readonly T[],
  options: LocalResearchQueueOptions = {}
): T[] {
  const nowMs = (options.now ?? (() => new Date()))().getTime();
  const staleMs = options.staleClaimMs ?? STALE_CLAIM_MS;
  const due = jobs.filter((job) => {
    const request = readLocalResearchRequest(job);
    if (!request) return false;
    if (request.status === "requested") return true;
    if (request.status !== "running") return false;
    const claimedMs = Date.parse(request.claimedAt ?? "");
    // claimedAt을 못 읽으면 잔재로 본다 - 안 그러면 영영 안 집힌다.
    return !Number.isFinite(claimedMs) || nowMs - claimedMs > staleMs;
  });
  return due.sort((a, b) => {
    const at = readLocalResearchRequest(a)?.requestedAt ?? "";
    const bt = readLocalResearchRequest(b)?.requestedAt ?? "";
    return at.localeCompare(bt);
  });
}

/** 대기 중인 job 목록(오래된 것 먼저). egress 절감을 위해 metadata 조각만 받는다. */
export async function listPendingLocalResearch(options: LocalResearchQueueOptions = {}): Promise<Pick<ArticleJobRow, "id" | "metadata">[]> {
  const list = options.listRecentJobs ?? (async (limit = 100) => ArticleJobRepository.listRecentSlim([LOCAL_RESEARCH_KEY], limit));
  return filterDueLocalResearch(await list(100), options);
}

/** 폴러가 집어 간다. running으로 바꿔 같은 job을 다음 주기에 다시 집지 않게 한다. */
export async function claimLocalResearch(
  jobId: string,
  request: LocalResearchRequest,
  options: LocalResearchQueueOptions = {}
): Promise<void> {
  const now = options.now ?? (() => new Date());
  const claimed: LocalResearchRequest = { ...request, status: "running", claimedAt: now().toISOString() };
  await mergeMetadataFn(options)(jobId, { [LOCAL_RESEARCH_KEY]: claimed });
}

/** 처리가 끝났다. 대기 표식을 내려(done/failed) 폴러가 다시 집지 않게 한다. */
export async function finishLocalResearch(
  jobId: string,
  request: LocalResearchRequest,
  outcome: { ok: true } | { ok: false; error: string },
  options: LocalResearchQueueOptions = {}
): Promise<void> {
  const now = options.now ?? (() => new Date());
  const finished: LocalResearchRequest = {
    ...request,
    status: outcome.ok ? "done" : "failed",
    finishedAt: now().toISOString(),
    ...(outcome.ok ? {} : { error: outcome.error.slice(0, 500) }),
  };
  await mergeMetadataFn(options)(jobId, { [LOCAL_RESEARCH_KEY]: finished });
}
