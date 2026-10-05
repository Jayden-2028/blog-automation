// Storage 정리 실행(개편2.5 D). 규칙은 planStorageCleanup.ts, 여기는 DB·Storage 입출력과 결과 보고다.
//
// **dry-run이 기본**이다 - 대상 목록·용량만 산출하고 아무것도 지우지 않는다. 실삭제는 `apply: true`(CLI의 `--apply`)일 때만.
// 읽기(publications·articles 조회, Storage 목록)는 dry-run에서도 한다.
import { ARTICLE_IMAGES_BUCKET } from "../../services/supabase/storage/uploadArticleImage.js";
import { supabase } from "../../services/supabase/client.js";
import { buildCleanupPlan, DEFAULT_RETENTION_DAYS, formatBytes, selectCleanupJobs } from "./planStorageCleanup.js";
import type { CleanupPlan, CleanupSkip, JobPublications, StorageObject } from "./planStorageCleanup.js";

export type StorageCleanupDeps = {
  loadJobPublications: () => Promise<JobPublications[]>;
  listObjects: (jobId: string) => Promise<StorageObject[]>;
  /** 객체를 지우고 실제로 지워진 개수를 돌려준다. */
  removeObjects: (paths: string[]) => Promise<number>;
};

export type StorageCleanupResult = {
  apply: boolean;
  retentionDays: number;
  candidateJobs: number;
  skipped: Record<CleanupSkip["reason"], number>;
  plan: CleanupPlan;
  /** apply일 때만 채워진다. */
  removed: number;
  /** 삭제에 실패한 객체 수(apply). */
  failed: number;
};

const PAGE = 1000;
const IN_CHUNK = 200;
const REMOVE_CHUNK = 100;

async function loadJobPublicationsFromDb(): Promise<JobPublications[]> {
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
  return [...byJob].map(([jobId, list]) => ({ jobId, publications: list }));
}

async function listObjectsFromStorage(jobId: string): Promise<StorageObject[]> {
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
  listObjects: listObjectsFromStorage,
  removeObjects: removeObjectsFromStorage,
};

export async function runStorageCleanup(
  options: { apply?: boolean; retentionDays?: number; now?: Date } = {},
  deps: StorageCleanupDeps = defaultDeps
): Promise<StorageCleanupResult> {
  const apply = options.apply === true;
  const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const now = options.now ?? new Date();

  const jobs = await deps.loadJobPublications();
  const { candidates, skipped } = selectCleanupJobs(jobs, now, retentionDays);

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
  return { apply, retentionDays, candidateJobs: candidates.length, skipped: skippedCounts, plan, removed, failed };
}

/** 텔레그램 보고 문구(HTML). dry-run은 "지우지 않았다"를 분명히 적는다. */
export function formatCleanupReport(result: StorageCleanupResult): string {
  const { plan, skipped } = result;
  const lines = [
    result.apply ? "🧹 <b>Storage 정리 완료</b>" : "🧹 <b>Storage 정리 - dry-run (지우지 않았습니다)</b>",
    "",
    `기준: 발행 후 ${result.retentionDays}일 경과 · 대상 원고 ${result.candidateJobs}건 (이미지 있는 것 ${plan.jobs}건)`,
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
