// prepareManuscript / prepareApprovedManuscripts 테스트. 이미지 생성·
// Supabase·파일시스템을 전부 주입해 오케스트레이션과 멱등성만 검증한다. 외부 API·DB 호출 없음.
//
// 2026-09-30: 배리에이션 단계 폐지 - 작성 단계 원고(platform=null)가 곧 최종 원고다.
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

const noImages = async () => ({ images: [] as ManuscriptImage[], failures: [] as string[] });

async function main(): Promise<void> {
  console.log("▶ prepareManuscript / prepareApprovedManuscripts 테스트 시작\n");

  // 1) 기준 원고 없음 -> 실패
  const noBase = await prepareManuscript(job("a", "living"), {
    loadArticles: async () => [],
    generateImages: false,
    collectWebImages: false,
    loadPublishedPosts: false,
    capturePages: false,
  });
  assert(noBase.status === "failed" && noBase.reason.includes("기준 원고"), "기준 원고 없음 처리 실패");
  console.log("✅ 기준 원고 없음 -> 실패");

  // 2) 예전에 채널 배정이 안 되던 카테고리(육아)도 이제 그대로 통과해야 한다.
  const parenting = await prepareManuscript(job("a", "parenting"), {
    loadArticles: async () => [baseArticle()],
    writeManuscriptFile: async () => {},
    mergeJobMetadata: async () => {},
    generateImages: false,
    collectWebImages: false,
    loadPublishedPosts: false,
    capturePages: false,
  });
  assert(parenting.status === "success", "카테고리와 무관하게 원고를 준비해야 한다");
  console.log("✅ 모든 카테고리 -> Blogspot 원고 1건 (채널 배정 실패 경로 없음)");

  // 2-1) 내부 링크는 DB 원고에도 저장한다(2026-10-04). 전에는 뷰어에만 붙어 버튼 발행본에 빠졌다.
  {
    const original = "도입 문단입니다.\n\n**참고 자료**\n- [출처](https://example.com/src)\n\n#태그1 #태그2";
    const posts = [
      { jobId: "other", keyword: "테스트 키워드 다른 글", category: "living", title: "다른 글", url: "https://whynowissue.blogspot.com/2026/09/other.html" },
    ];
    const saved: { id: number; content: string }[] = [];
    const run = (content: string) =>
      prepareManuscript(job("a", "living"), {
        loadArticles: async () => [baseArticle(content)],
        writeManuscriptFile: async () => {},
        mergeJobMetadata: async () => {},
        generateImages: false,
        collectWebImages: false,
        capturePages: false,
        loadPublishedPosts: async () => posts as never,
        saveArticleContent: async (id, body) => {
          saved.push({ id, content: body });
        },
      });
    const first = await run(original);
    assert(first.status === "success", "준비가 성공해야 한다");
    assert(saved.length === 1 && saved[0].id === 1, `기준 원고(id 1)에 한 번 저장해야 한다 (${saved.length})`);
    const persisted = saved[0].content;
    assert(persisted.includes("**함께 보면 좋은 글**\n- [다른 글](https://whynowissue.blogspot.com/2026/09/other.html)"), `DB 원고에 내부 링크 (${persisted})`);
    assert(persisted.indexOf("함께 보면 좋은 글") < persisted.indexOf("**참고 자료**"), "참고 자료 앞에 들어간다");
    assert(persisted.endsWith("#태그1 #태그2"), "해시태그 줄은 그대로 끝에 남는다");
    assert(first.status === "success" && first.topic.manuscript.body.includes("함께 보면 좋은 글"), "뷰어 본문에도 같은 링크");
    assert(first.status === "success" && !first.topic.manuscript.body.includes("#태그1"), "뷰어 본문에는 해시태그 줄이 없다(tags로 따로)");
    assert(first.status === "success" && first.topic.manuscript.tags.join(",") === "태그1,태그2", "태그는 해시태그 줄에서");

    // 다시 돌려도(이미지 수정 등) 블록이 쌓이지 않고, 바뀐 게 없으면 저장하지 않는다.
    const second = await run(persisted);
    assert(second.status === "success" && (second.topic.manuscript.body.match(/함께 보면 좋은 글/g) ?? []).length === 1, "블록이 한 번만");
    assert(saved.length === 1, `같은 내용이면 다시 저장하지 않는다 (${saved.length})`);

    // 저장이 실패해도 원고 준비는 계속되고, 그 사실이 기록에 남는다.
    const failing = await prepareManuscript(job("a", "living"), {
      loadArticles: async () => [baseArticle(original)],
      writeManuscriptFile: async () => {},
      mergeJobMetadata: async () => {},
      generateImages: false,
      collectWebImages: false,
      capturePages: false,
      loadPublishedPosts: async () => posts as never,
      saveArticleContent: async () => {
        throw new Error("db down");
      },
    });
    assert(failing.status === "success", "저장 실패가 준비를 막으면 안 된다");
    assert(failing.status === "success" && (failing.topic.manuscript.imageNotes ?? []).some((n) => n.includes("내부 링크를 발행 원고에 저장하지 못했습니다")), "실패 기록이 남아야 한다");
  }
  console.log("✅ 내부 링크를 DB 원고에도 저장(참고 자료 앞·해시태그 유지), 재실행 시 중복·재저장 없음, 실패해도 계속");

  // 3) 기준 원고가 곧 최종본: LLM 호출 없이 파일 1개 + draftMeta + imagePrompts 전달
  const writes: Record<string, string> = {};
  const r3 = await prepareManuscript(
    job("a", "living", {
      imagePrompts: ["이미지 프롬프트 A"],
      draftMeta: { searchDescription: "검색 설명", slug: "my-slug", shortName: "짧은이름", tags: ["태그1", "태그2"] },
    }),
    {
      loadArticles: async () => [baseArticle("기준 본문\n[IMAGE: 설명 — 웹 검색]\n계속 본문\n\n#태그1 #태그2")],
      writeManuscriptFile: async (path, content) => {
        writes[path] = content;
      },
      mergeJobMetadata: async () => {},
      generateImages: false,
      collectWebImages: false,
      loadPublishedPosts: false,
      capturePages: false,
    }
  );
  assert(r3.status === "success", "기준 원고 준비 실패");
  if (r3.status === "success") {
    const m = r3.topic.manuscript;
    assert(m.title === "기준 제목", `기준 원고 제목을 그대로 써야 한다 (${m.title})`);
    assert(m.slug === "my-slug" && m.searchDescription === "검색 설명" && m.shortName === "짧은이름", "draftMeta가 반영돼야 한다");
    assert(m.tags.length === 2 && m.tags[0] === "태그1", `태그는 draftMeta에서 온다 (${JSON.stringify(m.tags)})`);
    assert(!m.body.includes("#태그1"), "본문 끝 해시태그 줄은 태그로 분리돼 본문에 남지 않아야 한다");
    assert(
      m.imagePrompts.length === 1 && m.imagePrompts[0] === "이미지 프롬프트 A",
      "job.metadata.imagePrompts가 원고에 전달돼야 한다"
    );
  }
  assert(Object.keys(writes).length === 1, `파일 1개 기록 (${Object.keys(writes).length})`);
  const writtenPath = Object.keys(writes)[0];
  assert(/\/\d{4}-\d{2}-\d{2}\/[^/]+\.md$/.test(writtenPath), `경로에 채널 단계가 없어야 한다 (${writtenPath})`);
  console.log("✅ 기준 원고가 곧 최종본 - draftMeta·태그 반영, manuscripts/<날짜>/<주제>.md 경로");

  // 4) 과거 배리에이션(기준 원고보다 새것)은 그대로 재사용한다 - 그 원고 기준으로 이미지가 채워져 있다.
  const r4 = await prepareManuscript(job("a", "living"), {
    loadArticles: async () => [baseArticle(), variantArticle(2)],
    writeManuscriptFile: async () => {},
    generateImages: false,
    collectWebImages: false,
    loadPublishedPosts: false,
    capturePages: false,
  });
  assert(r4.status === "success", "재사용 케이스 실패");
  if (r4.status === "success") {
    assert(r4.topic.manuscript.title === "blogspot 기존 제목", "재사용 시 기존 제목을 써야 한다");
  }
  console.log("✅ 과거 배리에이션은 그대로 재사용");

  // 6) .md 파일 쓰기 직전에만 [IMAGE PROMPT:]를 마커 바로 아래 재삽입한다(entry.body/manifest는 그대로).
  const bodyWithImage = "본문 문단.\n\n[IMAGE: 설명 — 웹 검색]\n\n다음 문단.";
  const writes6: Record<string, string> = {};
  const r6 = await prepareManuscript(job("a", "living", { imagePrompts: ["재삽입될 프롬프트"] }), {
    loadArticles: async () => [baseArticle(bodyWithImage)],
    writeManuscriptFile: async (path, content) => {
      writes6[path] = content;
    },
    mergeJobMetadata: async () => {},
    generateImages: false,
    collectWebImages: false,
    loadPublishedPosts: false,
    capturePages: false,
  });
  assert(r6.status === "success", "이미지 프롬프트 재삽입 케이스 실패");
  if (r6.status === "success") {
    assert(!r6.topic.manuscript.body.includes("IMAGE PROMPT"), "manifest/entry.body에는 프롬프트를 재삽입하면 안 된다");
    const file = Object.values(writes6)[0] ?? "";
    assert(file.includes("[IMAGE PROMPT: 재삽입될 프롬프트]"), `.md 파일에는 마커 바로 아래 프롬프트가 재삽입돼야 한다 (${file})`);
  }
  console.log("✅ .md 파일에만 이미지 프롬프트 재삽입, entry.body/manifest는 그대로");

  // 7) draftMeta가 없는 job(작성 단계가 옛 버전)도 태그는 본문 끝 해시태그 줄에서 복구하고, DB를 쓰지 않는다.
  const metaPatches: Array<Record<string, unknown>> = [];
  const r7 = await prepareManuscript(job("a", "living"), {
    loadArticles: async () => [baseArticle("본문\n\n#가 #나 #다")],
    writeManuscriptFile: async () => {},
    mergeJobMetadata: async (_id, patch) => {
      metaPatches.push(patch);
    },
    generateImages: false,
    collectWebImages: false,
    loadPublishedPosts: false,
    capturePages: false,
  });
  assert(r7.status === "success", "draftMeta 없는 케이스 실패");
  if (r7.status === "success") {
    assert(r7.topic.manuscript.tags.join(",") === "가,나,다", `본문 끝 해시태그에서 태그를 복구해야 한다 (${JSON.stringify(r7.topic.manuscript.tags)})`);
    assert(r7.topic.manuscript.searchDescription === null && r7.topic.manuscript.slug === null, "메타가 없으면 null");
  }
  assert(metaPatches.length === 0, `기준 원고를 그대로 쓰므로 job.metadata를 쓰지 않는다 (${metaPatches.length})`);
  console.log("✅ draftMeta 없으면 본문 해시태그로 태그 복구, 메타 저장 없음");

  // 8) 재사용 시 job.metadata.channelMeta에 저장된 값이 있으면 tags 등을 복구해야 한다.
  const r8 = await prepareManuscript(
    job("a", "living", {
      channelMeta: { blogspot: { searchDescription: "복구된 설명", slug: null, tags: ["복구1", "복구2", "복구3"] } },
    }),
    {
      loadArticles: async () => [baseArticle(), variantArticle(2)],
      writeManuscriptFile: async () => {},
      generateImages: false,
      collectWebImages: false,
    loadPublishedPosts: false,
      capturePages: false,
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
    writeManuscriptFile: async () => {},
    generateImages: false,
    collectWebImages: false,
    loadPublishedPosts: false,
    capturePages: false,
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
    loadArticles: async () => [baseArticle("본문\n[IMAGE: 설명 — 웹 검색]\n계속")],
    writeManuscriptFile: async () => {},
    mergeJobMetadata: async (_id, patch) => {
      imagePatches.push(patch);
    },
    collectWebImages: false,
    loadPublishedPosts: false,
    capturePages: false,
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

  // 10-1) 수정 반영(job:revise)으로 기준 원고가 과거 배리에이션보다 **나중에** 생기면 기준 원고가 최종본이다.
  const revisedBase = { ...baseArticle("수정 반영된 기준 원고입니다."), id: 30 } as ArticleRow;
  const r10b = await prepareManuscript(job("a", "living"), {
    loadArticles: async () => [variantArticle(2), revisedBase],
    writeManuscriptFile: async () => {},
    mergeJobMetadata: async () => {},
    collectWebImages: false,
    loadPublishedPosts: false,
    capturePages: false,
    generateImages: async () => noImages(),
  });
  assert(r10b.status === "success", "수정 반영 케이스 실패");
  if (r10b.status === "success") {
    assert(r10b.topic.manuscript.body.includes("수정 반영된"), "수정된 기준 원고를 최종본으로 써야 한다");
  }
  console.log("✅ 기준 원고가 수정되면 그 원고가 최종본");

  // 11) prepareApprovedManuscripts - 이미 준비된 job은 건너뛴다 + 페이지 갱신 시 배포 호출
  const marks: Array<{ id: string; patch: Record<string, unknown> }> = [];
  let manifestSaved: ManuscriptManifest | null = null;
  let pageHtml: string | null = null;
  let deployCalled = false;
  const r11 = await prepareApprovedManuscripts({
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

  // 13) 준비 단계는 Blogger에 아무것도 올리지 않는다(2026-09-19 사용자 결정). 원고 준비 결과는
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
  });
  // 2026-09-19: 준비 단계는 **Blogger에 아무것도 올리지 않는다**(사용자 결정). 전에는 여기서
  // 초안으로 올렸는데, 그러면 발행 버튼이 "이미 올라가 있음"에 막혀 매번 사람이 Blogger에서
  // 수동 공개해야 했다. 실제 업로드는 알림의 발행 버튼을 누른 순간에만 일어난다.
  assert(publishCalls.length === 0, "준비 단계에서 Blogger를 호출하면 안 된다");
  assert(r13.find((r) => r.job.id === "ok")?.result.status === "success", "준비 결과는 그대로 success여야 한다");
  console.log("✅ 준비 단계는 Blogger에 올리지 않는다(발행은 버튼을 누른 순간에만)");

  // 2026-09-18: `웹 검색` 자리를 파이프라인에서 채운다. 어제까지 이 경로는 Codex CLI 전용이라
  // 러너에서 실행 자체가 불가능했고, 그래서 웹 검색 자리가 전부 빈 채로 발행 대기에 올라갔다.
  {
    const calls: number[][] = [];
    const merged: Record<string, unknown>[] = [];
    const webResult = await prepareManuscript(job("web", "living", { imagePrompts: ["카페 카운터 검색어"] }), {
      loadArticles: async () => [baseArticle()],
      writeManuscriptFile: async () => {},
      mergeJobMetadata: async (_id, patch) => {
        merged.push(patch);
      },
      generateImages: async () => ({
        images: [
          { index: 2, description: "커피", prompt: "p", url: "https://s/2.png", provider: "openai", fileName: "02.png" },
        ],
        failures: [],
      }),
      capturePages: false,
      loadPublishedPosts: false,
      collectWebImages: async (input) => {
        calls.push(input.filledIndexes);
        return {
          images: [
            {
              index: 1,
              description: "카페 카운터 사진",
              prompt: null,
              url: "https://s/web-1.jpg",
              provider: "web",
              fileName: "01-cafe.jpg",
              error: null,
              sourcePage: "https://example.com/a",
              license: "공공누리 제1유형",
            },
          ],
          failures: [],
          unfilled: [],
        };
      },
      buildFallbackPrompts: false,
    });

    assert(webResult.status === "success", `성공해야 한다 (${JSON.stringify(webResult)})`);
    assert(calls.length === 1, "웹 검색 수집이 호출돼야 한다");
    // 2026-09-17 저녁: 웹 자리는 **웹에서 온 이미지(sourcePage)** 가 있을 때만 채워진 것으로 넘긴다.
    // 자리 2의 AI 생성 이미지는 sourcePage가 없으므로 목록에 없어야 한다(AI 폴백으로 메운 웹 자리도
    // 다시 찾게 하기 위해서다).
    assert(
      calls[0].length === 0,
      `웹에서 온 이미지가 없으면 건너뛸 자리가 없어야 한다 (${JSON.stringify(calls[0])})`
    );

    const webPatch = merged.find((patch) => "webImagesReadyAt" in patch);
    assert(webPatch, "webImagesReadyAt 게이트가 기록돼야 한다(재실행 시 중복 수집 방지)");
    const savedImages = (webPatch?.images ?? []) as { index: number; sourcePage?: string | null }[];
    assert(savedImages.length === 2, `생성분과 수집분이 합쳐져야 한다 (${JSON.stringify(savedImages)})`);
    assert(savedImages[0].index === 1 && savedImages[1].index === 2, "자리 번호 순으로 정렬돼야 한다");
    assert(savedImages[0].sourcePage === "https://example.com/a", "출처가 보존돼야 한다(발행 시 표기 필요)");
    console.log("✅ 웹 검색 자리 수집 - 생성분과 병합 + 출처 보존 + 재수집 게이트");
  }

  // 12) 내부 링크가 원고 본문(.md 파일)에 들어간다(2026-09-22). 2026-09-30부터 DB 행은 건드리지 않는다.
  //     서치콘솔이 우리 글을 전부 "참조 페이지 없음"으로 보던 문제 - 본문 내부 링크가 0개였다.
  {
    let savedContent = "";
    const result = await prepareManuscript(job("a", "entertainment"), {
      loadArticles: async () => [baseArticle("본문입니다.\n\n**참고 자료**\n- [출처](https://src.example.com/a)")],
      loadPublishedPosts: async () => [
        {
          jobId: "other",
          title: "관련 있는 지난 글",
          url: "https://b.example.com/old.html",
          keyword: "테스트 키워드 a 관련",
          category: "entertainment",
          publishedAt: "2026-09-20T00:00:00Z",
        },
      ],
      generateImages: false,
      collectWebImages: false,
      capturePages: false,
      writeManuscriptFile: async (_path, content) => {
        savedContent = content;
      },
      mergeJobMetadata: async () => ({}),
    });
    assert(result.status === "success", `내부 링크 경로 실패 (${JSON.stringify(result)})`);
    assert(savedContent.includes("https://b.example.com/old.html"), "원고 파일에 링크가 있어야 한다");
    assert(savedContent.includes("관련 있는 지난 글"), "앵커 텍스트가 글 제목이어야 한다");
    assert(
      savedContent.indexOf("함께 보면 좋은 글") < savedContent.indexOf("**참고 자료**"),
      "우리 글 링크가 바깥 출처보다 앞에 와야 한다"
    );
    console.log("✅ 내부 링크 - 원고 본문에 삽입, 참고 자료보다 앞");
  }

  // --- 이미지 기획 배선(2026-10-02, A안 3단계) -----------------------------------------------
  // 기획이 자리 배분과 검색어를 정하면 수집·캡처가 **그걸 쓴다**. 마커의 획득 방식은 보지 않는다.
  {
    const body = [
      "도입 문단입니다.",
      "[IMAGE: 공식 포스터 — 웹 검색]\n[IMAGE PROMPT: 집필자 검색어]",
      "둘째 문단입니다.",
      "[IMAGE: 기사 화면 — 웹 검색]\n[IMAGE PROMPT: 집필자 검색어 2]",
    ].join("\n\n");

    let collectInput: Record<string, unknown> | null = null;
    let captureInput: Record<string, unknown> | null = null;
    const merged: Record<string, unknown>[] = [];

    await prepareManuscript(job("a", "entertainment"), {
      loadArticles: async () => [baseArticle(body)],
      writeManuscriptFile: async () => {},
      mergeJobMetadata: async (_id, patch) => { merged.push(patch); },
      generateImages: false,
      loadPublishedPosts: false,
      planSlots: async () => ({
        plan: {
          summary: "예고편 공개",
          protagonist: "김윤석",
          slots: [
            { index: 1, subject: "예고편 장면", queries: ["영화 폭설 김윤석 구교환 예고편"], acquisition: "search" as const, changed: true, reason: "한 줄 요약이 예고편 공개다", caution: "포스터 말고 예고편" },
            { index: 2, subject: "기사 화면", queries: ["https://example.com/news/1"], acquisition: "capture" as const, changed: true, reason: "그 페이지가 답이다", caution: "" },
          ],
        },
        notes: ["ℹ️ 이미지 기획: 이 원고의 한 줄은 \"예고편 공개\"입니다."],
      }),
      capturePages: async (input) => { captureInput = input as never; return { images: [], failures: [] }; },
      collectWebImages: async (input) => { collectInput = input as never; return { images: [], failures: [], unfilled: [] }; },
    });

    assert(collectInput, "수집기가 불려야 한다");
    assert(
      JSON.stringify((collectInput as never as { planSearchIndexes: number[] }).planSearchIndexes) === "[1]",
      `기획이 웹 검색으로 정한 자리만 넘겨야 한다 (${JSON.stringify((collectInput as never as Record<string, unknown>).planSearchIndexes)})`
    );
    const queries = (collectInput as never as { planQueries: Record<number, string[]> }).planQueries;
    assert(queries[1][0] === "영화 폭설 김윤석 구교환 예고편", "기획 검색어를 넘겨야 한다(집필자 검색어가 아니다)");
    const subjects = (collectInput as never as { planSubjects: Record<number, { subject: string; caution?: string }> }).planSubjects;
    assert(subjects?.[1]?.subject === "예고편 장면", "기획 대상을 넘겨야 한다 - 안 넘기면 판정이 마커 원문으로 한다(오세훈 2심 사고)");
    assert(subjects[1].caution === "포스터 말고 예고편", "기획 주의사항을 넘겨야 한다");
    assert(
      (captureInput as never as { planUrls: Record<number, string> }).planUrls[2] === "https://example.com/news/1",
      "기획이 캡처로 정한 자리의 URL을 넘겨야 한다"
    );
    assert(merged.some((m) => m.imagePlan && m.imagePlanReadyAt), "기획 결과를 metadata에 남겨야 한다");
    console.log("✅ 기획 배선 - 자리 배분·검색어·캡처 URL이 기획을 따른다");
  }

  // 기획이 인포그래픽으로 정한 자리는 **실제로 생성된다**(2026-10-02). 전에는 어느 경로에도 안 실려
  // "기획이 바꿨습니다 → AI"라고 적힌 자리가 그냥 비었다(오세훈 2심 3번). 기획에 없는 자리는 마커대로.
  {
    const body = [
      "벌금 100만 원 이상이 확정되면 시장직을 잃습니다.",
      "[IMAGE: 시장직 상실 기준 — 웹 검색]\n[IMAGE PROMPT: 시장직 상실]",
      "기획에 없는 자리입니다.",
      "[IMAGE: 오세훈 시장 활동 — 웹 검색]\n[IMAGE PROMPT: 오세훈 시장 활동]",
    ].join("\n\n");
    const INFO = '"벌금 100만 원 이상 확정" → "피선거권 상실" → "시장직 상실" 아이콘 흐름. 위에 적은 글자 외에는 넣지 마. 16:9';
    const genCalls: { fallbackSlots?: { index: number; acquisition?: string }[] }[] = [];
    let collectInput: Record<string, unknown> | null = null;
    const merged: Record<string, unknown>[] = [];

    await prepareManuscript(job("a", "incident"), {
      loadArticles: async () => [baseArticle(body)],
      writeManuscriptFile: async () => {},
      mergeJobMetadata: async (_id, patch) => { merged.push(patch); },
      loadPublishedPosts: false,
      capturePages: false,
      buildFallbackPrompts: false,
      generateImages: async (_input, options) => {
        genCalls.push(options ?? {});
        const slots = options?.fallbackSlots ?? [];
        return {
          images: slots.map((s) => ({ index: s.index, description: "인포그래픽", prompt: "p", url: `https://s/${s.index}.png`, provider: "openai", fileName: "x.png" })) as never,
          failures: [],
        };
      },
      planSlots: async () => ({
        plan: {
          summary: "구형",
          protagonist: "오세훈",
          slots: [{ index: 1, subject: "정치자금법 처벌 흐름", queries: [INFO], acquisition: "infographic" as const, changed: true, reason: "법률 기준", caution: "" }],
        },
        notes: [],
      }),
      collectWebImages: async (input) => { collectInput = input as never; return { images: [], failures: [], unfilled: [] }; },
    });

    const planGen = genCalls.find((c) => c.fallbackSlots?.some((s) => s.index === 1));
    assert(planGen, `기획 인포그래픽 자리가 생성으로 가야 한다 (${JSON.stringify(genCalls)})`);
    assert(planGen!.fallbackSlots![0].acquisition === "infographic", "인포그래픽 화질로 뽑도록 방식을 넘겨야 한다");
    assert(merged.some((m) => m.planImagesGeneratedAt), "유료 생성 1회 게이트를 남겨야 한다");
    const idx = (collectInput as never as { planSearchIndexes: number[] }).planSearchIndexes;
    assert(JSON.stringify(idx) === "[2]", `기획에 없는 웹 검색 자리는 마커대로 수집해야 한다 (${JSON.stringify(idx)})`);
    console.log("✅ 기획 인포그래픽 → 생성, 기획 밖 자리 → 마커대로 수집");
  }

  // 사용자가 이미지 수정에서 AI 생성을 지시한 자리는 **만든다**(2026-10-03 대구 북구 실측).
  // 다른 자리가 이미 차 있어도, 기획이 그 자리를 "비운다"·"웹 검색"으로 정해 두었어도 사용자 지시가 이긴다.
  // 그리고 그 자리는 웹 수집에 다시 태우지 않는다(만든 그림이 덮인다).
  {
    const body = [
      "첫 문단.", "[IMAGE: 자리 1 — 웹 검색]\n[IMAGE PROMPT: 검색어 1]",
      "주민들이 구청을 찾아가 항의했다.", "[IMAGE: 구청 민원실 항의 — AI 생성]\n[IMAGE PROMPT: 구청 민원실 주민 항의]",
      "업혀 이동했다.", "[IMAGE: 업혀 가는 장면 — 웹 검색]\n[IMAGE PROMPT: 사건반장 업혀]",
    ].join("\n\n");
    const genCalls: { fallbackSlots?: { index: number; acquisition?: string }[] }[] = [];
    let fallbackInput: { unfilled: { index: number; userRequested?: boolean }[] } | null = null;
    let collectInput: Record<string, unknown> | null = null;
    const merged: Record<string, unknown>[] = [];
    await prepareManuscript(
      job("a", "incident", {
        images: [{ index: 1, description: "현장", prompt: null, url: "https://s/1.jpg", provider: "web", fileName: "1.jpg", sourcePage: "https://x" }],
        imageRequirements: { "2": "주민 항의 장면 AI로 생성하세요", "3": "업혀가는 공무원 AI로 생성하세요" },
        imagePlanReadyAt: "2026-10-03T00:00:00Z",
        imagePlan: {
          summary: "s", protagonist: "p",
          slots: [
            { index: 2, subject: "항의", queries: [], acquisition: "search", changed: true, reason: "비운다", caution: "" },
            { index: 3, subject: "업혀 가는 장면", queries: ["사건반장 업혀"], acquisition: "search", changed: true, reason: "", caution: "" },
          ],
        },
      }),
      {
        loadArticles: async () => [baseArticle(body)],
        writeManuscriptFile: async () => {},
        mergeJobMetadata: async (_id, patch) => { merged.push(patch); },
        loadPublishedPosts: false,
        capturePages: false,
        planSlots: false,
        buildFallbackPrompts: async (input) => {
          fallbackInput = input as never;
          return { slots: input.unfilled.map((u) => ({ index: u.index, description: u.description, prompt: "photorealistic photograph in Korea, no text, 16:9" })), failures: [] };
        },
        generateImages: async (_input, options) => {
          genCalls.push(options ?? {});
          const slots = options?.fallbackSlots ?? [];
          return { images: slots.map((s) => ({ index: s.index, description: "AI", prompt: "p", url: `https://s/ai-${s.index}.png`, provider: "openai", fileName: "x.png" })) as never, failures: [] };
        },
        collectWebImages: async (input) => { collectInput = input as never; return { images: [], failures: [], unfilled: [] }; },
      }
    );
    const fb = fallbackInput as { unfilled: { index: number; userRequested?: boolean }[] } | null;
    assert(fb && fb.unfilled.map((u) => u.index).join(",") === "2,3", `지시한 두 자리 모두 AI 프롬프트로 (${JSON.stringify(fb?.unfilled)})`);
    assert(fb!.unfilled.every((u) => u.userRequested), "사용자 지시임을 표시해야 한다(결정론적 SKIP 우회)");
    const userGen = genCalls.find((c) => c.fallbackSlots?.some((s) => s.index === 2));
    assert(userGen && userGen.fallbackSlots!.every((s) => s.acquisition === "ai"), "생성까지 가야 한다");
    const filled = (collectInput as never as { filledIndexes: number[] }).filledIndexes;
    assert(filled.includes(2) && filled.includes(3), `AI로 정한 자리는 웹 수집에서 뺀다 (${JSON.stringify(filled)})`);
    console.log("✅ 사용자 AI 지시 - 다른 자리가 차 있어도·기획이 비우라 해도 생성, 웹 수집에서 제외");
  }

  // 기획을 끄면 예전 경로 그대로다. 운영 영향 없이 병합하려면 이게 보장돼야 한다.
  {
    const body = "도입입니다.\n\n[IMAGE: 사진 — 웹 검색]\n[IMAGE PROMPT: 집필자 검색어]";
    let collectInput: Record<string, unknown> | null = null;
    await prepareManuscript(job("a", "entertainment"), {
      loadArticles: async () => [baseArticle(body)],
      writeManuscriptFile: async () => {},
      mergeJobMetadata: async () => {},
      generateImages: false,
      loadPublishedPosts: false,
      capturePages: false,
      planSlots: false,
      collectWebImages: async (input) => { collectInput = input as never; return { images: [], failures: [], unfilled: [] }; },
    });
    const withoutPlan = collectInput as never as Record<string, unknown>;
    assert(withoutPlan.planSearchIndexes === undefined, "기획이 꺼지면 자리 배분을 넘기지 않아야 한다");
    assert(withoutPlan.planQueries === undefined, "기획이 꺼지면 검색어도 넘기지 않아야 한다");
    assert(withoutPlan.planSubjects === undefined, "기획이 꺼지면 대상도 넘기지 않아야 한다");
    console.log("✅ 기획 off - 예전 경로 그대로");
  }

  // 사용설명서 영어본(job.metadata.translation.articleId === 영어 article): 마커 설명이 영어라 한글 기준 원고와 토큰이
  // 안 겹친다. alignImagePrompts에 맡기면 전부 "대응 없음"으로 검색어가 비워지므로, 번역 단계가 순서를 보존한다는 전제로
  // 번호순 그대로 넘겨야 한다. 일반 배리에이션(영어본 표식 없음)은 기존 정렬 경로를 그대로 탄다.
  {
    const koBase = baseArticle("도입\n\n[IMAGE: 편의점 계산대 — 웹 검색]\n\n본문\n\n[IMAGE: T-money card — AI 생성]");
    const enVariant = {
      ...variantArticle(2),
      title: "English title",
      content: "Intro\n\n[IMAGE: T-money card counter — 웹 검색]\n\nBody\n\n[IMAGE: Top-up machine screen — AI 생성]",
    } as ArticleRow;
    const seen: Record<string, string[]> = {};
    const run = async (label: string, metadata: Record<string, unknown>) =>
      prepareManuscript(job("kscene", "kscene", { imagePrompts: ["T-money 편의점", "topup machine screen, no text"], ...metadata }), {
        loadArticles: async () => [koBase, enVariant],
        writeManuscriptFile: async () => {},
        mergeJobMetadata: async () => {},
        collectWebImages: false,
        loadPublishedPosts: false,
        capturePages: false,
        planSlots: false,
        generateImages: async (input) => {
          seen[label] = [...input.imagePrompts];
          return { images: [], failures: [] };
        },
      });
    const translated = await run("translated", { translation: { articleId: 2 }, channelMeta: { blogspot: { searchDescription: "x", slug: "s", tags: ["a"] } } });
    assert(translated.status === "success" && translated.topic.manuscript.title === "English title", "영어본을 최종 원고로 쓴다");
    assert(seen.translated.join("|") === "T-money 편의점|topup machine screen, no text", `영어본은 검색어를 번호순 그대로 넘긴다 (${JSON.stringify(seen.translated)})`);
    await run("plain", {});
    // 대조군: 영어 설명 1번이 한글 2번 설명과 토큰("money", "card")을 공유해 자카드 0.3을 넘는다 - 표식이 없으면 기존 정렬이 둘을 짝지어
    // 검색어가 뒤바뀐다(이게 우회하려는 사고다).
    assert(seen.plain.join("|") === "topup machine screen, no text|", `영어본 표식이 없으면 기존 정렬 경로를 그대로 탄다 - 공유 토큰으로 검색어가 뒤바뀌고 한 자리는 비워진다 (${JSON.stringify(seen.plain)})`);
    console.log("✅ 사용설명서 영어본 - 이미지 검색어를 번호순으로 보존(한글 설명과의 토큰 정렬 우회)");
  }

  console.log("\n✅ 전체 통과");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
