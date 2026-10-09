// write 마무리 분기 테스트(PIPELINE-MERGE-2026-10.md §1-a, §7): 성공·write 실패·건너뜀·게이트 false 복귀·발화 실패.
// 실행: npm run test:finish-write
import { autoApproveDraft } from "./autoApproveDraft.js";
import { finishWrite } from "./finishWrite.js";
import type { RunWritingStageResult } from "./runArticleJob.js";
import type { ArticleJobRow } from "../../types/database.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const JOB_ID = "054bfe0b-5cf7-4386-941f-810146c25e12";
const job = { id: JOB_ID, keyword: "테스트 키워드", metadata: { requiresMedicalReview: true } } as unknown as ArticleJobRow;
const success = {
  status: "success",
  job,
  article: { id: 42, title: "제목", content: "본문" },
  sources: [],
  isMedical: true,
  durationMs: 1000,
} as unknown as RunWritingStageResult;

type Log = string[];
function makeDeps(log: Log, opts: { skip: boolean; dispatchOk?: boolean }) {
  return {
    skipDraftReview: () => opts.skip,
    autoApprove: (target: { jobId: string; articleId: number }) =>
      autoApproveDraft(target, {
        mergeJobMetadata: async (id, patch) => void log.push(`merge:${id}:${Object.keys(patch).sort().join(",")}`),
        updateJobStatus: async (id, status) => void log.push(`jobStatus:${id}:${status}`),
        updateArticleStatus: async (id, status) => void log.push(`articleStatus:${id}:${status}`),
        dispatchPrepare: async () => {
          log.push("dispatch:job-publish-prepare");
          if (opts.dispatchOk === false) throw new Error("403 Resource not accessible");
        },
        now: () => new Date("2026-10-08T00:00:00Z"),
      }),
    notifyDraft: async () => void log.push("notifyDraft"),
    notifyFailure: async (_job: unknown, error: string) => void log.push(`notifyFailure:${error}`),
    findJob: async () => job,
    sendWarning: async (_job: ArticleJobRow, text: string) => void log.push(`warn:${text.includes("job-publish-prepare")}`),
  };
}

// 1) 성공 + 게이트 켜짐: 자동 승인 -> 준비 발화. 초안 알림은 없다.
{
  const log: Log = [];
  const out = await finishWrite(JOB_ID, success, makeDeps(log, { skip: true }));
  assert(out.path === "auto_approved" && out.exitCode === 0, `자동 승인 경로여야 한다 (${out.path})`);
  assert(!log.includes("notifyDraft"), "초안 승인 알림은 폐지");
  const order = log.map((l) => l.split(":")[0]);
  assert(order.join() === "merge,jobStatus,articleStatus,dispatch", `메타 -> job approved -> article approved -> 발화 순서여야 한다 (${order})`);
  assert(log[0].includes("autoApprovedAt") && log[0].includes("reviewDecision"), "autoApprovedAt으로 수동 승인과 구분한다");
  assert(log.includes(`jobStatus:${JOB_ID}:approved`) && log.includes("articleStatus:42:approved"), "승인 상태 전이");
  console.log("✅ write 성공 + 게이트 켜짐 -> 자동 승인 + prepare 발화, 초안 알림 없음");
}

// 2) 성공 + 게이트 꺼짐: 옛 흐름으로 복귀 - 초안 알림만, 상태 전이·발화 없음.
{
  const log: Log = [];
  const out = await finishWrite(JOB_ID, success, makeDeps(log, { skip: false }));
  assert(out.path === "legacy_review" && out.exitCode === 0, "게이트 false면 옛 흐름");
  assert(log.join() === "notifyDraft", `초안 알림만 보내야 한다 (${log})`);
  console.log("✅ 게이트 false -> 초안 알림(옛 흐름), 자동 승인·발화 없음");
}

// 3) write 실패: 실패 알림 + 비정상 종료. 자동 승인·발화는 절대 없다.
{
  const log: Log = [];
  const out = await finishWrite(JOB_ID, { status: "failed", error: "blocked: 자료 부족" } as RunWritingStageResult, makeDeps(log, { skip: true }));
  assert(out.path === "failed" && out.exitCode === 1, "실패는 exit 1");
  assert(log.length === 1 && log[0].startsWith("notifyFailure:blocked"), `실패 알림만 (${log})`);
  console.log("✅ write 실패 -> 실패 알림만, 자동 승인 없음");
}

// 4) 건너뜀(이미 처리된 job): 아무것도 하지 않는다.
{
  const log: Log = [];
  const out = await finishWrite(JOB_ID, { status: "skipped", reason: "이미 처리된 job입니다" } as RunWritingStageResult, makeDeps(log, { skip: true }));
  assert(out.path === "skipped" && out.exitCode === 0 && log.length === 0, "건너뜀은 부작용 없음");
  console.log("✅ skipped -> 부작용 없음");
}

// 5) 준비 발화 실패: 원고는 승인됐고(잃지 않음) 사용자에게 경고, exit 1.
{
  const log: Log = [];
  const out = await finishWrite(JOB_ID, success, makeDeps(log, { skip: true, dispatchOk: false }));
  assert(out.path === "auto_approved_dispatch_failed" && out.exitCode === 1, "발화 실패 경로");
  assert(log.includes(`jobStatus:${JOB_ID}:approved`), "발화가 실패해도 승인 상태는 남는다(원고를 잃지 않는다)");
  assert(log.includes("warn:true"), "사람에게 수동 실행 안내를 보낸다");
  assert(!log.includes("notifyDraft"), "발화 실패에도 초안 알림으로 폴백하지 않는다");
  console.log("✅ prepare 발화 실패 -> 승인 유지 + 경고 알림");
}

// 6) 의학 주제는 자동 승인이 교차확인 플래그를 내리지 않는다(patch에 requiresMedicalReview가 없다).
{
  const log: Log = [];
  await finishWrite(JOB_ID, success, makeDeps(log, { skip: true }));
  assert(!log[0].includes("requiresMedicalReview"), "자동 승인은 requiresMedicalReview를 건드리지 않는다");
  console.log("✅ 의학 주제 - 교차확인 플래그 유지");
}
console.log("\n✅ testFinishWrite 전체 통과");
