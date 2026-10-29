// 자동 발행 제외 판정 테스트. 실행: npm run test:manual-publish-only
import { isManualPublishOnly } from "./manualPublishOnly.js";
import { requestTistoryPublish } from "./tistoryPublishQueue.js";
import { publishApprovedArticles } from "./publishApprovedArticles.js";
import type { ArticleJobRow } from "../../types/database.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const job = (category: string | null) =>
  ({ id: "j", keyword: "k", category, status: "approved", metadata: {} }) as unknown as ArticleJobRow;

async function main(): Promise<void> {
  assert(isManualPublishOnly({ category: "person" }), "person은 수동 발행");
  for (const c of ["entertainment", "ott", "living", null]) assert(!isManualPublishOnly({ category: c }), `${c}는 대상 아님`);

  let merged = 0;
  const t = await requestTistoryPublish(job("person"), { mergeMetadata: async () => { merged += 1; return null; } });
  assert(!t.queued && merged === 0, "person은 티스토리 큐에 넣지 않는다");

  let called = 0;
  const results = await publishApprovedArticles({
    loadApprovedJobs: async () => [job("person")],
    publishNaver: async () => { called += 1; throw new Error("호출되면 안 된다"); },
    publishBlogspot: async () => { called += 1; throw new Error("호출되면 안 된다"); },
    markJobPublished: async () => { called += 1; return null as never; },
    preflight: async () => null,
    activeChannels: ["naver"],
  });
  assert(called === 0 && results[0].channels[0].status === "skipped" && !results[0].markedPublished, "person은 일괄 발행에서 건너뛴다");

  console.log("✅ 자동 발행 제외 - 판정·티스토리 큐·일괄 발행");

  // 🌏 국제(변환기 → kscene, 2026-10-29): 뷰어 복붙 전용이 아니다 - 사용설명서 트랙처럼 🔵 Blogger 발행 버튼이 붙는다.
  assert(!isManualPublishOnly({ category: "kscene", metadata: { source: "keyword_input", track: "kscene" } }), "국제(변환기 kscene)는 발행 버튼 유지");
  assert(!isManualPublishOnly({ category: "kscene", metadata: { track: "kscene" } }), "kscene-topic Go job도 그대로");
  console.log("✅ kscene(국제 포함)은 자동 발행 제외 대상이 아니다");
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
