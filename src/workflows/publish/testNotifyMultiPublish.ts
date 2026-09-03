// notifyMultiPublish 중복방지 테스트. 같은 job+채널+실패사유는 한 번만 알린다 - 실제
// Telegram/Supabase 호출 대신 sendMessages/mergeMetadata를 주입해 검증한다.
import { hasReportableChange, notifyMultiPublish } from "./notifyMultiPublish.js";
import type { JobPublishResult } from "./publishApprovedArticles.js";
import type { ArticleJobRow } from "../../types/database.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

function job(id: string, metadata: Record<string, unknown> = {}): ArticleJobRow {
  return {
    id,
    source_run_id: 1,
    source_rank: 1,
    keyword: `키워드 ${id}`,
    headline: null,
    seed_query: null,
    category: "living",
    total_score: 50,
    score_breakdown: null,
    status: "approved",
    selected_at: "x",
    selected_via: "telegram",
    metadata,
    created_at: "x",
    updated_at: "x",
  } as ArticleJobRow;
}

function result(j: ArticleJobRow, channels: JobPublishResult["channels"]): JobPublishResult {
  return { job: j, channels, markedPublished: false };
}

async function main(): Promise<void> {
  console.log("▶ notifyMultiPublish 중복방지 테스트 시작\n");

  // 1) 첫 실패 - 기록이 없으니 알려야 한다.
  const freshFail = result(job("a"), [{ channel: "blogspot", status: "failed", reason: "quota" }]);
  assert(hasReportableChange(freshFail), "첫 실패는 알려야 한다");
  console.log("✅ 첫 실패 -> reportable");

  // 2) 직전과 똑같은 사유로 다시 실패 - 조용히 넘어간다.
  const sameFail = result(job("b", { notifiedFailures: { blogspot: "quota" } }), [
    { channel: "blogspot", status: "failed", reason: "quota" },
  ]);
  assert(!hasReportableChange(sameFail), "같은 사유 반복 실패는 조용히 넘어가야 한다");
  console.log("✅ 같은 job+채널+사유 반복 -> 조용히 무시");

  // 3) 사유가 바뀐 실패 - 새 문제로 다시 알린다.
  const changedReasonFail = result(job("c", { notifiedFailures: { blogspot: "quota" } }), [
    { channel: "blogspot", status: "failed", reason: "network timeout" },
  ]);
  assert(hasReportableChange(changedReasonFail), "실패 사유가 바뀌면 새 문제로 알려야 한다");
  console.log("✅ 실패 사유 변경 -> 다시 reportable");

  // 4) 성공/draft는 기록과 무관하게 항상 알린다(URL 등 새 정보가 있으므로).
  const resolved = result(job("d", { notifiedFailures: { blogspot: "quota" } }), [
    { channel: "blogspot", status: "draft", url: "https://blog/p" },
  ]);
  assert(hasReportableChange(resolved), "실패가 draft로 해소되면 알려야 한다");
  console.log("✅ 실패 해소(draft) -> reportable");

  // 5) 전체 채널이 QUIET(already_done/skipped/deferred)면 조용히 넘어간다(기존 동작 유지).
  const allQuiet = result(job("e"), [
    { channel: "naver", status: "already_done", url: "https://n/x" },
    { channel: "tistory", status: "deferred", reason: "카카오 로그인 필요" },
  ]);
  assert(!hasReportableChange(allQuiet), "전부 QUIET면 조용히 넘어가야 한다");
  console.log("✅ 전부 already_done/skipped/deferred -> 조용히 무시(기존 동작 유지)");

  // 6) notifyMultiPublish 전체 흐름: 발송 + notifiedFailures 기록/해소가 실제로 일어나는지.
  const sent: unknown[] = [];
  const merged: Array<{ jobId: string; patch: Record<string, unknown> }> = [];
  const sendMessages = async (messages: unknown[]) => {
    sent.push(...messages);
  };
  const mergeMetadata = async (jobId: string, patch: Record<string, unknown>) => {
    merged.push({ jobId, patch });
  };

  // 6-1) 첫 실패 -> 메시지 발송 + notifiedFailures 기록.
  await notifyMultiPublish(
    [result(job("f"), [{ channel: "blogspot", status: "failed", reason: "quota" }])],
    { sendMessages, mergeMetadata }
  );
  assert(sent.length === 1, "첫 실패는 메시지를 보내야 한다");
  assert(merged.length === 1 && (merged[0].patch.notifiedFailures as Record<string, string>).blogspot === "quota", "실패 사유가 기록돼야 한다");
  console.log("✅ notifyMultiPublish: 첫 실패 -> 발송 + 기록");

  // 6-2) 같은 사유로 재실패 -> 발송도 기록도 없어야 한다.
  sent.length = 0;
  merged.length = 0;
  await notifyMultiPublish(
    [result(job("f", { notifiedFailures: { blogspot: "quota" } }), [{ channel: "blogspot", status: "failed", reason: "quota" }])],
    { sendMessages, mergeMetadata }
  );
  assert(sent.length === 0, "같은 사유 반복은 발송하면 안 된다");
  assert(merged.length === 0, "같은 사유 반복은 DB도 다시 쓰면 안 된다");
  console.log("✅ notifyMultiPublish: 같은 사유 반복 -> 발송·기록 둘 다 생략");

  // 6-3) 해소(draft) -> 발송 + notifiedFailures가 빈 객체로 정리.
  sent.length = 0;
  merged.length = 0;
  await notifyMultiPublish(
    [result(job("f", { notifiedFailures: { blogspot: "quota" } }), [{ channel: "blogspot", status: "draft", url: "https://blog/p" }])],
    { sendMessages, mergeMetadata }
  );
  assert(sent.length === 1, "해소되면 발송해야 한다");
  assert(merged.length === 1 && Object.keys(merged[0].patch.notifiedFailures as Record<string, string>).length === 0, "해소되면 기록이 비워져야 한다");
  console.log("✅ notifyMultiPublish: 실패 해소 -> 발송 + 기록 초기화");

  // 6-4) 초기화된 뒤 같은 사유로 다시 실패 -> 새 문제로 취급해 다시 발송.
  sent.length = 0;
  merged.length = 0;
  await notifyMultiPublish(
    [result(job("f", { notifiedFailures: {} }), [{ channel: "blogspot", status: "failed", reason: "quota" }])],
    { sendMessages, mergeMetadata }
  );
  assert(sent.length === 1, "해소 후 재발생은 새 문제로 다시 발송해야 한다");
  console.log("✅ notifyMultiPublish: 해소 후 재발생 -> 다시 발송");

  console.log("\n✅ 전체 테스트 통과");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
