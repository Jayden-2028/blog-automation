import { MockKeywordProvider } from "../../services/search/providers/MockKeywordProvider.js";
import { runKeywordDiscovery } from "./runKeywordDiscovery.js";

async function main() {
  console.log("▶ Keyword Discovery 테스트 시작 (MockKeywordProvider, DB 저장 안 함)");

  const provider = new MockKeywordProvider();
  const summary = await runKeywordDiscovery(provider, { persistCandidates: false });

  if (!summary.persistenceSkipped) {
    throw new Error("테스트에서 Supabase 저장이 비활성화되지 않았습니다.");
  }
  if (summary.fetched !== 6 || summary.normalized !== 6 || summary.duplicateInBatch !== 1) {
    throw new Error(`예상하지 못한 summary: ${JSON.stringify(summary)}`);
  }

  console.log("\n▶ 결과 summary");
  console.log(`Fetched: ${summary.fetched}`);
  console.log(`Normalized: ${summary.normalized}`);
  console.log(`Duplicate in batch: ${summary.duplicateInBatch}`);
  console.log("Supabase persistence: skipped");

  console.log("\n✅ Keyword Discovery 테스트 완료");
}

main().catch((error) => {
  console.error("❌ keyword discovery 테스트 실패:", error.message ?? error);
  process.exit(1);
});
