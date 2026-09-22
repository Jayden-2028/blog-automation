// 발행하지 않을 미발행 job을 한 번에 종료 처리한다(status -> published, 대기열에서 뺀다).
//
// 왜 필요한가(2026-09-21 사용자 결정): 9월 초부터 쌓인 미발행 job이 72건이었다. 내일 파이프라인을
// 깨끗한 상태에서 검증하려면 이걸 치워야 하는데, closeJob.ts는 한 건씩이라 72번 돌려야 한다.
//
// **지우지 않는다.** 원고 뷰어(manuscript_manifest_topics)와 발행 기록(publications)은 그대로
// 둔다. 특히 publications는 서치콘솔 성과를 "이 URL이 어느 원고인지"로 묶는 연결고리라, 지우면
// 과거 글의 검색 성과를 원고와 맞출 수 없게 된다.
//
// closeJob.ts와 달리 **metadata를 보존**한다. 그쪽은 `metadata: {...}`로 통째로 덮어써서 이미지
// 목록 같은 것이 날아간다 - 대량으로 돌릴 때는 손실이 그만큼 커진다.
//
// ⚠️ 원격 DB write라 **기본이 dry-run**이다. `--confirm`을 붙여야 실제로 바꾼다
// (CLAUDE.md "승인 없이는 금지" - 원격 DB update).
//
// 사용법:
//   npx tsx scripts/closePendingJobs.ts                     대상만 출력(아무것도 안 바꿈)
//   npx tsx scripts/closePendingJobs.ts --confirm           실제 종료 처리
//   npx tsx scripts/closePendingJobs.ts --reason "사유"      종료 사유 지정
import "dotenv/config";

import { supabase } from "../src/services/supabase/client.js";

/** 종료 대상이 아닌 상태. 이미 끝난 job은 건드릴 것이 없다. */
const TERMINAL = ["published", "rejected", "closed"];

type JobRow = { id: string; keyword: string; status: string; created_at: string; metadata: Record<string, unknown> | null };

/** 실제로 발행된 job은 제외한다 - status만 안 바뀐 것뿐이라 기록을 건드릴 이유가 없다. */
async function publishedJobIds(jobIds: string[]): Promise<Set<string>> {
  const { data: articles, error: articleError } = await supabase
    .from("articles")
    .select("id,job_id")
    .in("job_id", jobIds);
  if (articleError) throw articleError;

  const articleToJob = new Map<number, string>();
  for (const row of articles ?? []) articleToJob.set(row.id as number, row.job_id as string);
  if (articleToJob.size === 0) return new Set();

  const { data: publications, error: publicationError } = await supabase
    .from("publications")
    .select("article_id,status")
    .in("article_id", [...articleToJob.keys()])
    .eq("status", "published");
  if (publicationError) throw publicationError;

  const published = new Set<string>();
  for (const row of publications ?? []) {
    const jobId = articleToJob.get(row.article_id as number);
    if (jobId) published.add(jobId);
  }
  return published;
}

async function main(): Promise<void> {
  const confirm = process.argv.includes("--confirm");
  const reasonIndex = process.argv.indexOf("--reason");
  const reason = reasonIndex >= 0 ? process.argv[reasonIndex + 1] : "발행하지 않기로 함(일괄 정리)";

  const { data, error } = await supabase
    .from("article_jobs")
    .select("id,keyword,status,created_at,metadata")
    .not("status", "in", `(${TERMINAL.join(",")})`)
    .order("created_at", { ascending: false });
  if (error) throw error;

  const pending = (data ?? []) as JobRow[];
  if (pending.length === 0) {
    console.log("대기 중인 job이 없습니다.");
    return;
  }

  // 진행 중인 job을 빼기 위한 장치. 정리 도중에 막 시작된 job까지 죽이면 안 된다
  // (2026-09-21 실측 - 정리 직전에 "김지원 밀라노 근황"이 selected로 새로 들어와 있었다).
  const excluded = new Set(
    process.argv.flatMap((arg, i) => (arg === "--exclude" ? [process.argv[i + 1]] : [])).filter(Boolean)
  );

  const published = await publishedJobIds(pending.map((j) => j.id));
  const targets = pending.filter((j) => !published.has(j.id) && !excluded.has(j.id));
  if (excluded.size > 0) console.log(`제외 지정: ${excluded.size}건\n`);

  console.log(`대기 상태 ${pending.length}건 중`);
  console.log(`  이미 발행됨(status만 안 바뀜): ${published.size}건 → 건드리지 않습니다`);
  console.log(`  종료 대상: ${targets.length}건\n`);

  const byStatus: Record<string, number> = {};
  for (const job of targets) byStatus[job.status] = (byStatus[job.status] ?? 0) + 1;
  console.log(`  상태별: ${Object.entries(byStatus).map(([k, v]) => `${k} ${v}`).join(" / ")}`);
  console.log(`  기간: ${targets[targets.length - 1]?.created_at.slice(0, 10)} ~ ${targets[0]?.created_at.slice(0, 10)}\n`);

  for (const job of targets) {
    console.log(`  ${job.created_at.slice(0, 10)}  ${job.status.padEnd(11)}  ${job.keyword}`);
  }

  if (!confirm) {
    console.log("\n아무것도 바꾸지 않았습니다. 실제로 종료하려면 --confirm을 붙이세요.");
    return;
  }

  console.log(`\n▶ 종료 처리 중(사유: ${reason})...`);
  const closedAt = new Date().toISOString();
  let done = 0;
  for (const job of targets) {
    // metadata를 통째로 덮어쓰지 않는다 - 이미지 목록 등 기존 내용을 살린 채 종료 표시만 더한다.
    const metadata = { ...(job.metadata ?? {}), closedReason: reason, closedAt };
    const { error: updateError } = await supabase
      .from("article_jobs")
      .update({ status: "published", metadata })
      .eq("id", job.id);
    if (updateError) {
      console.error(`  ❌ ${job.keyword}: ${updateError.message}`);
      continue;
    }
    done += 1;
  }
  console.log(`✅ ${done}/${targets.length}건 종료 처리했습니다.`);
  console.log("   원고 뷰어(manuscript_manifest_topics)와 발행 기록(publications)은 그대로입니다.");
}

main().catch((error) => {
  console.error("❌ 실패:", error instanceof Error ? error.message : error);
  process.exit(1);
});
