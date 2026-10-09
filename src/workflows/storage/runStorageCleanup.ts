// Storage 정리 실행(개편2.5 D). 규칙은 planStorageCleanup.ts, 여기는 DB·Storage 입출력과 결과 보고다.
//
// **dry-run이 기본**이다 - 대상 목록·용량만 산출하고 아무것도 지우지 않는다. 실삭제는 `apply: true`(CLI의 `--apply`)일 때만.
// 읽기(publications·articles 조회, Storage 목록)는 dry-run에서도 한다.
import { ARTICLE_IMAGES_BUCKET } from "../../services/supabase/storage/uploadArticleImage.js";
import { supabase } from "../../services/supabase/client.js";
import {
  buildCleanupPlan,
  DEFAULT_REJECTED_RETENTION_DAYS,
  DEFAULT_RETENTION_DAYS,
  formatBytes,
  selectCleanupJobs,
  selectRejectedCleanupJobs,
} from "./planStorageCleanup.js";
import type { CleanupPlan, CleanupSkip, JobPublications, RejectedJob, StorageObject } from "./planStorageCleanup.js";

export type StorageCleanupDeps = {
  loadJobPublications: () => Promise<JobPublications[]>;
  /** 반려된 job 목록(PIPELINE-MERGE §4). 생략하면 반려분은 건드리지 않는다(옛 호출부·테스트 호환). */
  loadRejectedJobs?: () => Promise<RejectedJob[]>;
  listObjects: (jobId: string) => Promise<StorageObject[]>;
  /** 객체를 지우고 실제로 지워진 개수를 돌려준다. */
  removeObjects: (paths: string[]) => Promise<number>;
};

export type StorageCleanupResult = {
  apply: boolean;
  retentionDays: number;
  candidateJobs: number;
  /** 그중 반려분(발행 이력 없음, 반려 후 N일 경과). candidateJobs에 포함된다. */
  rejectedCandidateJobs: number;
  rejectedRetentionDays: number;
  skipped: Record<CleanupSkip["reason"], number>;
  /** 반려분에서 보존한 건수(사유별). */
  rejectedSkipped: { has_publication: number; too_recent: number; no_timestamp: number };
  plan: CleanupPlan;
  /** apply일 때만 채워진다. */
  removed: number;
  /** 삭제에 실패한 객체 수(apply). */
  failed: number;
};

const PAGE = 1000;
const IN_CHUNK = 200;
const REMOVE_CHUNK = 100;

export async function loadJobPublicationsFromDb(): Promise<JobPublications[]> {
  const publications: { article_id: number; platform: string | null; status: string; published_at: string | null; created_at: string }[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("publications")
      .select("article_id, platform, status, published_at, created_at")
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    publications.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }

  const articleIds = [...new Set(publications.map((p) => p.article_id))];
  const jobByArticle = new Map<number, string>();
  for (let i = 0; i < articleIds.length; i += IN_CHUNK) {
    const { data, error } = await supabase.from("articles").select("id, job_id").in("id", articleIds.slice(i, i + IN_CHUNK));
    if (error) throw error;
    for (const row of data ?? []) if (row.job_id) jobByArticle.set(row.id, row.job_id);
  }

  const byJob = new Map<string, JobPublications["publications"]>();
  for (const p of publications) {
    const jobId = jobByArticle.get(p.article_id);
    if (!jobId) continue;
    const list = byJob.get(jobId) ?? [];
    list.push({ platform: p.platform, status: p.status as never, published_at: p.published_at, created_at: p.created_at });
    byJob.set(jobId, list);
  }
  // 이미지를 Pages로 옮긴 job(사용설명서)만 Blogspot이어도 정리 대상이다 - planStorageCleanup.ts 머리말.
  const rehosted = new Set<string>();
  const jobIds = [...byJob.keys()];
  for (let i = 0; i < jobIds.length; i += IN_CHUNK) {
    const { data, error } = await supabase
      .from("article_jobs")
      .select("id, rehostedAt:metadata->>imagesRehostedAt")
      .in("id", jobIds.slice(i, i + IN_CHUNK));
    if (error) throw error;
    for (const row of (data ?? []) as unknown as { id: string; rehostedAt: string | null }[]) if (row.rehostedAt) rehosted.add(row.id);
  }
  return [...byJob].map(([jobId, list]) => ({ jobId, publications: list, imagesRehosted: rehosted.has(jobId) }));
}

