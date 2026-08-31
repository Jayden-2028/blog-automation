// publishApprovedArticles fan-out 테스트. 채널 발행 함수를 주입해 오케스트레이션만 검증한다.
import { publishApprovedArticles } from "./publishApprovedArticles.js";
import { buildMultiPublishMessage } from "./notifyMultiPublish.js";
import type { ArticleJobRow } from "../../types/database.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

function job(id: string): ArticleJobRow {
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
    metadata: {},
    created_at: "x",
    updated_at: "x",
  } as ArticleJobRow;
}

const naverOk = async () => ({ ok: true as const, publicationId: 1, draftUrl: "https://naver/d", imageCount: 2, alreadyDone: false as const });
const blogspotPublished = async () => ({ ok: true as const, publicationId: 2, url: "https://blog/p", isDraft: false, variantCreated: true, alreadyDone: false });

async function main(): Promise<void> {
  console.log("▶ publishApprovedArticles 테스트 시작\n");

  // 1) naver + blogspot 둘 다 성공 -> job.status published로 이동
  const marks: string[] = [];
  const r1 = await publishApprovedArticles({
    loadApprovedJobs: async () => [job("a")],
    activeChannels: ["naver", "blogspot"],
    publishNaver: naverOk,
    publishBlogspot: blogspotPublished,
    markJobPublished: async (id) => marks.push(id),
  });
  assert(r1[0].channels.length === 2, "채널 2개 결과여야 한다");
  assert(r1[0].markedPublished === true && marks[0] === "a", "모두 성공 -> published 이동 실패");
  console.log("✅ 전 채널 성공 -> job published 이동");

  // 2) blogspot 실패 -> 채널 격리, job은 approved 유지(재시도)
  const marks2: string[] = [];
  const r2 = await publishApprovedArticles({
    loadApprovedJobs: async () => [job("b")],
    activeChannels: ["naver", "blogspot"],
    publishNaver: naverOk,
    publishBlogspot: async () => ({ ok: false as const, reason: "blogger_failed", detail: "quota", stage: "insert" }),
    markJobPublished: async (id) => marks2.push(id),
  });
  const naverOutcome = r2[0].channels.find((c) => c.channel === "naver");
  const blogspotOutcome = r2[0].channels.find((c) => c.channel === "blogspot");
  assert(naverOutcome?.status === "draft", "naver는 성공해야 한다(격리)");
  assert(blogspotOutcome?.status === "failed", "blogspot은 failed여야 한다");
  assert(r2[0].markedPublished === false && marks2.length === 0, "실패 채널 있으면 published로 안 넘어간다");
  console.log("✅ 한 채널 실패 -> 격리 + job approved 유지");

  // 3) blogspot 일일 상한 -> deferred, job approved 유지
  const r3 = await publishApprovedArticles({
    loadApprovedJobs: async () => [job("c")],
    activeChannels: ["naver", "blogspot"],
    publishNaver: naverOk,
    publishBlogspot: async () => ({ ok: false as const, reason: "daily_limit", detail: "상한 도달" }),
    markJobPublished: async () => {},
  });
  assert(r3[0].channels.find((c) => c.channel === "blogspot")?.status === "deferred", "상한 -> deferred");
  assert(r3[0].markedPublished === false, "deferred 있으면 published 안 됨");
  console.log("✅ 일일 상한 -> deferred + 재시도 대기");

  // 4) maxJobsPerRun 제한
  const r4 = await publishApprovedArticles({
    loadApprovedJobs: async () => [job("d"), job("e"), job("f"), job("g")],
    activeChannels: ["naver"],
    publishNaver: naverOk,
    maxJobsPerRun: 2,
    markJobPublished: async () => {},
  });
  assert(r4.length === 2, `maxJobsPerRun 제한 실패 (${r4.length})`);
  console.log("✅ maxJobsPerRun -> 한 번에 N건만");

  // 5) 알림 메시지: 성공 채널은 링크 버튼, 실패는 사유 텍스트
  const msg = buildMultiPublishMessage(r2[0]);
  assert(msg.text.includes("네이버: 📝 비공개(draft) 저장"), `네이버 상태 줄 실패 (${msg.text})`);
  assert(msg.text.includes("Blogspot: ⚠️ 실패 — quota"), `Blogspot 실패 줄 실패 (${msg.text})`);
  assert(msg.replyMarkup?.inline_keyboard.some((row) => row[0].text.includes("네이버")), "네이버 링크 버튼 실패");
  console.log("✅ 알림 메시지: 성공=링크버튼, 실패=사유텍스트");

  console.log("\n✅ 전체 테스트 통과");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
