// 보관함 내보내기 "지금 실행" 대기열. naverPublishQueue와 같은 방식으로 job.metadata에 남긴다.
//
// 왜 필요한가: 원고와 이미지를 맥 보관함으로 내려받는 일은 맥의 launchd가 **30분마다** 한다
// (scripts/export-manuscripts.sh). 클라우드는 맥 디스크에 쓸 수 없으니 맥이 당겨오는 수밖에
// 없는데, 방금 준비된 원고를 바로 쓰고 싶을 때 그 30분이 길다. 그래서 텔레그램 버튼으로
// "지금 받아라"는 요청만 남기고, 맥의 빠른 폴러(job:export-poll, 1분 주기)가 집어 간다.
//
//   [⬇️ 맥으로 내려받기] -> Cloudflare Worker -> GH Actions: requestManuscriptExport()
//                                                       ↓ (맥 launchd 폴러, 1분)
//                                               exportManuscript()
//
// 맥이 꺼져 있으면 켜질 때 처리된다(요청은 DB에 남는다). 30분 주기 전체 내보내기는 그대로 둔다 -
// 이건 그 앞에 끼어드는 빠른 길일 뿐이라, 이 경로가 죽어도 원고는 늦어도 30분 안에 내려간다.
//
// 네이버 발행과 다른 점: **몇 번이고 다시 요청할 수 있다.** 같은 글을 두 번 발행하면 사고지만,
// 같은 원고를 두 번 내려받는 것은 덮어쓰기일 뿐이고(이미 있는 이미지는 건너뛴다), 이미지 수정
// 뒤에 다시 받는 것이 정상 흐름이다.

import { ArticleJobRepository } from "../../repositories/ArticleJobRepository.js";
import type { ArticleJobRow } from "../../types/database.js";

/** job.metadata 안의 키. 이름을 바꾸면 이미 쌓인 요청을 잃는다. */
export const EXPORT_REQUEST_KEY = "manuscriptExport";

export type ManuscriptExportRequest = {
  /** "requested" = 대기, "done" = 내려받음, "failed" = 실패(사람이 보고 판단). */
  status: "requested" | "done" | "failed";
  requestedAt: string;
  finishedAt?: string;
  /** 내려받은 보관함 폴더(사람에게 알려줄 경로). */
  dir?: string;
  error?: string;
};

export function readExportRequest(job: Pick<ArticleJobRow, "metadata">): ManuscriptExportRequest | null {
  const raw = (job.metadata as Record<string, unknown> | null)?.[EXPORT_REQUEST_KEY];
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<ManuscriptExportRequest>;
  if (value.status !== "requested" && value.status !== "done" && value.status !== "failed") return null;
  return {
    status: value.status,
    requestedAt: String(value.requestedAt ?? ""),
    finishedAt: value.finishedAt,
    dir: value.dir,
    error: value.error,
  };
}

export type ExportQueueOptions = {
  mergeMetadata?: (jobId: string, patch: Record<string, unknown>) => Promise<unknown>;
  listRecentJobs?: (limit?: number) => Promise<ArticleJobRow[]>;
  now?: () => Date;
};

/**
 * 내려받기 요청을 남긴다(클라우드 쪽에서 호출).
 *
 * 이미 대기 중이면 덮어쓰지 않는다 - 버튼을 두 번 눌러도 요청 시각이 밀리지 않게 한다.
 * 그 외(처음·완료·실패)는 언제든 다시 요청할 수 있다.
 */
export async function requestManuscriptExport(
  job: ArticleJobRow,
  options: ExportQueueOptions = {}
): Promise<{ queued: boolean; reason?: string }> {
  const mergeMetadata = options.mergeMetadata ?? ((id, patch) => ArticleJobRepository.mergeMetadata(id, patch));
  const now = options.now ?? (() => new Date());

  if (readExportRequest(job)?.status === "requested") {
    return { queued: false, reason: "이미 대기 중입니다. 맥이 켜져 있으면 곧 내려받습니다." };
  }

  const request: ManuscriptExportRequest = { status: "requested", requestedAt: now().toISOString() };
  await mergeMetadata(job.id, { [EXPORT_REQUEST_KEY]: request });
  return { queued: true };
}

/**
 * 처리 결과를 적는다(로컬 폴러 쪽에서 호출).
 *
 * job 행을 받는 이유는 **원래 요청 시각을 지키기 위해서다** - 언제 눌렀는지는 나중에 "요청이
 * 얼마나 묵었나"를 보는 유일한 단서인데, 결과를 쓰면서 지워 버리면 알 길이 없어진다.
 */
export async function finishManuscriptExport(
  job: ArticleJobRow,
  outcome: { ok: true; dir: string } | { ok: false; error: string },
  options: ExportQueueOptions = {}
): Promise<void> {
  const mergeMetadata = options.mergeMetadata ?? ((id, patch) => ArticleJobRepository.mergeMetadata(id, patch));
  const now = options.now ?? (() => new Date());
  const requestedAt = readExportRequest(job)?.requestedAt ?? "";
  const request: ManuscriptExportRequest = outcome.ok
    ? { status: "done", requestedAt, finishedAt: now().toISOString(), dir: outcome.dir }
    : { status: "failed", requestedAt, finishedAt: now().toISOString(), error: outcome.error };
  await mergeMetadata(job.id, { [EXPORT_REQUEST_KEY]: request });
}

/**
 * 대기 중인 요청을 오래된 것부터 돌려준다(로컬 폴러가 쓴다).
 *
 * listRecent를 쓰는 이유는 naverPublishQueue와 같다 - metadata jsonb 안의 키로 거르는 쿼리는
 * 인덱스를 못 타고, 어차피 최근 job 몇십 건만 보면 된다.
 */
export async function listPendingExportRequests(options: ExportQueueOptions = {}): Promise<ArticleJobRow[]> {
  // 2026-10-09 egress 절감: 기본 경로는 전체 행(회당 ~3MB)이 아니라 요청 조각만 받아 거른 뒤,
  // 실제 집어 갈 소수 건만 전체 행을 다시 받는다. 테스트 주입(listRecentJobs)은 전체 행이므로 그대로 쓴다.
  const injected = options.listRecentJobs;
  const candidates = injected ? await injected(100) : await ArticleJobRepository.listRecentSlim([EXPORT_REQUEST_KEY], 100);
  const pending = candidates
    .filter((job) => readExportRequest(job)?.status === "requested")
    .sort((a, b) => {
      const at = readExportRequest(a)?.requestedAt ?? "";
      const bt = readExportRequest(b)?.requestedAt ?? "";
      return at.localeCompare(bt);
    });
  if (injected) return pending as ArticleJobRow[];
  // 조각 조회와 전체 조회 사이에 상태가 바뀌었을 수 있어 받은 전체 행으로 한 번 더 거른다(순서 유지).
  const byId = new Map((await ArticleJobRepository.listByIds(pending.map((job) => job.id))).map((job) => [job.id, job]));
  return pending
    .map((job) => byId.get(job.id))
    .filter((job): job is ArticleJobRow => Boolean(job) && readExportRequest(job as ArticleJobRow)?.status === "requested");
}
