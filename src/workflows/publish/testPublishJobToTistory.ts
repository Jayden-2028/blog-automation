// publishJobToTistory 테스트. 브라우저·DB를 전부 주입해 오케스트레이션만 본다.
//
// 지켜야 할 것: ① 기본이 비공개 ② 같은 job을 두 번 올리지 않는다 ③ 이미지는 표식으로 바뀌어 업로드 목록으로 간다
// ④ 참고 자료는 남고 Blogspot 내부 링크는 빠진다 ⑤ 로그인 풀림은 failed 기록 없이 login_required ⑥ 실패는 기록한다
// ⑦ TISTORY_ENABLED가 꺼져 있으면 아무것도 안 한다.
import { publishJobToTistory, tistoryTagsFor } from "./publishJobToTistory.js";
import type { ArticleJobRow, ArticleRow, PublicationRow } from "../../types/database.js";
import type { TistoryPublishInput, TistoryPublishResult } from "../../services/publish/tistory/TistoryPublisher.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const IMG = "https://example.supabase.co/storage/v1/object/public/article-images/a.png";
const BODY = [
  "첫 문단입니다. ".repeat(10),
  "",
  "[IMAGE: 현장 사진 — 웹 검색]",
  "",
  "둘째 문단입니다. ".repeat(10),
  "",
  "**참고 자료**",
  "- [기사](https://news.example.com/1)",
  "",
  "**함께 보면 좋은 글**",
  "- [옛 글](https://whynowissue.blogspot.com/old)",
  "",
  "#사회 #이슈",
].join("\n");

function job(over: Partial<ArticleJobRow> = {}): ArticleJobRow {
  return {
    id: "job-1", keyword: "테스트 키워드", category: "living", status: "approved",
    metadata: { track: "social", images: [{ index: 1, description: "현장 사진", prompt: null, url: IMG, provider: null, fileName: "a.png" }] },
    created_at: "x", updated_at: "x", ...over,
  } as ArticleJobRow;
}
function article(over: Partial<ArticleRow> = {}): ArticleRow {
  return { id: 1, job_id: "job-1", title: "블로그 제목", content: BODY, status: "approved", ai_model: "claude", platform: null, created_at: "x", updated_at: "x", ...over } as ArticleRow;
}

const okPublish = async (): Promise<TistoryPublishResult> => ({ ok: true, url: "https://wooahpapa.tistory.com/entry/t", warnings: [] });
const baseDeps = {
  enabled: true,
  loadJob: async () => job(),
  loadArticles: async () => [article()],
  loadJobPublications: async () => [] as PublicationRow[],
  savePublication: async (i: { articleId: number; status: PublicationRow["status"]; publishedUrl: string | null }) =>
    ({ id: 9, article_id: i.articleId, platform: "tistory", status: i.status, published_url: i.publishedUrl, published_at: null, created_at: "x" }) as PublicationRow,
  publish: okPublish,
};

async function main(): Promise<void> {
  console.log("▶ publishJobToTistory 테스트 시작\n");

  // 1) 기본 비공개, 입력 내용 검증
  {
    let seen: { input: TistoryPublishInput; visibility: string } | null = null;
    const out = await publishJobToTistory("job-1", { ...baseDeps, publish: async (input, visibility) => { seen = { input, visibility }; return okPublish(); } });
    assert(out.ok && !out.alreadyDone, `발행 성공 (${JSON.stringify(out)})`);
    assert(seen!.visibility === "private", "기본은 비공개");
    const input = seen!.input;
    assert(input.title === "블로그 제목", "제목");
    assert(input.images.length === 1 && input.images[0].url === IMG && input.images[0].marker === "⟦IMG-1⟧", `이미지는 표식+URL (${JSON.stringify(input.images)})`);
    assert(input.bodyHtml.includes("⟦IMG-1⟧") && !input.bodyHtml.includes("<img"), "본문에는 표식만, <img> 없음");
    assert(input.bodyHtml.includes("참고 자료") && input.bodyHtml.includes("news.example.com"), "참고 자료는 남긴다");
    assert(!input.bodyHtml.includes("함께 보면 좋은 글") && !input.bodyHtml.includes("blogspot"), "Blogspot 내부 링크는 뺀다");
    assert(input.bodyHtml.includes("<strong>"), "굵게는 strong");
    assert(JSON.stringify(input.tags) === JSON.stringify(["사회", "이슈"]), `태그는 본문 끝 해시태그 (${JSON.stringify(input.tags)})`);
    assert(input.categoryName === "일상 생활 정보", `living -> 일상 생활 정보 (${input.categoryName})`);
    console.log("✅ 기본 비공개 + 표식 이미지 + 참고자료 유지/내부링크 제거 + 태그·카테고리");
  }

  // 2) frontmatter 태그가 있으면 우선
  {
    const tags = tistoryTagsFor(job({ metadata: { draftMeta: { tags: ["#정책", "경제"] } } }), BODY);
    assert(JSON.stringify(tags) === JSON.stringify(["정책", "경제"]), `draftMeta.tags 우선 (${JSON.stringify(tags)})`);
    console.log("✅ draftMeta.tags 우선");
  }

  // 3) 이미 올라간 job은 다시 올리지 않는다
  {
    let calls = 0;
    const out = await publishJobToTistory("job-1", {
      ...baseDeps,
      loadJobPublications: async () => [{ id: 3, article_id: 1, platform: "tistory", status: "published", published_url: "https://wooahpapa.tistory.com/entry/t", published_at: null, created_at: "x" } as PublicationRow],
      publish: async () => { calls += 1; return okPublish(); },
    });
    assert(out.ok && out.alreadyDone && calls === 0, "중복 발행 방지");
    console.log("✅ 중복 발행 방지");
  }

  // 4) 로그인 풀림 -> login_required, failed 기록 없음
  {
    const saved: string[] = [];
    const out = await publishJobToTistory("job-1", {
      ...baseDeps,
      savePublication: async (i) => { saved.push(i.status); return baseDeps.savePublication(i); },
      publish: async () => ({ ok: false, stage: "login", error: "로그인 필요" }),
    });
    assert(!out.ok && out.reason === "login_required" && saved.length === 0, `로그인 풀림은 대기 (${JSON.stringify(out)})`);
    console.log("✅ 로그인 풀림 -> login_required, publications에 failed 안 남김");
  }

  // 5) 진짜 실패는 failed 기록
  {
    const saved: string[] = [];
    const out = await publishJobToTistory("job-1", {
      ...baseDeps,
      savePublication: async (i) => { saved.push(i.status); return baseDeps.savePublication(i); },
      publish: async () => ({ ok: false, stage: "publish", error: "버튼 없음" }),
    });
    assert(!out.ok && out.reason === "tistory_failed" && out.detail.includes("[publish]") && saved[0] === "failed", "실패 기록");
    console.log("✅ 실패 기록");
  }

  // 6) 꺼져 있으면 아무것도 안 한다
  {
    let calls = 0;
    const out = await publishJobToTistory("job-1", { ...baseDeps, enabled: false, publish: async () => { calls += 1; return okPublish(); } });
    assert(!out.ok && out.reason === "disabled" && calls === 0, "TISTORY_ENABLED=false");
    console.log("✅ TISTORY_ENABLED 게이트");
  }

  console.log("\n✅ publishJobToTistory 테스트 전체 통과");
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
