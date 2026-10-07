// 뷰어 수정본 반영 계산부·적용부 테스트. 실행: npm run test:viewer-edits
// DB·네트워크를 쓰지 않는다(적용부는 가짜 저장소를 주입한다).
//
// 지켜야 할 것:
//  ① 고친 문단이 발행 원고(articles.content)의 **같은 문단**에 들어간다 - 번호가 아니라 원문으로 찾는다
//     (발행 원고에는 끝 해시태그가 있고, 뷰어 본문에는 내부 링크가 더 붙어 있다).
//  ② 고치지 않은 부분은 글자 그대로다(해시태그 줄 포함).
//  ③ 같은 문장이 두 번 나오면 몇 번째인지까지 맞춘다.
//  ④ from이 지금 원고와 다르면 건너뛴다(페이지를 연 뒤 원고가 다시 준비된 경우).
//  ⑤ 뷰어에만 있는 블록(내부 링크)은 건너뛰고 사유를 남긴다.
//  ⑥ 이미지 마커를 넣는 수정은 건너뛴다(뒤 이미지 번호가 밀린다).
//  ⑦ 캡션은 이미지가 있는 자리만 바뀐다. 빈 자리는 사유를 남긴다.
//  ⑧ 적용부: 본문 -> 메타데이터 -> manifest -> 배포 순서로 쓰고, 캡션은 job.metadata.images에도 들어간다.
import { applyViewerEdits } from "./applyViewerEdits.js";
import { applyViewerEditRequest, parseViewerEditRequest } from "./applyViewerEditRequest.js";
import type { ManuscriptImage, ManuscriptManifest, ManuscriptTopicEntry } from "./manuscriptManifest.js";
import type { ArticleJobRow, ArticleRow } from "../../types/database.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const ARTICLE = [
  "도입 문단입니다.",
  "[IMAGE: 첫 자리 — 웹 검색]",
  "**소제목 하나**\n소제목 아래 문단입니다.",
  "같은 문장입니다.",
  "[IMAGE: 둘째 자리 — AI 생성]",
  "같은 문장입니다.",
  "마무리 문단입니다.",
  "#태그1 #태그2",
].join("\n\n");

// 뷰어 본문 = 해시태그 빠짐 + 내부 링크 붙음(prepareManuscript와 같은 모양).
const MANIFEST = [
  "도입 문단입니다.",
  "[IMAGE: 첫 자리 — 웹 검색]",
  "**소제목 하나**\n소제목 아래 문단입니다.",
  "같은 문장입니다.",
  "[IMAGE: 둘째 자리 — AI 생성]",
  "같은 문장입니다.",
  "마무리 문단입니다.",
  "**함께 보면 좋은 글**\n- [다른 글](https://example.com/a)",
].join("\n\n");

const IMAGES: ManuscriptImage[] = [
  { index: 1, description: "수집된 첫 캡션", prompt: null, url: "https://x/1.jpg", provider: "web", fileName: "01.jpg" },
];

function run(edits: Record<string, { from: string; to: string }>) {
  return applyViewerEdits({ manifestBody: MANIFEST, imagePrompts: [], articleContent: ARTICLE, images: IMAGES, edits });
}