/** status=rejected인 job과 그 job의 발행 기록 수. 반려 시각은 metadata.rejectedAt(없으면 reviewedAt). */
export async function loadRejectedJobsFromDb(): Promise<RejectedJob[]> {
  const rows: { id: string; rejectedAt: string | null; reviewedAt: string | null }[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("article_jobs")
      .select("id, rejectedAt:metadata->>rejectedAt, reviewedAt:metadata->>reviewedAt")
      .eq("status", "rejected")
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    rows.push(...((data ?? []) as unknown as typeof rows));
    if (!data || data.length < PAGE) break;
  }

  const publicationCountByJob = new Map<string, number>();
  const jobIds = rows.map((row) => row.id);
  for (let i = 0; i < jobIds.length; i += IN_CHUNK) {
    const chunk = jobIds.slice(i, i + IN_CHUNK);
    const { data: articles, error } = await supabase.from("articles").select("id, job_id").in("job_id", chunk);
    if (error) throw error;
    const jobByArticle = new Map<number, string>();
    for (const article of articles ?? []) if (article.job_id) jobByArticle.set(article.id, article.job_id);
    const articleIds = [...jobByArticle.keys()];
    for (let j = 0; j < articleIds.length; j += IN_CHUNK) {
      const { data: publications, error: pubError } = await supabase
        .from("publications")
        .select("article_id")
        .in("article_id", articleIds.slice(j, j + IN_CHUNK));
      if (pubError) throw pubError;
      for (const publication of publications ?? []) {
        const jobId = jobByArticle.get(publication.article_id);
        if (jobId) publicationCountByJob.set(jobId, (publicationCountByJob.get(jobId) ?? 0) + 1);
      }
    }
  }
  return rows.map((row) => ({
    jobId: row.id,
    rejectedAt: row.rejectedAt ?? row.reviewedAt,
    publicationCount: publicationCountByJob.get(row.id) ?? 0,
  }));
}

export async function listObjectsFromStorage(jobId: string): Promise<StorageObject[]> {
  const objects: StorageObject[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabase.storage.from(ARTICLE_IMAGES_BUCKET).list(jobId, { limit: PAGE, offset });
    if (error) throw error;
    for (const entry of data ?? []) {
      // 폴더(하위 접두사)는 id가 없다 - 이미지는 `<jobId>/<파일>` 한 단계라 건너뛴다.
      if (!entry.id) continue;
      const size = Number((entry.metadata as { size?: unknown } | null)?.size ?? 0);
      objects.push({ name: entry.name, size: Number.isFinite(size) ? size : 0 });
    }
    if (!data || data.length < PAGE) break;
  }
  return objects;
}

async function removeObjectsFromStorage(paths: string[]): Promise<number> {
  let removed = 0;
  for (let i = 0; i < paths.length; i += REMOVE_CHUNK) {
    const { data, error } = await supabase.storage.from(ARTICLE_IMAGES_BUCKET).remove(paths.slice(i, i + REMOVE_CHUNK));
    if (error) throw error;
    removed += data?.length ?? 0;
  }
  return removed;
}

const defaultDeps: StorageCleanupDeps = {
  loadJobPublications: loadJobPublicationsFromDb,
  loadRejectedJobs: loadRejectedJobsFromDb,
  listObjects: listObjectsFromStorage,
  removeObjects: removeObjectsFromStorage,
};

