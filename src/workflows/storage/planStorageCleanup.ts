// Storage 정리 계획(개편2.5 D). 순수 함수 - DB·Storage 호출 없음. 무엇을 지울지 **고르는 규칙**만 담는다.
//
// 지우는 것: 발행이 끝난 지 N일(기본 14) 지난 원고의 `article-images` 객체(`<jobId>/...`).
// 지우지 않는 것(안전장치):
//   · Blogspot에 올라갔거나 올라가는 중인 job - Blogspot 글은 본문 <img src>가 **Storage 공개 URL을 직접 가리킨다**
//     (convertArticleToHtml.ts). 지우면 게시된 글의 이미지가 깨진다. 네이버·티스토리는 발행기가 이미지를 자기 쪽에 올리므로
//     Storage 원본이 없어도 글은 멀쩡하다.
//   · 플랫폼이 비어 있는(옛) 기록이 있는 job - 어디로 나갔는지 모르니 보수적으로 남긴다.
//   · 아직 N일이 안 지난 job, 발행 기록이 없는 job(승인 대기·실패 포함).

import type { PublicationRow } from "../../types/database.js";

export const DEFAULT_RETENTION_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

/** job 한 건의 발행 기록 묶음. article_id가 아니라 job 단위다(수정 반영으로 article이 여러 개일 수 있다). */
export type JobPublications = { jobId: string; publications: Pick<PublicationRow, "platform" | "status" | "published_at" | "created_at">[] };

export type CleanupSkipReason = "blogspot_hotlink" | "unknown_platform" | "not_published" | "too_recent";

export type CleanupCandidate = { jobId: string; publishedAt: string };
export type CleanupSkip = { jobId: string; reason: CleanupSkipReason };

const SAFE_PLATFORMS = new Set(["naver", "tistory"]);

/** 정리 대상 job과 건너뛴 job(사유 포함)을 가른다. */
export function selectCleanupJobs(
  jobs: readonly JobPublications[],
  now: Date,
  retentionDays: number = DEFAULT_RETENTION_DAYS
): { candidates: CleanupCandidate[]; skipped: CleanupSkip[] } {
  const candidates: CleanupCandidate[] = [];
  const skipped: CleanupSkip[] = [];
  const cutoff = now.getTime() - retentionDays * DAY_MS;

  for (const { jobId, publications } of jobs) {
    // 진행 중·완료를 가리지 않고 Blogspot 흔적이 하나라도 있으면 남긴다.
    if (publications.some((p) => p.platform === "blogspot")) {
      skipped.push({ jobId, reason: "blogspot_hotlink" });
      continue;
    }
    if (publications.some((p) => !p.platform || !SAFE_PLATFORMS.has(p.platform))) {
      skipped.push({ jobId, reason: "unknown_platform" });
      continue;
    }
    const published = publications.filter((p) => p.status === "published");
    // 아직 올라가는 중이거나 실패한 기록이 섞여 있어도, 완료 건이 하나도 없으면 대상이 아니다.
    if (published.length === 0) {
      skipped.push({ jobId, reason: "not_published" });
      continue;
    }
    // **가장 최근** 발행 기준이다 - 두 채널에 나갔으면 늦게 나간 쪽부터 N일을 센다.
    const latest = Math.max(...published.map((p) => new Date(p.published_at ?? p.created_at).getTime()));
    if (Number.isNaN(latest) || latest > cutoff) {
      skipped.push({ jobId, reason: "too_recent" });
      continue;
    }
    // 진행 중(pending/publishing) 기록이 같이 있으면 아직 Storage 원본이 필요할 수 있다.
    if (publications.some((p) => p.status === "pending" || p.status === "publishing")) {
      skipped.push({ jobId, reason: "too_recent" });
      continue;
    }
    candidates.push({ jobId, publishedAt: new Date(latest).toISOString() });
  }
  return { candidates, skipped };
}

export type StorageObject = { name: string; size: number };

export type CleanupPlan = {
  /** 지울 객체 경로(`<jobId>/<name>`). */
  paths: string[];
  bytes: number;
  jobs: number;
  /** 객체가 하나도 없어 할 일이 없는 대상 job 수(이미 정리됐거나 이미지 없음). */
  emptyJobs: number;
};

/** 대상 job들의 Storage 객체 목록으로 삭제 계획을 만든다. */
export function buildCleanupPlan(objectsByJob: ReadonlyMap<string, readonly StorageObject[]>): CleanupPlan {
  const plan: CleanupPlan = { paths: [], bytes: 0, jobs: 0, emptyJobs: 0 };
  for (const [jobId, objects] of objectsByJob) {
    if (objects.length === 0) {
      plan.emptyJobs += 1;
      continue;
    }
    plan.jobs += 1;
    for (const object of objects) {
      plan.paths.push(`${jobId}/${object.name}`);
      plan.bytes += object.size;
    }
  }
  return plan;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}