async function main(): Promise<void> {
  console.log("▶ 뷰어 수정본 반영 테스트 시작\n");

  // ① ② 문단·소제목
  {
    const r = run({
      "0": { from: "도입 문단입니다.", to: "고친 도입입니다." },
      "2:h": { from: "소제목 하나", to: "고친 소제목" },
      "2:b": { from: "소제목 아래 문단입니다.", to: "고친 소제목 본문입니다." },
    });
    assert(r.applied.length === 3 && r.skipped.length === 0, `셋 다 반영돼야 한다 (${JSON.stringify(r)})`);
    assert(r.articleContent.startsWith("고친 도입입니다.\n\n[IMAGE: 첫 자리 — 웹 검색]"), "도입 문단이 바뀌어야 한다");
    assert(r.articleContent.includes("**고친 소제목**\n고친 소제목 본문입니다."), `소제목 블록 표기가 유지돼야 한다\n${r.articleContent}`);
    assert(r.articleContent.endsWith("마무리 문단입니다.\n\n#태그1 #태그2"), "해시태그 줄은 그대로여야 한다");
    assert(!r.articleContent.includes("함께 보면 좋은 글"), "뷰어에만 있는 내부 링크가 발행 원고로 새면 안 된다");
    assert(r.manifestBody.includes("함께 보면 좋은 글"), "뷰어 본문의 내부 링크는 남아야 한다");
    assert(r.manifestBody.startsWith("고친 도입입니다."), "뷰어 본문도 같이 바뀌어야 한다");
    assert(r.articleChanged && !r.imagesChanged, "본문만 바뀌었다");
  }
  console.log("✅ 문단·소제목이 발행 원고의 같은 자리에 들어가고, 해시태그·내부 링크는 제자리");

  // ③ 같은 문장이 두 번 - 블록 5(두 번째)를 고치면 두 번째만 바뀐다.
  {
    const r = run({ "5": { from: "같은 문장입니다.", to: "두 번째만 고쳤습니다." } });
    const blocks = r.articleContent.split("\n\n");
    assert(blocks[3] === "같은 문장입니다." && blocks[5] === "두 번째만 고쳤습니다.", `몇 번째인지 맞춰야 한다\n${r.articleContent}`);
  }
  console.log("✅ 같은 문장이 여러 번이면 몇 번째인지까지 맞춘다");

  // 앞 블록을 먼저 고쳐도 뒤 블록의 "몇 번째"가 흔들리지 않는다(원문을 미리 떠 둔다).
  {
    const r = run({
      "3": { from: "같은 문장입니다.", to: "첫 번째를 고쳤습니다." },
      "5": { from: "같은 문장입니다.", to: "두 번째를 고쳤습니다." },
    });
    const blocks = r.articleContent.split("\n\n");
    assert(blocks[3] === "첫 번째를 고쳤습니다." && blocks[5] === "두 번째를 고쳤습니다.", `둘 다 제자리에\n${r.articleContent}`);
  }
  console.log("✅ 같은 문장 두 곳을 한 번에 고쳐도 제자리");

  // ④ from 불일치
  {
    const r = run({ "0": { from: "옛날 도입", to: "새 도입" } });
    assert(r.applied.length === 0 && r.skipped[0]?.reason.includes("바뀌었습니다"), `from이 다르면 건너뛴다 (${JSON.stringify(r.skipped)})`);
    assert(!r.articleChanged && r.articleContent === ARTICLE, "원고는 그대로여야 한다");
  }
  console.log("✅ 페이지를 연 뒤 원고가 바뀌었으면 건너뛴다");

  // ⑤ 내부 링크 블록
  {
    const r = run({ "7:b": { from: "- [다른 글](https://example.com/a)", to: "- [바꾼 글](https://example.com/b)" } });
    assert(r.applied.length === 0 && r.skipped[0]?.reason.includes("찾지 못했습니다"), `뷰어 전용 블록은 건너뛴다 (${JSON.stringify(r.skipped)})`);
  }
  console.log("✅ 뷰어에만 있는 블록은 사유를 남기고 건너뛴다");

  // ⑥ 마커 주입
  {
    const r = run({ "6": { from: "마무리 문단입니다.", to: "마무리입니다.\n\n[IMAGE: 몰래 넣은 자리 — AI 생성]" } });
    assert(r.applied.length === 0 && r.skipped[0]?.reason.includes("마커"), `마커를 넣으면 건너뛴다 (${JSON.stringify(r.skipped)})`);
  }
  console.log("✅ 이미지 마커를 넣는 수정은 건너뛴다");

  // 문단을 비우면 지운다.
  {
    const r = run({ "6": { from: "마무리 문단입니다.", to: "" } });
    assert(!r.articleContent.includes("마무리 문단입니다.") && !/\n{3,}/.test(r.articleContent), `빈 문단은 지우고 빈 줄을 정리한다\n${r.articleContent}`);
    assert(r.articleContent.endsWith("같은 문장입니다.\n\n#태그1 #태그2"), "해시태그 앞이 정리돼야 한다");
  }
  console.log("✅ 문단을 비우면 그 문단을 지운다");

  // ⑦ 캡션
  {
    const r = run({
      "cap:1": { from: "수집된 첫 캡션", to: "고친 첫 캡션" },
      "cap:2": { from: "둘째 자리", to: "빈 자리 캡션" },
    });
    assert(r.applied.includes("cap:1") && r.images[0].description === "고친 첫 캡션", "이미지가 있는 자리 캡션은 바뀐다");
    assert(r.skipped.some((s) => s.key === "cap:2" && s.reason.includes("비어 있어")), `빈 자리는 사유를 남긴다 (${JSON.stringify(r.skipped)})`);
    assert(r.imagesChanged && !r.articleChanged, "캡션만 바뀌었다");
  }
  console.log("✅ 캡션은 이미지가 있는 자리만 바뀌고, 빈 자리는 사유를 남긴다");

  // 같은 값(공백·nbsp 차이만)은 조용히 넘긴다.
  {
    const r = run({ "0": { from: "도입 문단입니다.", to: "도입 문단입니다.  " } });
    assert(r.applied.length === 0 && r.skipped.length === 0 && !r.articleChanged, "공백 차이는 수정이 아니다");
  }
  console.log("✅ 공백·nbsp 차이는 수정으로 보지 않는다");

  // 같은 수정을 두 번 보내면(새로고침 전에 반영을 또 누름) 두 번째는 "이미 반영됨"이다 - 건너뜀으로 세지 않는다.
  {
    const captioned = IMAGES.map((image) => ({ ...image, description: "고친 첫 캡션" }));
    const again = applyViewerEdits({
      manifestBody: MANIFEST.replace("도입 문단입니다.", "고친 도입입니다."),
      imagePrompts: [],
      articleContent: ARTICLE.replace("도입 문단입니다.", "고친 도입입니다."),
      images: captioned,
      edits: {
        "cap:1": { from: "수집된 첫 캡션", to: "고친 첫 캡션" },
        "0": { from: "도입 문단입니다.", to: "고친 도입입니다." },
      },
    });
    assert(again.skipped.length === 0 && again.applied.length === 0, `이미 반영된 수정은 건너뜀이 아니다 (${JSON.stringify(again.skipped)})`);
    assert(!again.articleChanged && !again.imagesChanged, "아무것도 다시 쓰지 않는다");
  }
  console.log("✅ 같은 수정을 다시 보내면 이미 반영됨으로 조용히 넘긴다");

  // ⑨ 제목(2026-10-07) - 키 "title". 뷰어가 본 제목(manifest)과 대조하고, 한 줄로 접고, 비우거나 너무 길면 건너뛴다.
  {
    const base = { manifestBody: MANIFEST, imagePrompts: [], articleContent: ARTICLE, images: IMAGES, manifestTitle: "옛 제목" };
    const ok = applyViewerEdits({ ...base, edits: { title: { from: "옛 제목", to: "새 제목\n둘째 줄" } } });
    assert(ok.titleChanged && ok.title === "새 제목 둘째 줄" && ok.applied.includes("title"), `제목 반영·한 줄로 접기 (${JSON.stringify(ok.title)})`);
    assert(!ok.articleChanged && ok.articleContent === ARTICLE, "제목 수정은 본문을 건드리지 않는다");
    const stale = applyViewerEdits({ ...base, edits: { title: { from: "다른 제목", to: "새 제목" } } });
    assert(!stale.titleChanged && stale.skipped[0]?.key === "title" && stale.title === "옛 제목", "from이 지금 제목과 다르면 건너뛴다");
    const again = applyViewerEdits({ ...base, manifestTitle: "새 제목", edits: { title: { from: "옛 제목", to: "새 제목" } } });
    assert(!again.titleChanged && again.skipped.length === 0, "이미 반영된 제목을 다시 보내면 조용히 넘긴다");
    const empty = applyViewerEdits({ ...base, edits: { title: { from: "옛 제목", to: "  " } } });
    assert(!empty.titleChanged && empty.skipped[0]?.reason.includes("비울"), "제목을 비울 수 없다");
    const long = applyViewerEdits({ ...base, edits: { title: { from: "옛 제목", to: "가".repeat(201) } } });
    assert(!long.titleChanged && long.skipped[0]?.reason.includes("너무 깁니다"), "너무 긴 제목은 건너뛴다");
    const noTitle = applyViewerEdits({ manifestBody: MANIFEST, imagePrompts: [], articleContent: ARTICLE, images: IMAGES, edits: { title: { from: "a", to: "b" } } });
    assert(!noTitle.titleChanged && noTitle.skipped.length === 1, "제목 정보가 없으면 건너뛴다");
    const mixed = applyViewerEdits({ ...base, edits: { title: { from: "옛 제목", to: "새 제목" }, "0": { from: "도입 문단입니다.", to: "고친 도입입니다." } } });
    assert(mixed.titleChanged && mixed.articleChanged && mixed.applied.length === 2, "제목과 본문을 함께 고칠 수 있다");
  }
  console.log("✅ 제목 - 반영·대조·한 줄·빈 값·길이·본문과 공존");

  // 요청 검증
  {
    let threw = false;
    try {
      parseViewerEditRequest({ jobId: "nope", edits: { "0": { from: "a", to: "b" } } });
    } catch {
      threw = true;
    }
    assert(threw, "jobId가 UUID가 아니면 거부");
    threw = false;
    try {
      parseViewerEditRequest({ jobId: "054bfe0b-1234-4abc-8def-0123456789ab", edits: { "../x": { from: "a", to: "b" } } });
    } catch {
      threw = true;
    }
    assert(threw, "모르는 키는 거부");
    const ok = parseViewerEditRequest(JSON.stringify({ jobId: "054bfe0b-1234-4abc-8def-0123456789ab", edits: { "cap:1": { from: "a", to: "b" } } }));
    assert(ok.edits["cap:1"].to === "b", "정상 요청은 통과");
    assert(parseViewerEditRequest({ jobId: "054bfe0b-1234-4abc-8def-0123456789ab", edits: { title: { from: "a", to: "b" } } }).edits.title.to === "b", "title 키는 통과");
  }
  console.log("✅ 요청 검증 - jobId·키 형식");

  // ⑧ 적용부
  {
    const jobId = "054bfe0b-1234-4abc-8def-0123456789ab";
    const job = { id: jobId, keyword: "키워드", metadata: { images: IMAGES } } as unknown as ArticleJobRow;
    const article = { id: 42, job_id: jobId, platform: null, content: ARTICLE, title: "제목" } as unknown as ArticleRow;
    const topic: ManuscriptTopicEntry = {
      jobId,
      keyword: "키워드",
      category: "living",
      date: "2026-10-03",
      readyAt: "2026-10-03T00:00:00.000Z",
      manuscript: {
        title: "제목",
        searchDescription: null,
        slug: null,
        tags: ["태그1", "태그2"],
        body: MANIFEST,
        imagePrompts: [],
        images: IMAGES,
        filePath: "x.md",
      },
    };
    const other: ManuscriptTopicEntry = { ...topic, jobId: "11111111-1234-4abc-8def-0123456789ab" };
    const calls: string[] = [];
    let savedContent = "";
    let metaPatch: Record<string, unknown> = {};
    const pendingPatches: Record<string, unknown>[] = [];
    let savedTopic: ManuscriptTopicEntry | null = null;
    let published: ManuscriptManifest | null = null;

    const outcome = await applyViewerEditRequest(
      {
        jobId,
        edits: {
          "0": { from: "도입 문단입니다.", to: "고친 도입입니다." },
          "cap:1": { from: "수집된 첫 캡션", to: "고친 첫 캡션" },
        },
      },
      {
        loadJob: async () => job,
        loadArticles: async () => [article],
        updateArticleContent: async (id, content) => {
          calls.push(`article:${id}`);
          savedContent = content;
        },
        mergeJobMetadata: async (_id, patch) => {
          calls.push("metadata");
          if ("viewerEditPendingAt" in patch) pendingPatches.push(patch);
          else metaPatch = patch;
        },
        loadManifest: async () => ({ topics: [topic, other] }),
        saveTopic: async (t) => {
          calls.push("manifest");
          savedTopic = t;
        },
        publishPage: async (m) => {
          calls.push("publish");
          published = m;
        },
        now: () => new Date("2026-10-03T10:00:00Z"),
      }
    );

    assert(outcome.status === "applied", `반영돼야 한다 (${JSON.stringify(outcome)})`);
    // 접수 표식(viewerEditPendingAt)이 가장 먼저 - 발행 폴러·텔레그램 콜백이 반영 중인 원고를 집지 않게(2026-10-07).
    assert(calls.join(",") === "metadata,article:42,metadata,manifest,publish", `쓰는 순서 (${calls.join(",")})`);
    assert(pendingPatches.length === 1 && pendingPatches[0].viewerEditPendingAt === "2026-10-03T10:00:00.000Z", "접수 표식 시각");
    assert(
      (metaPatch.viewerEdit as { appliedAt: string }).appliedAt >= (pendingPatches[0].viewerEditPendingAt as string),
      "완료 기록(appliedAt)이 접수 시각 이후라 가드가 풀린다"
    );
    assert(savedContent.startsWith("고친 도입입니다.") && savedContent.endsWith("#태그1 #태그2"), "발행 원고에 반영");
    const metaImages = metaPatch.images as ManuscriptImage[];
    assert(metaImages?.[0]?.description === "고친 첫 캡션", "job.metadata.images 캡션도 바뀌어야 한다(발행이 읽는 쪽)");
    assert((metaPatch.viewerEdit as { applied: string[] }).applied.length === 2, "반영 기록을 남긴다");
    const st = savedTopic as ManuscriptTopicEntry | null;
    assert(st && st.manuscript.body.startsWith("고친 도입입니다.") && st.manuscript.images[0].description === "고친 첫 캡션", "뷰어 행도 바뀐다");
    assert(st && st.manuscript.viewerEdit?.appliedAt === "2026-10-03T10:00:00.000Z", "뷰어 행에 반영 시각");
    const pub = published as ManuscriptManifest | null;
    assert(pub && pub.topics.length === 2, "다른 원고도 그대로 다시 그린다");
  }
  console.log("✅ 적용부 - 본문 → 메타데이터 → manifest → 배포 순서, 캡션은 발행 쪽에도");

  // 반영할 게 없어도(전부 건너뜀) 기록을 남기고 다시 그린다 - 왜 안 들어갔는지 화면에 떠야 한다.
  {
    const jobId = "054bfe0b-1234-4abc-8def-0123456789ab";
    const calls: string[] = [];
    const outcome = await applyViewerEditRequest(
      { jobId, edits: { "0": { from: "옛날 도입", to: "새 도입" } } },
      {
        loadJob: async () => ({ id: jobId, metadata: {} }) as unknown as ArticleJobRow,
        loadArticles: async () => [{ id: 1, platform: null, content: ARTICLE } as unknown as ArticleRow],
        updateArticleContent: async () => {
          calls.push("article");
        },
        mergeJobMetadata: async () => {
          calls.push("metadata");
        },
        loadManifest: async () => ({
          topics: [{ jobId, keyword: "k", category: null, date: "d", readyAt: "r", manuscript: { title: "", searchDescription: null, slug: null, tags: [], body: MANIFEST, imagePrompts: [], images: [], filePath: "" } }],
        }),
        saveTopic: async () => {
          calls.push("manifest");
        },
        publishPage: async () => {
          calls.push("publish");
        },
      }
    );
    assert(outcome.status === "nothing", "반영할 것 없음");
    assert(!calls.includes("article"), "본문은 쓰지 않는다");
    assert(calls.includes("manifest") && calls.includes("publish"), "기록은 남기고 다시 그린다");
  }
  console.log("✅ 전부 건너뛰어도 사유를 남기고 다시 그린다(본문은 안 씀)");

  // 아무것도 쓰지 못하고 끝나는 실패는 접수 표식을 바로 푼다 - 안 풀면 10분 동안 발행이 막힌다(2026-10-07).
  {
    const jobId = "054bfe0b-1234-4abc-8def-0123456789ab";
    const patches: Record<string, unknown>[] = [];
    const outcome = await applyViewerEditRequest(
      { jobId, edits: { "0": { from: "a", to: "b" } } },
      {
        loadJob: async () => ({ id: jobId, metadata: {} }) as unknown as ArticleJobRow,
        loadArticles: async () => [],
        updateArticleContent: async () => {},
        mergeJobMetadata: async (_id, patch) => {
          patches.push(patch);
        },
        loadManifest: async () => ({
          topics: [{ jobId, keyword: "k", category: null, date: "d", readyAt: "r", manuscript: { title: "", searchDescription: null, slug: null, tags: [], body: MANIFEST, imagePrompts: [], images: [], filePath: "" } }],
        }),
        saveTopic: async () => {},
        publishPage: async () => {},
      }
    );
    assert(outcome.status === "failed", "article이 없으면 실패");
    assert(patches.length === 2 && typeof patches[0].viewerEditPendingAt === "string" && patches[1].viewerEditPendingAt === null, "실패하면 접수 표식을 바로 푼다");
  }
  console.log("✅ 일찍 실패하면 접수 표식을 푼다");

  // 제목 수정은 본문과 같은 final article 행에 쓰고 manifest 제목도 맞춘다(2026-10-07).
  {
    const jobId = "054bfe0b-1234-4abc-8def-0123456789ab";
    const old = { id: 7, job_id: jobId, platform: null, content: ARTICLE, title: "옛 제목" } as unknown as ArticleRow;
    const legacy = { id: 9, job_id: jobId, platform: "blogspot", content: ARTICLE, title: "옛 제목(변형)" } as unknown as ArticleRow;
    const titleWrites: { id: number; title: string }[] = [];
    let contentWrites = 0;
    let savedTopic: ManuscriptTopicEntry | null = null;
    const outcome = await applyViewerEditRequest(
      { jobId, edits: { title: { from: "옛 제목", to: "새 제목" } } },
      {
        loadJob: async () => ({ id: jobId, keyword: "k", metadata: {} }) as unknown as ArticleJobRow,
        loadArticles: async () => [old, legacy],
        updateArticleContent: async () => { contentWrites += 1; },
        updateArticleTitle: async (id, title) => { titleWrites.push({ id, title }); },
        mergeJobMetadata: async () => {},
        loadManifest: async () => ({
          topics: [{ jobId, keyword: "k", category: null, date: "d", readyAt: "r", manuscript: { title: "옛 제목", searchDescription: null, slug: "keep-slug", tags: [], body: MANIFEST, imagePrompts: [], images: [], filePath: "" } }],
        }),
        saveTopic: async (t) => { savedTopic = t; },
        publishPage: async () => {},
      }
    );
    assert(outcome.status === "applied" && outcome.titleChanged && !outcome.articleChanged, `제목만 반영 (${JSON.stringify(outcome)})`);
    assert(titleWrites.length === 1 && titleWrites[0].id === 9 && titleWrites[0].title === "새 제목", `발행이 읽는 final article 행(레거시 변형이 더 새것이면 그 행)에 쓴다 (${JSON.stringify(titleWrites)})`);
    assert(contentWrites === 0, "본문은 쓰지 않는다");
    const st = savedTopic as ManuscriptTopicEntry | null;
    assert(st?.manuscript.title === "새 제목" && st.manuscript.slug === "keep-slug", "manifest 제목만 바뀌고 slug 등은 그대로");
  }
  console.log("✅ 제목 적용부 - final article 행·manifest 동기화, 본문·slug 불변");

  console.log("\n✅ 뷰어 수정본 반영 테스트 전부 통과");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
