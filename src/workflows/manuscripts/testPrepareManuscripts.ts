// prepareChannelManuscripts / prepareApprovedManuscripts 테스트. LLM(generateVariant)·Supabase·
// 파일시스템을 전부 주입해 오케스트레이션과 멱등성만 검증한다. 외부 API·DB 호출 없음.
//
// 2026-09-07 채널 전담제 개편: 이제 job 1건은 category로 정해진 채널(티스토리 또는 블로그스팟)
// 딱 하나의 원고만 만든다(config/channelRouting.ts). 네이버는 이번 개편에서 빠졌다.
import { prepareChannelManuscripts } from "./prepareChannelManuscripts.js";
import { prepareApprovedManuscripts } from "./prepareApprovedManuscripts.js";
import type { ArticleJobRow, ArticleRow } from "../../types/database.js";
import type { ManuscriptManifest } from "./manuscriptManifest.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

function job(id: string, category: string | null, metadata: Record<string, unknown> = {}): ArticleJobRow {
  return {
    id,
    source_run_id: 1,
    source_rank: 1,
    keyword: `테스트 키워드 ${id}`,
    headline: null,
    seed_query: null,
    category,
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

  // 1) 카테고리가 배정표에 없으면(예: 육아) 기준 원고 유무와 무관하게 채널 배정 실패.
  const noRoute = await prepareChannelManuscripts(job("a", "parenting"), {
    loadArticles: async () => [baseArticle()],
  });
  assert(
    noRoute.status === "failed" && noRoute.reason.includes("채널 배정 불가"),
    "배정표에 없는 카테고리는 채널 배정 실패로 처리해야 한다"
  );
  console.log("✅ 배정표에 없는 카테고리(육아) -> 채널 배정 실패");

  // 2) 기준 원고 없음 -> 실패 (category는 정상 배정되는 living으로)
  const noBase = await prepareChannelManuscripts(job("a", "living"), {
    loadArticles: async () => [],
  });
  assert(noBase.status === "failed" && noBase.reason.includes("기준 원고"), "기준 원고 없음 처리 실패");
  console.log("✅ 기준 원고 없음 -> 실패");

  // 3) 신규 생성: living -> 티스토리 배리에이션 1건만 생성 + 파일 1개 기록 + imagePrompts 전달.
  let generateCalls: string[] = [];
  let createCalls: string[] = [];
  const writes: Record<string, string> = {};
  const r3 = await prepareChannelManuscripts(job("a", "living", { imagePrompts: ["이미지 프롬프트 A"] }), {
    loadArticles: async () => [baseArticle()],
    generateVariant: async (input) => {
      generateCalls.push(input.channel);
      return okVariant(input.channel)();
    },
    createVariantArticle: async ({ channel }) => {
      createCalls.push(channel);
      return variantArticle(99, channel);
    },
    writeManuscriptFile: async (path, content) => {
      writes[path] = content;
    },
    mergeJobMetadata: async () => {},
  });
  assert(r3.status === "success", "신규 생성 실패");
  if (r3.status === "success") {
    assert(r3.topic.channels.length === 1, `채널 1개여야 한다 (${r3.topic.channels.length})`);
    const tistory = r3.topic.channels[0];
    assert(tistory.channel === "tistory", `living 카테고리는 티스토리로 배정돼야 한다 (${tistory.channel})`);
    assert(tistory.title === "tistory 제목" && tistory.tags.length === 2, "티스토리 배리에이션 반영 실패");
    assert(
      tistory.imagePrompts.length === 1 && tistory.imagePrompts[0] === "이미지 프롬프트 A",
      "job.metadata.imagePrompts가 채널에 전달돼야 한다"
    );
  }
  assert(generateCalls.join(",") === "tistory", `배리에이션은 배정된 채널 하나만 생성 (${generateCalls})`);
  assert(createCalls.length === 1, "DB 배리에이션 저장 1회여야 한다");
  assert(Object.keys(writes).length === 1, `파일 1개 기록 (${Object.keys(writes).length})`);
  console.log("✅ living 카테고리 -> 티스토리 배리에이션 1개 파일 기록");

  // 4) entertainment/ott -> 블로그스팟으로 배정.
  const r4 = await prepareChannelManuscripts(job("a", "entertainment"), {
    loadArticles: async () => [baseArticle()],
    generateVariant: async (input) => okVariant(input.channel)(),
    createVariantArticle: async ({ channel }) => variantArticle(99, channel),
    writeManuscriptFile: async () => {},
    mergeJobMetadata: async () => {},
  });
  assert(r4.status === "success", "entertainment 배정 실패");
  if (r4.status === "success") {
    assert(
      r4.topic.channels.length === 1 && r4.topic.channels[0].channel === "blogspot",
      `entertainment 카테고리는 블로그스팟으로 배정돼야 한다 (${r4.topic.channels[0]?.channel})`
    );
  }
  console.log("✅ entertainment 카테고리 -> 블로그스팟 배정");

  // 5) 기존 배리에이션 재사용 -> generateVariant 재호출 안 함(LLM 비용 절약)
  generateCalls = [];
  createCalls = [];
  const r5 = await prepareChannelManuscripts(job("a", "living"), {
    loadArticles: async () => [baseArticle(), variantArticle(2, "tistory")],
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
  assert(r5.status === "success", "재사용 케이스 실패");
  assert(generateCalls.length === 0, "이미 있는 배리에이션은 재생성하면 안 된다");
  assert(createCalls.length === 0, "이미 있는 배리에이션은 DB에 다시 만들면 안 된다");
  if (r5.status === "success") {
    assert(r5.topic.channels[0].title === "tistory 기존 제목", "재사용 시 기존 제목을 써야 한다");
  }
  console.log("✅ 기존 배리에이션 재사용 - LLM/DB 재호출 없음");

  // 6) 배리에이션 생성 실패 -> job 전체 실패로 전파
  const r6 = await prepareChannelManuscripts(job("a", "living"), {
    loadArticles: async () => [baseArticle()],
    generateVariant: async () => ({ status: "failed" as const, error: "타임아웃" }),
    createVariantArticle: async ({ channel }) => variantArticle(99, channel),
    writeManuscriptFile: async () => {},
  });
  assert(r6.status === "failed" && r6.reason.includes("타임아웃"), "배리에이션 실패 전파 실패");
  console.log("✅ 배리에이션 생성 실패 -> job 실패로 전파");

  // 7) .md 파일 쓰기 직전에만 [IMAGE PROMPT:]를 마커 바로 아래 재삽입한다(entry.body/manifest는 그대로).
  const bodyWithImage = "본문 문단.\n\n[IMAGE: 설명 — 웹 검색]\n\n다음 문단.";
  const writes7: Record<string, string> = {};
  const r7 = await prepareChannelManuscripts(job("a", "living", { imagePrompts: ["재삽입될 프롬프트"] }), {
    loadArticles: async () => [baseArticle(bodyWithImage)],
    generateVariant: async (input) => okVariant(input.channel)(),
    createVariantArticle: async ({ channel }) => variantArticle(99, channel),
    writeManuscriptFile: async (path, content) => {
      writes7[path] = content;
    },
    mergeJobMetadata: async () => {},
  });
  assert(r7.status === "success", "이미지 프롬프트 재삽입 케이스 실패");
  if (r7.status === "success") {
    assert(!r7.topic.channels[0].body.includes("IMAGE PROMPT"), "manifest/entry.body에는 프롬프트를 재삽입하면 안 된다");
    const tistoryFile = Object.entries(writes7).find(([path]) => path.endsWith("tistory.md"))?.[1] ?? "";
    assert(tistoryFile.includes("[IMAGE PROMPT: 재삽입될 프롬프트]"), `.md 파일에는 마커 바로 아래 프롬프트가 재삽입돼야 한다 (${tistoryFile})`);
  }
  console.log("✅ .md 파일에만 이미지 프롬프트 재삽입, entry.body/manifest는 그대로");

  // 7-1) 신규 생성 시 searchDescription/slug/tags를 job.metadata.channelMeta에 저장해야 한다
  //      (articles 테이블엔 이 컬럼들이 없어 재사용 시 복구할 곳이 여기뿐 - 2026-09-15).
  const metaPatches: Array<Record<string, unknown>> = [];
  const r71 = await prepareChannelManuscripts(job("a", "living"), {
    loadArticles: async () => [baseArticle()],
    generateVariant: async (input) => okVariant(input.channel)(),
    createVariantArticle: async ({ channel }) => variantArticle(99, channel),
    writeManuscriptFile: async () => {},
    mergeJobMetadata: async (_id, patch) => {
      metaPatches.push(patch);
    },
  });
  assert(r71.status === "success", "신규 생성(메타 저장 케이스) 실패");
  assert(metaPatches.length === 1, `job.metadata 갱신이 1회 호출돼야 한다 (${metaPatches.length})`);
  const savedChannelMeta = metaPatches[0]?.channelMeta as Record<string, { tags: string[] }> | undefined;
  assert(
    savedChannelMeta?.tistory?.tags?.length === 2,
    `channelMeta.tistory.tags가 저장돼야 한다 (${JSON.stringify(savedChannelMeta)})`
  );
  console.log("✅ 신규 생성 시 searchDescription/slug/tags를 job.metadata.channelMeta에 저장");

  // 7-2) 재사용 시 job.metadata.channelMeta에 저장된 값이 있으면 tags 등을 복구해야 한다
  //      (없으면 2026-09-15 이전 job처럼 계속 비어 있는 게 맞다 - 별도 케이스로 확인).
  const r72 = await prepareChannelManuscripts(
    job("a", "living", {
      channelMeta: { tistory: { searchDescription: "복구된 설명", slug: null, tags: ["복구태그1", "복구태그2", "복구태그3"] } },
    }),
    {
      loadArticles: async () => [baseArticle(), variantArticle(2, "tistory")],
      generateVariant: async () => {
        throw new Error("재사용 케이스는 generateVariant를 호출하면 안 된다");
      },
      writeManuscriptFile: async () => {},
    }
  );
  assert(r72.status === "success", "재사용+메타 복구 케이스 실패");
  if (r72.status === "success") {
    const ch = r72.topic.channels[0];
    assert(ch.tags.length === 3 && ch.tags[0] === "복구태그1", `재사용 시 tags가 job.metadata에서 복구돼야 한다 (${JSON.stringify(ch.tags)})`);
    assert(ch.searchDescription === "복구된 설명", "재사용 시 searchDescription도 복구돼야 한다");
  }
  const r73 = await prepareChannelManuscripts(job("a", "living"), {
    loadArticles: async () => [baseArticle(), variantArticle(2, "tistory")],
    generateVariant: async () => {
      throw new Error("재사용 케이스는 generateVariant를 호출하면 안 된다");
    },
    writeManuscriptFile: async () => {},
  });
  assert(
    r73.status === "success" && r73.topic.channels[0].tags.length === 0,
    "channelMeta가 없는(과거) job은 재사용 시 tags가 계속 비어 있어야 한다"
  );
  console.log("✅ 재사용 시 job.metadata.channelMeta 있으면 tags/searchDescription 복구, 없으면 그대로 빈 값");

  // 8) prepareApprovedManuscripts - 이미 준비된 job은 건너뛴다 + 페이지 갱신 시 배포 호출
  const marks: Array<{ id: string; patch: Record<string, unknown> }> = [];
  let manifestSaved: ManuscriptManifest | null = null;
  let pageHtml: string | null = null;
  let deployCalled = false;
  const r8 = await prepareApprovedManuscripts({
    deploy: async () => {
      deployCalled = true;
      return { status: "skipped", reason: "test" };
    },
    loadApprovedJobs: async () => [
      job("ready", "living", { channelManuscriptsReadyAt: "2026-09-01T00:00:00Z" }),
      job("pending", "living"),
    ],
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
                { channel: "tistory", title: "제목", searchDescription: null, slug: null, tags: [], body: "본문", imagePrompts: [], filePath: "x" },
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
  assert(r8.length === 1 && r8[0].job.id === "pending", "이미 준비된 job은 건너뛰어야 한다");
  assert(marks.length === 1 && marks[0].id === "pending", "완료 표시(metadata)가 pending job에만 있어야 한다");
  assert(manifestSaved !== null && (manifestSaved as ManuscriptManifest).topics.length === 1, "manifest 저장 실패");
  assert(pageHtml !== null && (pageHtml as string).includes("테스트 키워드 pending"), "페이지에 주제가 반영돼야 한다");
  assert(deployCalled, "페이지를 새로 썼으면 배포도 호출돼야 한다");
  console.log("✅ prepareApprovedManuscripts - 준비 완료 job 건너뛰기 + manifest/페이지 갱신 + 배포 호출");

  // 9) maxJobsPerRun 제한 + 전부 실패하면 페이지 갱신도 배포도 안 함
  let deployCalledOnAllFailure = false;
  const r9 = await prepareApprovedManuscripts({
    deploy: async () => {
      deployCalledOnAllFailure = true;
      return { status: "skipped", reason: "test" };
    },
    loadApprovedJobs: async () => [job("x", "living"), job("y", "living"), job("z", "living")],
    prepareJob: async () => ({ status: "failed", reason: "테스트용 실패" }),
    markPrepared: async () => {},
    loadManifest: async () => ({ topics: [] }),
    saveManifest: async () => {},
    writePage: async () => {},
    maxJobsPerRun: 2,
  });
  assert(r9.length === 2, `maxJobsPerRun 제한 실패 (${r9.length})`);
  assert(!deployCalledOnAllFailure, "성공한 job이 없으면 페이지도 배포도 갱신하면 안 된다");
  console.log("✅ maxJobsPerRun 제한 + 전부 실패 시 배포 미호출");

  console.log("\n✅ 전체 통과");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
