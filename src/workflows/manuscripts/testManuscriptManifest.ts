// manuscriptManifest.ts(Supabase manuscript_manifest_topics 백엔드) 실측 테스트. 실제 DB에 쓴다 -
// 이 테스트가 만든 job_id만 끝에 지운다(운영 데이터는 건드리지 않음).
//
// 핵심 검증 대상: 2026-09-14/15 사고(GitHub Actions처럼 매번 새로 시작하는 실행이 다른 실행이 만든
// row를 모른 채 saveManifest를 불러도, 그 row가 지워지지 않아야 한다) 재발 방지.

import { randomUUID } from "node:crypto";

import { supabase } from "../../services/supabase/client.js";
import { loadManifest, saveManifest, upsertTopicEntry } from "./manuscriptManifest.js";
import type { ManuscriptTopicEntry } from "./manuscriptManifest.js";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`❌ 검증 실패: ${message}`);
}

function makeTopic(jobId: string, keyword: string): ManuscriptTopicEntry {
  return {
    jobId,
    keyword,
    category: "test",
    date: "2099-01-01",
    readyAt: new Date().toISOString(),
    channels: [
      {
        channel: "tistory",
        title: keyword,
        searchDescription: null,
        slug: null,
        tags: [],
        body: "테스트 본문",
        imagePrompts: [],
        filePath: "manuscripts/2099-01-01/test/tistory.md",
      },
    ],
  };
}

async function main() {
  console.log("▶ manuscriptManifest(Supabase) 테스트 시작");

  const jobIdA = randomUUID();
  const jobIdB = randomUUID();
  const createdJobIds = [jobIdA, jobIdB];

  try {
    // 1. 프로세스 A가 topicA만 저장.
    await saveManifest({ topics: [makeTopic(jobIdA, `테스트 토픽 A ${jobIdA}`)] });
    const afterA = await loadManifest();
    assert(afterA.topics.some((t) => t.jobId === jobIdA), "topicA가 저장 직후 조회되지 않음");
    console.log("✅ saveManifest -> loadManifest 왕복(topicA)");

    // 2. 프로세스 B가 topicA의 존재를 전혀 모른 채(자기만 아는 manifest로) topicB만 저장한다 -
    //    GitHub Actions 러너가 빈 로컬 상태로 시작하는 상황과 동일하다. 이 저장이 topicA를 지우면
    //    안 된다(2026-09-14/15 사고의 핵심).
    await saveManifest({ topics: [makeTopic(jobIdB, `테스트 토픽 B ${jobIdB}`)] });
    const afterB = await loadManifest();
    assert(afterB.topics.some((t) => t.jobId === jobIdA), "다른 프로세스의 저장으로 topicA가 사라짐(회귀!)");
    assert(afterB.topics.some((t) => t.jobId === jobIdB), "topicB가 저장 직후 조회되지 않음");
    console.log("✅ 서로 다른 실행의 saveManifest가 서로의 topic을 지우지 않음");

    // 3. 같은 jobId로 다시 저장하면 새 행이 아니라 upsert(교체)여야 한다.
    const updatedTitle = `테스트 토픽 A 갱신 ${jobIdA}`;
    await saveManifest({ topics: [makeTopic(jobIdA, updatedTitle)] });
    const afterUpdate = await loadManifest();
    const matchingA = afterUpdate.topics.filter((t) => t.jobId === jobIdA);
    assert(matchingA.length === 1, `jobId 중복 없이 upsert돼야 함(실제 ${matchingA.length}건)`);
    assert(matchingA[0]!.keyword === updatedTitle, "upsert 후 keyword가 갱신되지 않음");
    console.log("✅ 같은 jobId 재저장 -> upsert(중복 행 생성 안 함)");

    // 4. upsertTopicEntry(순수 함수) 자체도 같은 계약을 지키는지 확인.
    const merged = upsertTopicEntry({ topics: [makeTopic(jobIdA, "old")] }, makeTopic(jobIdA, "new"));
    assert(merged.topics.length === 1 && merged.topics[0]!.keyword === "new", "upsertTopicEntry가 교체 대신 추가함");
    console.log("✅ upsertTopicEntry 순수 함수 계약");

    console.log("\n✅ 전체 통과");
  } finally {
    const { error } = await supabase.from("manuscript_manifest_topics").delete().in("job_id", createdJobIds);
    if (error) console.error("⚠️ 테스트 데이터 정리 실패(수동 확인 필요):", error.message, createdJobIds);
    else console.log("🧹 테스트 데이터 정리 완료:", createdJobIds);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