export async function runStorageCleanup(
  options: { apply?: boolean; retentionDays?: number; rejectedRetentionDays?: number; now?: Date } = {},
  deps: StorageCleanupDeps = defaultDeps
): Promise<StorageCleanupResult> {
  const apply = options.apply === true;
  const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const rejectedRetentionDays = options.rejectedRetentionDays ?? DEFAULT_REJECTED_RETENTION_DAYS;
  const now = options.now ?? new Date();

  const jobs = await deps.loadJobPublications();
  const { candidates: publishedCandidates, skipped } = selectCleanupJobs(jobs, now, retentionDays);

  // 반려분: 발행 이력이 없는 rejected job의 이미지를 반려 후 N일 뒤에 지운다(PIPELINE-MERGE §4). 같은 job이 두 목록에 있을 수
  // 없지만(발행 이력이 있으면 반려분에서 빠진다) 방어적으로 중복을 거른다.
  const rejectedSkipped = { has_publication: 0, too_recent: 0, no_timestamp: 0 };
  let rejectedCandidates: typeof publishedCandidates = [];
  if (deps.loadRejectedJobs) {
    const selected = selectRejectedCleanupJobs(await deps.loadRejectedJobs(), now, rejectedRetentionDays);
    const taken = new Set(publishedCandidates.map((c) => c.jobId));
    rejectedCandidates = selected.candidates.filter((c) => !taken.has(c.jobId));
    for (const skip of selected.skipped) rejectedSkipped[skip.reason.replace("rejected_", "") as keyof typeof rejectedSkipped] += 1;
  }
  const candidates = [...publishedCandidates, ...rejectedCandidates];

  const objectsByJob = new Map<string, StorageObject[]>();
  for (const candidate of candidates) objectsByJob.set(candidate.jobId, await deps.listObjects(candidate.jobId));
  const plan = buildCleanupPlan(objectsByJob);

  let removed = 0;
  let failed = 0;
  if (apply && plan.paths.length > 0) {
    removed = await deps.removeObjects(plan.paths);
    failed = plan.paths.length - removed;
  }

  const skippedCounts: StorageCleanupResult["skipped"] = { blogspot_hotlink: 0, unknown_platform: 0, not_published: 0, too_recent: 0 };
  for (const skip of skipped) skippedCounts[skip.reason] += 1;
  return {
    apply,
    retentionDays,
    candidateJobs: candidates.length,
    rejectedCandidateJobs: rejectedCandidates.length,
    rejectedRetentionDays,
    skipped: skippedCounts,
    rejectedSkipped,
    plan,
    removed,
    failed,
  };
}

/** 텔레그램 보고 문구(HTML). dry-run은 "지우지 않았다"를 분명히 적는다. */
export function formatCleanupReport(result: StorageCleanupResult): string {
  const { plan, skipped } = result;
  const lines = [
    result.apply ? "🧹 <b>Storage 정리 완료</b>" : "🧹 <b>Storage 정리 - dry-run (지우지 않았습니다)</b>",
    "",
    `기준: 발행 후 ${result.retentionDays}일 경과` +
      (result.rejectedCandidateJobs > 0 || result.rejectedSkipped.too_recent > 0
        ? ` · 반려 후 ${result.rejectedRetentionDays}일 경과(발행 이력 없음) ${result.rejectedCandidateJobs}건`
        : "") +
      ` · 대상 원고 ${result.candidateJobs}건 (이미지 있는 것 ${plan.jobs}건)`,
    result.apply
      ? `삭제 ${result.removed}개 · ${formatBytes(plan.bytes)}${result.failed > 0 ? ` · ⚠️ 실패 ${result.failed}개` : ""}`
      : `삭제 예정 ${plan.paths.length}개 · ${formatBytes(plan.bytes)}`,
  ];
  const kept: string[] = [];
  if (skipped.blogspot_hotlink > 0) kept.push(`Blogspot 게시 ${skipped.blogspot_hotlink}건(이미지 직접 참조라 보존)`);
  if (skipped.unknown_platform > 0) kept.push(`발행처 불명 ${skipped.unknown_platform}건`);
  if (kept.length > 0) lines.push("", `보존: ${kept.join(" · ")}`);
  if (!result.apply && plan.paths.length > 0) lines.push("", "실삭제는 승인 후 <code>--apply</code>(또는 repo 변수 STORAGE_CLEANUP_APPLY=true)로 진행합니다.");
  return lines.join("\n");
}
