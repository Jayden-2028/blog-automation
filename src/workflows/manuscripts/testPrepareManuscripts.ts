// prepareManuscript / prepareApprovedManuscripts 테스트. LLM(generateVariant)·이미지 생성·
// Supabase·파일시스템을 전부 주입해 오케스트레이션과 멱등성만 검증한다. 외부 API·DB 호출 없음.
//
// 2026-09-15 Blogspot 단독 운영(BLOGSPOT_ONLY_DESIGN.md): 채널 배정이 사라져 job 1건 = 원고 1건이다.
// 예전 "배정표에 없는 카테고리 -> 실패" 케이스는 더 이상 존재하지 않는다(모든 카테고리가 통과).
import { prepareManuscript } from "./prepareManuscript.js";
import { prepareApprovedManuscripts } from "./prepareApprovedManuscripts.js";
import type { ArticleJobRow, ArticleRow } from "../../types/database.js";
import type { ManuscriptImage, ManuscriptManifest } from "./manuscriptManifest.js";
import { buildCostSummary } from "../reports/buildCostSummary.js";
import type { WriteCostSnapshotResult } from "../reports/writeCostSnapshot.js";

/**
 * 비용 스냅샷 스텁. 기본 구현은 Supabase를 읽으므로 주입하지 않으면 이 테스트가 조용히 네트워크를
 * 탄다(2026-09-16). 이 파일의 다른 의존성과 같은 이유로 전부 주입한다.
 */
const noCostSnapshot = async (): Promise<WriteCostSnapshotResult> => ({
  status: "success",
  path: "(테스트 스텁 - 파일을 쓰지 않음)",
  summary: buildCostSummary({ rows: [], fixedCosts: [] }),
});

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

