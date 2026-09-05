// prepareChannelManuscripts / prepareApprovedManuscripts 테스트. LLM(generateVariant)·Supabase·
// 파일시스템을 전부 주입해 오케스트레이션과 멱등성만 검증한다. 외부 API·DB 호출 없음.
import { prepareChannelManuscripts } from "./prepareChannelManuscripts.js";
import { prepareApprovedManuscripts } from "./prepareApprovedManuscripts.js";
import type { ArticleJobRow, ArticleRow } from "../../types/database.js";
import type { ManuscriptManifest } from "./manuscriptManifest.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

function job(id: string, metadata: Record<string, unknown> = {}): ArticleJobRow {
  return {
    id,
    source_run_id: 1,
    source_rank: 1,
    keyword: `테스트 키워드 ${id}`,
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

function baseArticle(content = "기준 원고 본문입니다."): ArticleRow {
  return {
    id: 1,
    keyword_id: null,
    job_id: "a",
    title: "기준 제목",
    content,
    status: "approved",
    ai_model: "claude",
    platform: null,
    created_at: "x",
    updated_at: "x",
  } as ArticleRow;
}

function variantArticle(id: number, platform: string): ArticleRow {
  return {
    id,
    keyword_id: null,
    job_id: "a",
    title: `${platform} 기존 제목`,
    content: `${platform} 기존 본문`,
    status: "approved",
    ai_model: "claude",
    platform,
    created_at: "x",
    updated_at: "x",
  } as ArticleRow;
}

const okVariant = (channel: string) => async () => ({
  status: "success" as const,
  durationMs: 1,
  variant: {
    title: `${channel} 제목`,
    searchDescription: `${channel} 설명`,
    slug: channel === "blogspot" ? "channel-slug" : null,
    tags: ["태그1", "태그2"],
    // 실제 파이프라인 모양: 배리에이션도 [IMAGE: 설명] 단독 줄만 남긴다(프롬프트는
    // job.metadata.imagePrompts에 별도 보관 - parseManuscriptBlocks 테스트 참고).
    body: `${channel} 본문\n[IMAGE: 설명 — 웹 검색]\n계속 본문`,
  },
});

async function main(): Promise<void> {
  console.log("▶ prepareChannelManuscripts / prepareApprovedManuscripts 테스트 시작\n");

  // 1) 기준 원고 없음 -> 실패
  const noBase = await prepareChannelManuscripts(job("a"), {
    loadArticles: async () => [],
  });
  assert(noBase.status === "failed" && noBase.reason.includes("기준 원고"), "기준 원고 없음 처리 실패");
  console.log("✅ 기준 원고 없음 -> 실패");

  // 2) 신규 생성: 티스토리·블로거 배리에이션 생성 + 파일 3개 기록 + job.metadata.imagePrompts가
  // 채널 3개 모두에 그대로 전달되는지 확인(parseDraftFile.ts가 본문에서 빼낸 프롬프트를
  // 여기서 다시 붙여야 이미지 카드에 프롬프트가 뜬다 - 2026-09-05 실측에서 빠뜨렸던 부분).
  let generateCalls: string[] = [];
  let createCalls: string[] = [];
  const writes: Record<string, string> = {};
  const r2 = await prepareChannelManuscripts(job("a", { imagePrompts: ["이미지 프롬프트 A"] }), {
    loadArticles: async () => [baseArticle()],
    generateVariant: async (input) => {
      generateCalls.push(input.channel);
      return okVariant(input.channel)();
    },
    createVariantArticle: async ({ channel, title }) => {
      createCalls.push(channel);
      return variantArticle(99, channel);
    },
    writeManuscriptFile: async (path, content) => {
      writes[path] = content;
    },
  });
  assert(r2.status === "success", "신규 생성 실패");
  if (r2.status === "success") {
    assert(r2.topic.channels.length === 3, `채널 3개여야 한다 (${r2.topic.channels.length})`);
    assert(r2.topic.channels[0].channel === "naver" && r2.topic.channels[0].body === "기준 원고 본문입니다.", "네이버 채널은 기준 원고 그대로여야 한다");
    assert(
      r2.topic.channels.every((c) => c.imagePrompts.length === 1 && c.imagePrompts[0] === "이미지 프롬프트 A"),
      "job.metadata.imagePrompts가 채널 3개 모두에 전달돼야 한다"
    );
    const tistory = r2.topic.channels.find((c) => c.channel === "tistory")!;
    assert(tistory.title === "tistory 제목" && tistory.tags.length === 2, "티스토리 배리에이션 반영 실패");
    const blogspot = r2.topic.channels.find((c) => c.channel === "blogspot")!;
    assert(blogspot.slug === "channel-slug", "블로거 슬러그 반영 실패");
  }
  assert(generateCalls.sort().join(",") === "blogspot,tistory", `배리에이션은 tistory/blogspot만 생성 (${generateCalls})`);
  assert(createCalls.length === 2, "DB 배리에이션 저장 2회여야 한다");
  assert(Object.keys(writes).length === 3, `파일 3개 기록 (${Object.keys(writes).length})`);
  console.log("✅ 신규 생성 - 네이버=기준 원고, 티스토리·블로거=배리에이션 3개 파일 기록");

  // 3) 기존 배리에이션 재사용 -> generateVariant 재호출 안 함(LLM 비용 절약)
  generateCalls = [];
  createCalls = [];
  const r3 = await prepareChannelManuscripts(job("a"), {
    loadArticles: async () => [baseArticle(), variantArticle(2, "tistory"), variantArticle(3, "blogspot")],
    generateVariant: async (input) => {
      generateCalls.push(input.channel);
      return okVariant(input.channel)();
    },
    createVariantArticle: async ({ channel }) => {
      createCalls.push(channel);
      return variantArticle(99, channel);
    },
    writeManuscriptFile: async () => {},
  });
  assert(r3.status === "success", "재사용 케이스 실패");
  assert(generateCalls.length === 0, "이미 있는 배리에이션은 재생성하면 안 된다");
  assert(createCalls.length === 0, "이미 있는 배리에이션은 DB에 다시 만들면 안 된다");
  if (r3.status === "success") {
    const tistory = r3.topic.channels.find((c) => c.channel === "tistory")!;
    assert(tistory.title === "tistory 기존 제목", "재사용 시 기존 제목을 써야 한다");
  }
  console.log("✅ 기존 배리에이션 재사용 - LLM/DB 재호출 없음");

  // 4) 배리에이션 생성 실패 -> job 전체 실패로 전파
  const r4 = await prepareChannelManuscripts(job("a"), {
    loadArticles: async () => [baseArticle()],
    generateVariant: async () => ({ status: "failed" as const, error: "타임아웃" }),
    createVariantArticle: async ({ channel }) => variantArticle(99, channel),
    writeManuscriptFile: async () => {},
  });
  assert(r4.status === "failed" && r4.reason.includes("타임아웃"), "배리에이션 실패 전파 실패");
  console.log("✅ 배리에이션 생성 실패 -> job 실패로 전파");

  // 5) prepareApprovedManuscripts - 이미 준비된 job은 건너뛴다 + 페이지 갱신 시 배포 호출
  const marks: Array<{ id: string; patch: Record<string, unknown> }> = [];
  let manifestSaved: ManuscriptManifest | null = null;
  let pageHtml: string | null = null;
  let deployCalled = false;
  const r5 = await prepareApprovedManuscripts({
    deploy: async () => {
      deployCalled = true;
      return { status: "skipped", reason: "test" };
    },
    loadApprovedJobs: async () => [job("ready", { channelManuscriptsReadyAt: "2026-09-01T00:00:00Z" }), job("pending")],
    prepareJob: async (j) =>
      j.id === "pending"
        ? {
            status: "success",
            topic: {
              jobId: j.id,
              keyword: j.keyword,
              category: j.category,
              date: "2026-09-05",
              readyAt: "2026-09-05T00:00:00Z",
              channels: [
                { channel: "naver", title: "제목", searchDescription: null, slug: null, tags: [], body: "본문", imagePrompts: [], filePath: "x" },
              ],
            },
          }
        : (() => {
            throw new Error("이미 준비된 job은 prepareJob이 호출되면 안 된다");
          })(),
    markPrepared: async (id, patch) => {
      marks.push({ id, patch });
    },
    loadManifest: async () => ({ topics: [] }),
    saveManifest: async (m) => {
      manifestSaved = m;
    },
    writePage: async (html) => {
      pageHtml = html;
    },
  });
  assert(r5.length === 1 && r5[0].job.id === "pending", "이미 준비된 job은 건너뛰어야 한다");
  assert(marks.length === 1 && marks[0].id === "pending", "완료 표시(metadata)가 pending job에만 있어야 한다");
  assert(manifestSaved !== null && (manifestSaved as ManuscriptManifest).topics.length === 1, "manifest 저장 실패");
  assert(pageHtml !== null && (pageHtml as string).includes("테스트 키워드 pending"), "페이지에 주제가 반영돼야 한다");
  assert(deployCalled, "페이지를 새로 썼으면 배포도 호출돼야 한다");
  console.log("✅ prepareApprovedManuscripts - 준비 완료 job 건너뛰기 + manifest/페이지 갱신 + 배포 호출");

  // 6) maxJobsPerRun 제한 + 전부 실패하면 페이지 갱신도 배포도 안 함
  let deployCalledOnAllFailure = false;
  const r6 = await prepareApprovedManuscripts({
    deploy: async () => {
      deployCalledOnAllFailure = true;
      return { status: "skipped", reason: "test" };
    },
    loadApprovedJobs: async () => [job("x"), job("y"), job("z")],
    prepareJob: async () => ({ status: "failed", reason: "테스트용 실패" }),
    markPrepared: async () => {},
    loadManifest: async () => ({ topics: [] }),
    saveManifest: async () => {},
    writePage: async () => {},
    maxJobsPerRun: 2,
  });
  assert(r6.length === 2, `maxJobsPerRun 제한 실패 (${r6.length})`);
  assert(!deployCalledOnAllFailure, "성공한 job이 없으면 페이지도 배포도 갱신하면 안 된다");
  console.log("✅ maxJobsPerRun 제한 + 전부 실패 시 배포 미호출");

  console.log("\n✅ 전체 통과");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
