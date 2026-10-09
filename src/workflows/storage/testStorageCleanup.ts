// Storage 정리 테스트(planStorageCleanup·runStorageCleanup). DB·Storage 없이 돈다. 실행: npm run test:storage-cleanup
import { buildCleanupPlan, selectCleanupJobs } from "./planStorageCleanup.js";
import type { JobPublications } from "./planStorageCleanup.js";
import { formatCleanupReport, runStorageCleanup } from "./runStorageCleanup.js";
import type { StorageCleanupDeps } from "./runStorageCleanup.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const NOW = new Date("2026-10-20T00:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const pub = (platform: string | null, status: string, ago: number) => ({ platform, status: status as never, published_at: daysAgo(ago), created_at: daysAgo(ago) });

const jobs: JobPublications[] = [
  { jobId: "old-naver", publications: [pub("naver", "published", 20)] },
  { jobId: "old-tistory", publications: [pub("tistory", "published", 15)] },
  { jobId: "recent", publications: [pub("naver", "published", 13)] },
  { jobId: "blogspot", publications: [pub("blogspot", "published", 40)] },
  { jobId: "both", publications: [pub("naver", "published", 40), pub("blogspot", "published", 40)] },
  { jobId: "failed-only", publications: [pub("naver", "failed", 40)] },
  { jobId: "in-progress", publications: [pub("naver", "published", 40), pub("tistory", "publishing", 1)] },
  { jobId: "legacy-null", publications: [pub(null, "published", 40)] },
  { jobId: "two-channels-late", publications: [pub("naver", "published", 40), pub("tistory", "published", 5)] },
];

const { candidates, skipped } = selectCleanupJobs(jobs, NOW, 14);
assert(candidates.map((c) => c.jobId).join() === "old-naver,old-tistory", `대상은 14일 지난 네이버·티스토리 발행뿐 (${candidates.map((c) => c.jobId)})`);
const why = Object.fromEntries(skipped.map((s) => [s.jobId, s.reason]));
assert(why["recent"] === "too_recent", "13일 된 건 제외");
assert(why["blogspot"] === "blogspot_hotlink" && why["both"] === "blogspot_hotlink", "Blogspot 흔적이 있으면 보존(이미지 직접 참조)");
assert(why["failed-only"] === "not_published", "실패만 있는 job은 대상이 아니다");
assert(why["in-progress"] === "too_recent", "진행 중 기록이 섞이면 보존");
assert(why["legacy-null"] === "unknown_platform", "플랫폼 불명은 보존");
assert(why["two-channels-late"] === "too_recent", "두 채널이면 늦게 나간 쪽 기준");
console.log("✅ 대상 선정 규칙 / 보존 사유");

// 사용설명서(개편3): 이미지를 Pages로 옮긴 Blogspot job은 Supabase 원본이 참조되지 않으므로 정리 대상이다.
{
  const rehostedJobs: JobPublications[] = [
    { jobId: "k-old", imagesRehosted: true, publications: [pub("blogspot", "published", 20)] },
    { jobId: "k-recent", imagesRehosted: true, publications: [pub("blogspot", "published", 5)] },
    { jobId: "k-draft", imagesRehosted: true, publications: [pub("blogspot", "pending", 30)] },
    { jobId: "k-unmarked", publications: [pub("blogspot", "published", 40)] },
    { jobId: "k-false", imagesRehosted: false, publications: [pub("blogspot", "published", 40)] },
    { jobId: "k-null-platform", imagesRehosted: true, publications: [pub(null, "published", 40)] },
  ];
  const result = selectCleanupJobs(rehostedJobs, NOW, 14);
  assert(result.candidates.map((c) => c.jobId).join() === "k-old", `이미지를 옮긴 Blogspot 게시만 대상 (${result.candidates.map((c) => c.jobId)})`);
  const reasons = Object.fromEntries(result.skipped.map((x) => [x.jobId, x.reason]));
  assert(reasons["k-recent"] === "too_recent" && reasons["k-draft"] === "not_published", "옮겼어도 기간·발행 완료 규칙은 그대로");
  assert(reasons["k-unmarked"] === "blogspot_hotlink" && reasons["k-false"] === "blogspot_hotlink", "표식이 없거나 false면 기존대로 보존(whynowissue 옛 글)");
  assert(reasons["k-null-platform"] === "unknown_platform", "옮겼어도 플랫폼 불명은 보존");
  console.log("✅ Pages로 이미지를 옮긴 사용설명서 글은 정리 대상(옛 Blogspot 글은 계속 보존)");
}

const plan = buildCleanupPlan(new Map([
  ["old-naver", [{ name: "1.webp", size: 1000 }, { name: "2.png", size: 3000 }]],
  ["old-tistory", []],
]));
assert(plan.paths.join() === "old-naver/1.webp,old-naver/2.png" && plan.bytes === 4000 && plan.jobs === 1 && plan.emptyJobs === 1, "경로·용량·빈 job 집계");
console.log("✅ 삭제 계획 산출");

