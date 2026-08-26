import { MockKeywordProvider } from "../../services/search/providers/MockKeywordProvider.js";
import { runKeywordDiscovery } from "./runKeywordDiscovery.js";

async function main() {
  console.log("▶ Keyword Discovery 테스트 시작 (MockKeywordProvider)");

  const provider = new MockKeywordProvider();
  const summary = await runKeywordDiscovery(provider);

  console.log("\n▶ 결과 summary");
  console.log(`Fetched: ${summary.fetched}`);
  console.log(`Normalized: ${summary.normalized}`);
  console.log(`Duplicate in batch: ${summary.duplicateInBatch}`);
  console.log(`Existing in DB: ${summary.existingInDb}`);
  console.log(`Inserted: ${summary.inserted}`);

  if (summary.insertedKeywords.length > 0) {
    console.log("\n▶ 신규 저장된 keyword");
    for (const row of summary.insertedKeywords) {
      console.log(`- [${row.id}] ${row.keyword} (${row.status})`);
    }
  }

  console.log("\n✅ Keyword Discovery 테스트 완료");
}

main().catch((error) => {
  console.error("❌ keyword discovery 테스트 실패:", error.message ?? error);
  process.exit(1);
});