function variantArticle(id: number, platform = "blogspot"): ArticleRow {
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

const okVariant = async () => ({
  status: "success" as const,
  durationMs: 1,
  variant: {
    title: "blogspot 제목",
    searchDescription: "blogspot 설명",
    slug: "blogspot-slug",
    tags: ["태그1", "태그2"],
    // 실제 파이프라인 모양: 배리에이션도 [IMAGE: 설명] 단독 줄만 남긴다(프롬프트는
    // job.metadata.imagePrompts에 별도 보관 - parseManuscriptBlocks 테스트 참고).
    body: "blogspot 본문\n[IMAGE: 설명 — 웹 검색]\n계속 본문",
  },
});

const noImages = async () => ({ images: [] as ManuscriptImage[], failures: [] as string[] });

async function main(): Promise<void> {
  console.log("▶ prepareManuscript / prepareApprovedManuscripts 테스트 시작\n");

  // 1) 기준 원고 없음 -> 실패
  const noBase = await prepareManuscript(job("a", "living"), {
    loadArticles: async () => [],
    generateImages: false,
  });
  assert(noBase.status === "failed" && noBase.reason.includes("기준 원고"), "기준 원고 없음 처리 실패");
  console.log("✅ 기준 원고 없음 -> 실패");

  // 2) 예전에 채널 배정이 안 되던 카테고리(육아)도 이제 그대로 통과해야 한다.
  const parenting = await prepareManuscript(job("a", "parenting"), {
    loadArticles: async () => [baseArticle()],
    generateVariant: okVariant,
    createVariantArticle: async () => variantArticle(99),
    writeManuscriptFile: async () => {},
    mergeJobMetadata: async () => {},
    generateImages: false,
  });
  assert(parenting.status === "success", "카테고리와 무관하게 Blogspot 원고를 만들어야 한다");
  console.log("✅ 모든 카테고리 -> Blogspot 원고 1건 (채널 배정 실패 경로 없음)");

  // 3) 신규 생성: 배리에이션 1건 + 파일 1개 + imagePrompts 전달
  let generateCalls = 0;
  let createCalls = 0;
  const writes: Record<string, string> = {};
  const r3 = await prepareManuscript(job("a", "living", { imagePrompts: ["이미지 프롬프트 A"] }), {
    loadArticles: async () => [baseArticle()],
    generateVariant: async () => {
      generateCalls += 1;
      return okVariant();
    },
    createVariantArticle: async () => {
      createCalls += 1;
      return variantArticle(99);
    },
    writeManuscriptFile: async (path, content) => {
      writes[path] = content;
    },
    mergeJobMetadata: async () => {},
    generateImages: false,
  });
  assert(r3.status === "success", "신규 생성 실패");
  if (r3.status === "success") {
    const m = r3.topic.manuscript;
    assert(m.title === "blogspot 제목" && m.tags.length === 2, "배리에이션 반영 실패");
    assert(m.slug === "blogspot-slug", "slug 반영 실패");
    assert(
      m.imagePrompts.length === 1 && m.imagePrompts[0] === "이미지 프롬프트 A",
      "job.metadata.imagePrompts가 원고에 전달돼야 한다"
    );
  }
  assert(generateCalls === 1, `배리에이션 생성은 1회 (${generateCalls})`);
  assert(createCalls === 1, "DB 배리에이션 저장 1회여야 한다");
  assert(Object.keys(writes).length === 1, `파일 1개 기록 (${Object.keys(writes).length})`);
  // 경로에서 채널 단계가 빠졌는지(manuscripts/<날짜>/<주제>.md) 확인한다.
  const writtenPath = Object.keys(writes)[0];
  assert(/\/\d{4}-\d{2}-\d{2}\/[^/]+\.md$/.test(writtenPath), `경로에 채널 단계가 없어야 한다 (${writtenPath})`);
  console.log("✅ 신규 생성 -> Blogspot 원고 1건, manuscripts/<날짜>/<주제>.md 경로");

  // 4) 기존 배리에이션 재사용 -> generateVariant 재호출 안 함(LLM 비용 절약)
  generateCalls = 0;
  createCalls = 0;
  const r4 = await prepareManuscript(job("a", "living"), {
    loadArticles: async () => [baseArticle(), variantArticle(2)],
    generateVariant: async () => {
      generateCalls += 1;
      return okVariant();
    },
    createVariantArticle: async () => {
      createCalls += 1;
      return variantArticle(99);
    },
    writeManuscriptFile: async () => {},
    generateImages: false,
  });
  assert(r4.status === "success", "재사용 케이스 실패");
  assert(generateCalls === 0, "이미 있는 배리에이션은 재생성하면 안 된다");
  assert(createCalls === 0, "이미 있는 배리에이션은 DB에 다시 만들면 안 된다");
  if (r4.status === "success") {
    assert(r4.topic.manuscript.title === "blogspot 기존 제목", "재사용 시 기존 제목을 써야 한다");
  }
  console.log("✅ 기존 배리에이션 재사용 - LLM/DB 재호출 없음");

  // 5) 배리에이션 생성 실패 -> job 전체 실패로 전파
  const r5 = await prepareManuscript(job("a", "living"), {
    loadArticles: async () => [baseArticle()],
    generateVariant: async () => ({ status: "failed" as const, error: "타임아웃" }),
    createVariantArticle: async () => variantArticle(99),
    writeManuscriptFile: async () => {},
    generateImages: false,
  });
  assert(r5.status === "failed" && r5.reason.includes("타임아웃"), "배리에이션 실패 전파 실패");
  console.log("✅ 배리에이션 생성 실패 -> job 실패로 전파");

  // 6) .md 파일 쓰기 직전에만 [IMAGE PROMPT:]를 마커 바로 아래 재삽입한다(entry.body/manifest는 그대로).
  const bodyWithImage = "본문 문단.\n\n[IMAGE: 설명 — 웹 검색]\n\n다음 문단.";
  const writes6: Record<string, string> = {};
  const r6 = await prepareManuscript(job("a", "living", { imagePrompts: ["재삽입될 프롬프트"] }), {
    loadArticles: async () => [baseArticle(bodyWithImage)],
    generateVariant: okVariant,
    createVariantArticle: async () => variantArticle(99),
    writeManuscriptFile: async (path, content) => {
      writes6[path] = content;
    },
    mergeJobMetadata: async () => {},
    generateImages: false,
  });
  assert(r6.status === "success", "이미지 프롬프트 재삽입 케이스 실패");
  if (r6.status === "success") {
    assert(!r6.topic.manuscript.body.includes("IMAGE PROMPT"), "manifest/entry.body에는 프롬프트를 재삽입하면 안 된다");
    const file = Object.values(writes6)[0] ?? "";
    assert(file.includes("[IMAGE PROMPT: 재삽입될 프롬프트]"), `.md 파일에는 마커 바로 아래 프롬프트가 재삽입돼야 한다 (${file})`);
  }
  console.log("✅ .md 파일에만 이미지 프롬프트 재삽입, entry.body/manifest는 그대로");

  // 7) 신규 생성 시 searchDescription/slug/tags를 job.metadata.channelMeta.blogspot에 저장해야 한다
  //    (articles 테이블엔 이 컬럼들이 없어 재사용 시 복구할 곳이 여기뿐 - 2026-09-15).
  const metaPatches: Array<Record<string, unknown>> = [];
  const r7 = await prepareManuscript(job("a", "living"), {
    loadArticles: async () => [baseArticle()],
    generateVariant: okVariant,
    createVariantArticle: async () => variantArticle(99),
    writeManuscriptFile: async () => {},
    mergeJobMetadata: async (_id, patch) => {
      metaPatches.push(patch);
    },
    generateImages: false,
  });
  assert(r7.status === "success", "신규 생성(메타 저장 케이스) 실패");
  assert(metaPatches.length === 1, `job.metadata 갱신이 1회 호출돼야 한다 (${metaPatches.length})`);
  const savedMeta = metaPatches[0]?.channelMeta as Record<string, { tags: string[] }> | undefined;
  assert(
    savedMeta?.blogspot?.tags?.length === 2,
    `channelMeta.blogspot.tags가 저장돼야 한다 (${JSON.stringify(savedMeta)})`
  );
  console.log("✅ 신규 생성 시 searchDescription/slug/tags를 job.metadata에 저장");

  // 8) 재사용 시 job.metadata.channelMeta에 저장된 값이 있으면 tags 등을 복구해야 한다.
  const r8 = await prepareManuscript(
    job("a", "living", {
      channelMeta: { blogspot: { searchDescription: "복구된 설명", slug: null, tags: ["복구1", "복구2", "복구3"] } },
    }),
    {
      loadArticles: async () => [baseArticle(), variantArticle(2)],
      generateVariant: async () => {
        throw new Error("재사용 케이스는 generateVariant를 호출하면 안 된다");
      },
      writeManuscriptFile: async () => {},
      generateImages: false,
    }
  );
  assert(r8.status === "success", "재사용+메타 복구 케이스 실패");
  if (r8.status === "success") {
    const m = r8.topic.manuscript;
    assert(m.tags.length === 3 && m.tags[0] === "복구1", `재사용 시 tags가 복구돼야 한다 (${JSON.stringify(m.tags)})`);
    assert(m.searchDescription === "복구된 설명", "재사용 시 searchDescription도 복구돼야 한다");
  }
  const r8b = await prepareManuscript(job("a", "living"), {
    loadArticles: async () => [baseArticle(), variantArticle(2)],
    generateVariant: async () => {
      throw new Error("재사용 케이스는 generateVariant를 호출하면 안 된다");
    },
    writeManuscriptFile: async () => {},
    generateImages: false,
  });
  assert(
    r8b.status === "success" && r8b.topic.manuscript.tags.length === 0,
    "channelMeta가 없는(과거) job은 재사용 시 tags가 계속 비어 있어야 한다"
  );
  console.log("✅ 재사용 시 channelMeta 있으면 복구, 없으면 그대로 빈 값");

  // 9) 이미지 생성: 결과가 manifest entry.images에 들어가고 job.metadata에도 저장된다.
  const imagePatches: Array<Record<string, unknown>> = [];
  let imageCalls = 0;
  const r9 = await prepareManuscript(job("a", "living", { imagePrompts: ["프롬프트 A"] }), {
    loadArticles: async () => [baseArticle()],
    generateVariant: okVariant,
    createVariantArticle: async () => variantArticle(99),
    writeManuscriptFile: async () => {},
    mergeJobMetadata: async (_id, patch) => {
      imagePatches.push(patch);
    },
    generateImages: async (input) => {
      imageCalls += 1;
      assert(input.imagePrompts[0] === "프롬프트 A", "이미지 생성에 imagePrompts가 전달돼야 한다");
      assert(input.body.includes("[IMAGE:"), "이미지 생성에 확정된 본문이 전달돼야 한다");
      return {
        images: [
          { index: 1, description: "설명", prompt: "프롬프트 A", url: "https://x/1.png", provider: "gemini", fileName: "01-설명.png", error: null },
        ],
        failures: ["[이미지 2] 생성 실패: 테스트"],
      };
    },
  });
  assert(r9.status === "success", "이미지 생성 케이스 실패");
  if (r9.status === "success") {
    assert(r9.topic.manuscript.images.length === 1, "생성된 이미지가 manifest에 담겨야 한다");
    assert(r9.topic.manuscript.images[0].url === "https://x/1.png", "이미지 URL이 담겨야 한다");
    assert(r9.imageFailures.length === 1, "이미지 실패 사유가 결과에 남아야 한다");
  }
  assert(imageCalls === 1, "이미지 생성은 1회 호출");
  assert(
    imagePatches.some((p) => p.imagesReadyAt && Array.isArray(p.images)),
    `imagesReadyAt + images가 job.metadata에 저장돼야 한다 (${JSON.stringify(imagePatches)})`
  );
  console.log("✅ 이미지 생성 결과가 manifest/metadata에 반영 + 실패 사유 전달");

  // 10) 이미 이미지를 만든 job은 다시 만들지 않는다(멱등 - 유료 호출 방지).
  let recall = 0;
  const saved: ManuscriptImage[] = [
    { index: 1, description: "설명", prompt: "p", url: "https://x/saved.png", provider: "openai", fileName: "01-설명.png", error: null },
  ];
  const r10 = await prepareManuscript(job("a", "living", { imagesReadyAt: "2026-09-15T00:00:00Z", images: saved }), {
    loadArticles: async () => [baseArticle(), variantArticle(2)],
    generateVariant: async () => {
      throw new Error("재사용 케이스는 generateVariant를 호출하면 안 된다");
    },
    writeManuscriptFile: async () => {},
    generateImages: async () => {
      recall += 1;
      return noImages();
    },
  });
  assert(r10.status === "success", "이미지 멱등 케이스 실패");
  assert(recall === 0, "이미 만든 이미지는 다시 생성하면 안 된다(유료 호출)");
  if (r10.status === "success") {
    assert(r10.topic.manuscript.images[0].url === "https://x/saved.png", "저장된 이미지를 그대로 써야 한다");
  }
  console.log("✅ 이미 생성된 이미지는 재생성하지 않고 metadata에서 복구");

  // 11) prepareApprovedManuscripts - 이미 준비된 job은 건너뛴다 + 페이지 갱신 시 배포 호출
  const marks: Array<{ id: string; patch: Record<string, unknown> }> = [];
  let manifestSaved: ManuscriptManifest | null = null;
  let pageHtml: string | null = null;
  let deployCalled = false;
  const r11 = await prepareApprovedManuscripts({
    publishBlogspot: async () => ({ ok: false, reason: "disabled", detail: "test" }),
    writeCostSnapshot: noCostSnapshot,
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
            imageFailures: [],
            topic: {
              jobId: j.id,
              keyword: j.keyword,
              category: j.category,
              date: "2026-09-15",
              readyAt: "2026-09-15T00:00:00Z",
              manuscript: {
                title: "제목",
                searchDescription: null,
                slug: null,
                tags: [],
                body: "본문",
                imagePrompts: [],
                images: [],
                filePath: "x",
              },
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
  assert(r11.length === 1 && r11[0].job.id === "pending", "이미 준비된 job은 건너뛰어야 한다");
  assert(marks.length === 1 && marks[0].id === "pending", "완료 표시(metadata)가 pending job에만 있어야 한다");
  assert(manifestSaved !== null && (manifestSaved as ManuscriptManifest).topics.length === 1, "manifest 저장 실패");
  assert(pageHtml !== null && (pageHtml as string).includes("테스트 키워드 pending"), "페이지에 주제가 반영돼야 한다");
  assert(deployCalled, "페이지를 새로 썼으면 배포도 호출돼야 한다");
  console.log("✅ prepareApprovedManuscripts - 준비 완료 job 건너뛰기 + manifest/페이지 갱신 + 배포 호출");

  // 12) maxJobsPerRun 제한 + 전부 실패하면 페이지 갱신도 배포도 안 함
  let deployCalledOnAllFailure = false;
  const r12 = await prepareApprovedManuscripts({
    writeCostSnapshot: noCostSnapshot,
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
  assert(r12.length === 2, `maxJobsPerRun 제한 실패 (${r12.length})`);
  assert(!deployCalledOnAllFailure, "성공한 job이 없으면 페이지도 배포도 갱신하면 안 된다");
  console.log("✅ maxJobsPerRun 제한 + 전부 실패 시 배포 미호출");

  // 13) 원고 준비 성공 직후 publishBlogspot(jobId)를 호출해야 한다(2026-09-15 재배선) - 실패한
  //     job에는 호출하면 안 된다. publishBlogspot 자체가 실패해도(예외 포함) 원고 준비 결과는
  //     그대로 success 유지.
  const publishCalls: string[] = [];
  const r13 = await prepareApprovedManuscripts({
    writeCostSnapshot: noCostSnapshot,
    deploy: async () => ({ status: "skipped", reason: "test" }),
    loadApprovedJobs: async () => [job("ok", "living"), job("fail", "living")],
    prepareJob: async (j) =>
      j.id === "ok"
        ? {
            status: "success",
            imageFailures: [],
            topic: {
              jobId: j.id,
              keyword: j.keyword,
              category: j.category,
              date: "2026-09-15",
              readyAt: "2026-09-15T00:00:00Z",
              manuscript: {
                title: "제목",
                searchDescription: null,
                slug: null,
                tags: [],
                body: "본문",
                imagePrompts: [],
                images: [],
                filePath: "x",
              },
            },
          }
        : { status: "failed", reason: "테스트용 실패" },
    markPrepared: async () => {},
    loadManifest: async () => ({ topics: [] }),
    saveManifest: async () => {},
    writePage: async () => {},
    publishBlogspot: async (jobId) => {
      publishCalls.push(jobId);
      throw new Error("Blogger 호출 실패(테스트)");
    },
  });
  assert(publishCalls.length === 1 && publishCalls[0] === "ok", `원고 준비 성공 job에만 publishBlogspot 호출 (${JSON.stringify(publishCalls)})`);
  assert(r13.find((r) => r.job.id === "ok")?.result.status === "success", "publishBlogspot 예외가 원고 준비 결과를 실패로 바꾸면 안 된다");
  console.log("✅ 원고 준비 성공 직후 publishBlogspot 호출 (실패한 job은 미호출, 발행 예외가 원고 준비 결과에 영향 없음)");

  console.log("\n✅ 전체 통과");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