async function main(): Promise<void> {
  const removed: string[][] = [];
  const removeCalls = (): number => removed.length; // assert의 타입 좁힘이 closure 안의 push를 못 봐서 함수로 읽는다.
  const deps: StorageCleanupDeps = {
    loadJobPublications: async () => jobs,
    listObjects: async (jobId) => (jobId === "old-naver" ? [{ name: "1.webp", size: 2_097_152 }] : [{ name: "a.png", size: 1024 }]),
    removeObjects: async (paths) => { removed.push(paths); return paths.length; },
  };

  // dry-run(기본): 지우지 않는다
  const dry = await runStorageCleanup({ now: NOW }, deps);
  assert(!dry.apply && removeCalls() === 0, "dry-run은 removeObjects를 부르지 않는다");
  assert(dry.plan.paths.length === 2 && dry.candidateJobs === 2 && dry.removed === 0, "dry-run 산출");
  const report = formatCleanupReport(dry);
  assert(report.includes("dry-run") && report.includes("지우지 않았습니다") && report.includes("--apply"), "dry-run 보고에 미삭제·승인 안내");
  assert(report.includes("Blogspot 게시 2건"), "보존 건수 보고");

  // apply
  const applied = await runStorageCleanup({ apply: true, now: NOW }, deps);
  assert(applied.apply && removeCalls() === 1 && removed[0].length === 2 && applied.removed === 2 && applied.failed === 0, "apply만 지운다");
  assert(formatCleanupReport(applied).includes("삭제 2개"), "apply 보고");

  // 일부만 지워졌으면 실패로 센다
  const partial = await runStorageCleanup({ apply: true, now: NOW }, { ...deps, removeObjects: async (paths) => paths.length - 1 });
  assert(partial.failed === 1 && formatCleanupReport(partial).includes("실패 1개"), "부분 실패 집계");
  console.log("✅ dry-run 기본 / apply만 삭제 / 보고 문구");
  console.log("\n✅ testStorageCleanup 전체 통과");
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

// ---- 반려분(PIPELINE-MERGE-2026-10.md §4): 발행 이력 없는 rejected job을 반려 후 7일 뒤 지운다 ----
{
  const { selectRejectedCleanupJobs } = await import("./planStorageCleanup.js");
  const rejected = [
    { jobId: "rej-old", rejectedAt: daysAgo(8), publicationCount: 0 },
    { jobId: "rej-edge", rejectedAt: daysAgo(7), publicationCount: 0 },
    { jobId: "rej-recent", rejectedAt: daysAgo(3), publicationCount: 0 },
    { jobId: "rej-published", rejectedAt: daysAgo(30), publicationCount: 1 },
    { jobId: "rej-unknown", rejectedAt: null, publicationCount: 0 },
  ];
  const sel = selectRejectedCleanupJobs(rejected, NOW, 7);
  assert(sel.candidates.map((c) => c.jobId).join() === "rej-old,rej-edge", `7일 지난 무발행 반려분만 (${sel.candidates.map((c) => c.jobId)})`);
  const why2 = Object.fromEntries(sel.skipped.map((s) => [s.jobId, s.reason]));
  assert(why2["rej-recent"] === "rejected_too_recent", "7일 안에는 유예(마음을 바꿀 수 있다)");
  assert(why2["rej-published"] === "rejected_has_publication", "발행 이력이 있으면 몇 년이 지나도 보존");
  assert(why2["rej-unknown"] === "rejected_no_timestamp", "반려 시각을 모르면 추측으로 지우지 않는다");
  console.log("✅ 반려분 선정 규칙 - 7일·발행 이력·시각 불명");

  // 실행기: 발행분 + 반려분이 한 계획에 합쳐지고 dry-run 기본이라 아무것도 지우지 않는다.
  const removedPaths: string[] = [];
  const deps: StorageCleanupDeps = {
    loadJobPublications: async () => [{ jobId: "old-naver", publications: [pub("naver", "published", 20)] }],
    loadRejectedJobs: async () => rejected,
    listObjects: async () => [{ name: "1.png", size: 1000 }, { name: "2.png", size: 500 }],
    removeObjects: async (paths) => (removedPaths.push(...paths), paths.length),
  };
  const dry = await runStorageCleanup({ now: NOW }, deps);
  assert(dry.rejectedCandidateJobs === 2 && dry.candidateJobs === 3, `발행 1 + 반려 2 = 대상 3건 (${dry.candidateJobs}/${dry.rejectedCandidateJobs})`);
  assert(dry.plan.paths.includes("rej-old/1.png") && dry.plan.paths.includes("old-naver/2.png"), "두 종류 모두 계획에 들어간다");
  assert(removedPaths.length === 0 && dry.removed === 0, "dry-run 기본 - 아무것도 지우지 않는다");
  assert(dry.rejectedSkipped.too_recent === 1 && dry.rejectedSkipped.has_publication === 1 && dry.rejectedSkipped.no_timestamp === 1, "보존 사유 집계");
  assert(formatCleanupReport(dry).includes("반려 후 7일"), "보고에 반려 기준이 보인다");
  const applied = await runStorageCleanup({ now: NOW, apply: true }, deps);
  assert(applied.removed === applied.plan.paths.length && removedPaths.includes("rej-edge/2.png"), "--apply일 때만 지운다");

  // loadRejectedJobs를 안 주면(옛 호출부) 반려분은 건드리지 않는다.
  const legacy = await runStorageCleanup({ now: NOW }, { ...deps, loadRejectedJobs: undefined });
  assert(legacy.rejectedCandidateJobs === 0 && legacy.candidateJobs === 1, "옛 호출부는 동작 불변");
  console.log("✅ 반려분 정리 - dry-run 기본, apply에서만 삭제, 옛 호출부 불변");
}
