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

const noPreflight = async () => null;

async function main(): Promise<void> {
  console.log("▶ publishApprovedArticles 테스트 시작\n");

  // 1) naver + blogspot 둘 다 성공 -> job.status published로 이동
  const marks: string[] = [];
  const r1 = await publishApprovedArticles({
    loadApprovedJobs: async () => [job("a")],
    activeChannels: ["naver", "blogspot"],
    preflight: noPreflight,
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
    preflight: noPreflight,
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
    preflight: noPreflight,
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
    preflight: noPreflight,
    publishNaver: naverOk,
    maxJobsPerRun: 2,
    markJobPublished: async () => {},
  });
  assert(r4.length === 2, `maxJobsPerRun 제한 실패 (${r4.length})`);
  console.log("✅ maxJobsPerRun -> 한 번에 N건만");

  // 5) 알림 메시지: 성공 채널은 링크 버튼, 실패는 사유 텍스트(사람이 읽기 쉬운 짧은 문구로 정규화됨)
  const msg = buildMultiPublishMessage(r2[0]);
  assert(msg.text.includes("네이버: 📝 임시저장 완료"), `네이버 상태 줄 실패 (${msg.text})`);
  assert(msg.text.includes("Blogspot: ⚠️ 실패 — 일일 한도 초과"), `Blogspot 실패 줄 실패 (${msg.text})`);
  assert(msg.replyMarkup?.inline_keyboard.some((row) => row[0].text.includes("네이버")), "네이버 링크 버튼 실패");
  console.log("✅ 알림 메시지: 성공=링크버튼, 실패=사유텍스트(간결한 한글 문구)");

  // 6) preflight가 사유를 반환하면 job 전체를 건너뛴다(채널 발행 함수 호출 없음).
  let naverCalled = 0;
  const r6 = await publishApprovedArticles({
    loadApprovedJobs: async () => [job("h")],
    activeChannels: ["naver", "blogspot"],
    preflight: async () => "본문에 placeholder 참조 - 수동 정리 필요",
    publishNaver: async () => {
      naverCalled++;
      return naverOk();
    },
    publishBlogspot: blogspotPublished,
    markJobPublished: async () => {},
  });
  assert(naverCalled === 0, "preflight가 막으면 채널 발행을 호출하면 안 된다");
  assert(r6[0].channels.every((c) => c.status === "deferred"), "모든 채널이 deferred여야 한다");
  assert(r6[0].markedPublished === false, "deferred job은 published로 안 넘어간다");
  console.log("✅ preflight 차단 -> 전 채널 deferred, 발행 호출 없음");

  // 7) naver+blogspot 둘 다 draft/already면 published 이동.
  //    (2026-09-15 티스토리 제거 - 예전엔 여기서 티스토리 임시저장도 함께 확인했다)
  const marks7: string[] = [];
  const r7 = await publishApprovedArticles({
    loadApprovedJobs: async () => [job("i")],
    activeChannels: ["naver", "blogspot"],
    preflight: noPreflight,
    publishNaver: naverOk,
    publishBlogspot: blogspotPublished,
    markJobPublished: async (id) => marks7.push(id),
  });
  assert(r7[0].channels.find((c) => c.channel === "blogspot")?.status === "published", "blogspot -> published");
  assert(r7[0].markedPublished === true && marks7[0] === "i", "전 채널 처리 완료 -> published 이동");
  console.log("✅ 전 채널 처리 완료 시 published 이동");

  // 8) 실패 사유 정규화: Playwright 콜 로그가 섞인 원문도 짧은 한글 문구로 바뀌어야 한다.
  //    (2026-09-04 사용자 요청 - 네이버 제목 클릭 타임아웃 원문이 폰 화면에서 못 알아볼 정도로 길었다)
  const naverTimeoutMsg = buildMultiPublishMessage({
    job: job("j"),
    markedPublished: false,
    channels: [
      {
        channel: "naver",
        status: "failed",
        reason:
          '[title] page.click: Timeout 10000ms exceeded.\nCall log:\n  - waiting for locator(\'.se-component.se-documentTitle .se-text-paragraph\')\n    - locator resolved to <p id="SE-d66afbaa-4739-4da5-822a-c93b">',
      },
      { channel: "blogspot", status: "failed", reason: "[login] NAVER 로그인이 필요합니다(세션 만료 또는 미로그인)." },
    ],
  });
  assert(naverTimeoutMsg.text.includes("🟢 네이버: ⚠️ 실패 — 응답 대기 시간 초과"), `타임아웃 정규화 실패 (${naverTimeoutMsg.text})`);
  assert(naverTimeoutMsg.text.includes("🔵 Blogspot: ⚠️ 실패 — 로그인 실패"), `로그인 정규화 실패 (${naverTimeoutMsg.text})`);
  assert(!naverTimeoutMsg.text.includes("Call log"), "Playwright 콜 로그 원문이 남아있으면 안 된다");
  console.log("✅ 실패 사유 정규화: 타임아웃/로그인 -> 짧은 한글 문구 + 채널 아이콘");

  // 9) 분류에 안 걸리는 낯선 에러도 콜 로그 없이 짧게 잘려서 나온다(폴백 경로).
  const fallbackMsg = buildMultiPublishMessage({
    job: job("k"),
    markedPublished: false,
    channels: [{ channel: "blogspot", status: "failed", reason: `[insert] ${"가".repeat(100)}` }],
  });
  assert(fallbackMsg.text.includes("…"), "긴 미분류 사유는 말줄임표로 잘려야 한다");
  assert(!fallbackMsg.text.includes("[insert]"), "스테이지 접두사는 폴백에서도 제거돼야 한다");
  console.log("✅ 미분류 실패 사유 -> 스테이지 접두사 제거 + 짧게 자름(폴백)");

  console.log("\n✅ 전체 테스트 통과");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
