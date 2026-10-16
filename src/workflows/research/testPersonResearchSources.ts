// 인물 조사 소스 확장 테스트(PERSON-RESEARCH-SOURCES-2026-10). 실행: npm run test:person-research-sources
// 전부 주입 기반 - 네트워크·브라우저·DB 없음. AI 탭 DOM은 headless 차단으로 실측하지 못해 텍스트 픽스처를 쓴다.
import { buildResearchPrompt } from "./buildResearchPrompt.js";
import { attachGoogleAiAnswer } from "./collectPersonSourcePack.js";
import {
  NAVER_AI_ANSWER_MAX_BYTES,
  extractNaverAiAnswer,
  fetchNaverAiAnswer,
  naverAiTabUrl,
  pollStableText,
} from "./naverAiAnswer.js";
import {
  PERSON_SOURCE_PACK_TOTAL_MAX_BYTES,
  fetchPersonSourcePack,
  fitPersonSourcePack,
  readPersonSourcePack,
} from "./personSourcePack.js";
import type { FetchLike, PersonSourcePack } from "./personSourcePack.js";
import {
  REFERENCE_BLOG_MAX_POSTS,
  REFERENCE_BLOG_TOTAL_MAX_BYTES,
  collectReferenceBlogPosts,
  extractBlogPostText,
  filterReferenceBlogItems,
} from "./referenceBlogPosts.js";
import type { BlogSearchItem } from "./referenceBlogPosts.js";
import { PERSON_REFERENCE_BLOGS } from "../../config/personReferenceBlogs.js";
import type { ArticleJobRow } from "../../types/database.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`❌ ${msg}`);
}
const bytes = (t: string) => Buffer.byteLength(t, "utf8");

const AI_PAGE = `AI
이미지
블로그
이규한은 대한민국의 배우로 1996년 드라마 '스타트'로 데뷔했습니다.
드라마 분야에서는 '무법 변호사'와 '추노'에 출연했고, 영화에서는 조연으로 꾸준히 활동했습니다.
예능에서는 가족 예능에 출연해 화제가 되었으며 광고 모델로도 활동했습니다.
출처 3개
blog.naver.com
이규한 최근작은?
복사
뒤로가기`;

// 1) AI 답변 추출 - UI 줄·출처 칩·추천 질문 제거, 차단 화면은 blocked
{
  const r = extractNaverAiAnswer(AI_PAGE.padEnd(AI_PAGE.length + 0));
  assert(!r.blocked && r.answer.includes("1996년") && r.answer.includes("예능"), "답변 본문이 남는다");
  assert(!r.answer.includes("출처 3개") && !r.answer.includes("blog.naver.com") && !r.answer.includes("이규한 최근작은?") && !r.answer.includes("복사"), "출처 칩·추천 질문·버튼은 뺀다");
  assert(!r.answer.split("\n").includes("AI") && !r.answer.split("\n").includes("이미지"), "상단 탭 문구는 뺀다");
  const blocked = extractNaverAiAnswer("AI\n이미지\nAI Tab\n잘못된 접근입니다.\n잠시 후 다시 시도해 주세요\n뒤로가기");
  assert(blocked.blocked && blocked.answer === "", "차단 화면은 blocked, 답변 비움");
  assert(extractNaverAiAnswer("AI\n짧음").answer === "", "너무 짧으면 답변으로 보지 않는다");
  const long = extractNaverAiAnswer(`${"가나다라마바사 ".repeat(50)}\n`.repeat(40));
  assert(bytes(long.answer) <= NAVER_AI_ANSWER_MAX_BYTES, "6KB 상한");
  assert(naverAiTabUrl("이규한").includes("ssc=tab.ait.all") && naverAiTabUrl("이규한").includes(encodeURIComponent("이규한")), "AI 탭 URL");
  console.log("✅ AI 답변 추출: 본문 유지, UI·칩·추천질문 제거, 차단 감지, 6KB 상한");
}

// 2) 스트리밍 폴링 - 3초 불변이면 완료, 25초 상한
{
  let t = 0;
  const sleep = async (ms: number) => void (t += ms);
  let calls = 0;
  const growing = async () => "x".repeat(Math.min(10 + calls++ * 10, 60)); // 6번째 호출부터 길이 고정(60)
  const out = await pollStableText(growing, { sleep, now: () => t });
  assert(out.length === 60, "생성이 끝난 텍스트를 돌려준다");
  assert(t < 25_000, `불변 3초면 상한 전에 끝난다 (경과 ${t}ms)`);
  t = 0;
  let n = 0;
  const forever = async () => "y".repeat(++n);
  await pollStableText(forever, { sleep, now: () => t });
  assert(t >= 25_000 && t < 26_000, `계속 변하면 총 25초 상한 (경과 ${t}ms)`);
  console.log("✅ 폴링: 불변 3초 완료 · 총 25초 상한");
}

// 3) fetchNaverAiAnswer - 성공·차단·예외(비치명)
{
  const mkOpen = (text: string, boom = false) => async () => {
    const log = { closed: false, url: "" };
    return {
      goto: async (url: string) => {
        log.url = url;
        if (boom) throw new Error("net::ERR_FAILED");
      },
      getText: async () => text,
      close: async () => void (log.closed = true),
    };
  };
  const fast = { sleep: async () => undefined, now: (() => { let t = 0; return () => (t += 1500); })() };
  const ok = await fetchNaverAiAnswer("이규한", { open: mkOpen(AI_PAGE), ...fast });
  assert(ok.answer.includes("1996년") && !ok.error, "성공");
  const blocked = await fetchNaverAiAnswer("이규한", { open: mkOpen("잘못된 접근입니다."), ...fast });
  assert(blocked.answer === "" && /봇 차단.*우회하지 않음/.test(blocked.error ?? ""), "차단은 사유를 남기고 빈 답변(우회 없음)");
  const boom = await fetchNaverAiAnswer("이규한", { open: mkOpen("", true), ...fast });
  assert(boom.answer === "" && /ERR_FAILED/.test(boom.error ?? ""), "예외도 던지지 않는다");
  console.log("✅ AI 탭 수집: 성공 / 차단 / 예외 모두 비치명");
}

// 4) 블로그 검색 필터 - bloggerlink 매칭·3건 상한·중복 제거
{
  const item = (blogger: string, logNo: string, title = "글"): BlogSearchItem => ({
    title: `<b>${title}</b>`,
    link: `https://blog.naver.com/${blogger}/${logNo}`,
    bloggerlink: `https://blog.naver.com/${blogger}`,
    postdate: "20261015",
  });
  const items = [
    item("randomuser", "100000000001"),
    item("uggang2", "100000000002", "이규한 필모"),
    item("UGGANG2", "100000000002"), // 같은 글 중복
    item("ddo-play", "100000000003"),
    { ...item("x", "100000000004"), bloggerlink: "blog.naver.com/js2y86", link: "https://blog.naver.com/PostView.naver?blogId=js2y86&logNo=100000000004" },
    item("pang_gom", "100000000005"),
    item("zosen98", "100000000006"),
  ];
  const hits = filterReferenceBlogItems(items);
  assert(hits.length === REFERENCE_BLOG_MAX_POSTS && REFERENCE_BLOG_MAX_POSTS === 3, "상위 3건 상한");
  assert(hits.map((h) => h.blogId).join() === "uggang2,ddo-play,js2y86", `풀 밖 제외·중복 제거·순서 유지 (${hits.map((h) => h.blogId)})`);
  assert(hits[0].title === "이규한 필모" && hits[0].postedAt === "2026-10-15", "제목 태그 제거·날짜 변환");
  assert(filterReferenceBlogItems([item("nobody", "100000000009")]).length === 0, "0건이면 빈 배열");
  assert(PERSON_REFERENCE_BLOGS.length === 10, "풀 10곳");
  console.log("✅ 블로그 필터: 풀 매칭·3건·중복 제거·PostView 링크·0건");
}

// 5) 본문 추출 + 수집(건당 8KB·합계 20KB, 비치명)
{
  const html = `<html><body><div class="se-main-container"><div class="se-module se-module-text"><p>이규한은 1996년 데뷔했다.</p></div>
<div class="se-module-oglink">광고 링크카드</div><div class="se-sticker">스티커</div>
<div class="se-module se-module-text"><p>${"드라마 구성 문단. ".repeat(900)}</p></div></div><div class="u_cbox">댓글 영역</div></body></html>`;
  const text = extractBlogPostText(html);
  assert(text.includes("1996년 데뷔") && !text.includes("광고 링크카드") && !text.includes("스티커") && !text.includes("댓글"), "본문만 남긴다");
  assert(bytes(text) <= 8 * 1024, "건당 8KB");
  assert(extractBlogPostText("<html><body>본문 컨테이너 없음</body></html>") === "", "컨테이너 없으면 빈 문자열");

  const search = async () =>
    ["uggang2", "ddo-play", "js2y86"].map((id, i) => ({
      title: `${id} 글`,
      link: `https://blog.naver.com/${id}/10000000000${i}`,
      bloggerlink: `https://blog.naver.com/${id}`,
    }));
  const urls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    urls.push(url);
    if (url.includes("ddo-play")) return { ok: false, status: 403, text: async () => "" };
    return { ok: true, status: 200, text: async () => html };
  };
  const r = await collectReferenceBlogPosts("이규한", { search, fetchImpl });
  assert(urls.every((u) => u.startsWith("https://m.blog.naver.com/")), "본문은 모바일 URL");
  assert(r.posts.length === 2 && r.errors.some((e) => e.includes("ddo-play") && e.includes("HTTP 403")), "한 건 403이어도 나머지는 진행, 사유 기록");
  const total = r.posts.reduce((s, p) => s + bytes(p.excerpt), 0);
  assert(total <= REFERENCE_BLOG_TOTAL_MAX_BYTES, `합계 20KB 이하 (${total})`);
  const failed = await collectReferenceBlogPosts("이규한", { search: async () => { throw new Error("HTTP 500"); }, fetchImpl });
  assert(failed.posts.length === 0 && failed.errors[0].includes("검색 실패"), "검색 실패는 빈 배열 + 사유(비치명)");
  const empty = await collectReferenceBlogPosts("이규한", { search: async () => [], fetchImpl });
  assert(empty.posts.length === 0 && empty.errors.length === 0, "0건이면 빈 배열로 끝");
  console.log("✅ 블로그 본문: 8KB/20KB 상한, 부분 실패·검색 실패·0건 비치명");
}

// 6) 소스팩 총량 불변 + 우선순위(새 항목이 먼저 잘림)
{
  const filler = (n: number) => "가".repeat(Math.floor(n / 3));
  const post = (id: string) => ({ blogId: id, title: id, url: `https://m.blog.naver.com/${id}/1`, excerpt: filler(8 * 1024) });
  const pack: PersonSourcePack = {
    personDb: filler(30 * 1024),
    namuwiki: filler(40 * 1024),
    naverAiAnswer: filler(6 * 1024),
    googleAiAnswer: filler(6 * 1024),
    referenceBlogPosts: [post("a"), post("b"), post("c")],
    fetchedAt: "2026-10-17T00:00:00.000Z",
    errors: [],
  };
  const fitted = fitPersonSourcePack(pack);
  const sum = (p: PersonSourcePack) =>
    bytes(p.personDb) + bytes(p.namuwiki) + bytes(p.naverAiAnswer ?? "") + bytes(p.googleAiAnswer ?? "") + (p.referenceBlogPosts ?? []).reduce((s, x) => s + bytes(x.excerpt), 0);
  assert(sum(fitted) <= PERSON_SOURCE_PACK_TOTAL_MAX_BYTES, `총량 80KB 불변 (${sum(fitted)})`);
  assert(fitted.personDb === pack.personDb && fitted.namuwiki === pack.namuwiki, "인물DB·나무위키는 안 잘린다");
  assert(bytes(fitted.naverAiAnswer ?? "") > 0 && (fitted.referenceBlogPosts ?? []).length < 3, "우선순위 낮은 블로그 글부터 잘린다");
  const small = { ...pack, personDb: filler(3 * 1024), namuwiki: filler(20 * 1024) };
  assert(JSON.stringify(fitPersonSourcePack(small)) === JSON.stringify(small), "여유가 있으면 그대로(총량 80KB 안)");
  const old: PersonSourcePack = { personDb: "a", namuwiki: "b", fetchedAt: "t", errors: [] };
  assert(!("naverAiAnswer" in fitPersonSourcePack(old)) && !("referenceBlogPosts" in fitPersonSourcePack(old)), "새 필드가 없던 팩은 그대로(하위 호환)");
  console.log("✅ 워터필링: 총량 80KB 불변, 새 항목이 먼저 잘림, 하위 호환");
}

// 7) fetchPersonSourcePack 통합(주입) + readPersonSourcePack 라운드트립 + 비치명
{
  const fetchImpl: FetchLike = async () => ({ ok: false, status: 403, text: async () => "" });
  const pack = await fetchPersonSourcePack("이규한", {
    fetchImpl,
    fetchNaverAi: async () => ({ answer: "", error: "naverAiAnswer: 봇 차단" }),
    fetchReferenceBlogs: async () => {
      throw new Error("boom");
    },
  });
  assert(pack.naverAiAnswer === "" && pack.referenceBlogPosts?.length === 0, "새 소스 실패 시 빈 값");
  assert(pack.errors.some((e) => e.includes("naverAiAnswer")) && pack.errors.some((e) => e.startsWith("referenceBlogs: boom")), "errors[]에 사유");
  const noExtras = await fetchPersonSourcePack("이규한", { fetchImpl });
  assert(!("naverAiAnswer" in noExtras) && !("referenceBlogPosts" in noExtras), "옵션이 없으면 기존 동작 그대로");
  const full = await fetchPersonSourcePack("이규한", {
    fetchImpl,
    fetchNaverAi: async () => ({ answer: "AI 답변 ".repeat(40) }),
    fetchReferenceBlogs: async () => ({ posts: [{ blogId: "uggang2", title: "t", url: "https://m.blog.naver.com/uggang2/1", excerpt: "본문" }], errors: [] }),
  });
  const read = readPersonSourcePack({ researchSourcePack: JSON.parse(JSON.stringify(full)) });
  assert(read?.naverAiAnswer === full.naverAiAnswer && read?.referenceBlogPosts?.[0]?.blogId === "uggang2", "metadata 라운드트립");
  console.log("✅ 소스팩 통합: 새 소스 실패는 errors[]만, 옵션 없으면 기존 동작, 라운드트립");

  // 8) 프롬프트 주입 라벨
  const job = { keyword: "이규한", headline: null, category: "person" } as Pick<ArticleJobRow, "keyword" | "headline" | "category">;
  const prompt = buildResearchPrompt({
    job,
    baselineSources: [],
    outputPath: "/tmp/x.md",
    today: "2026-10-17",
    personSourcePack: { ...full, naverAiAnswer: "AI 본문 문장", googleAiAnswer: "구글 본문 문장" },
  });
  assert(prompt.includes("## 네이버 AI 답변 (구조 참고 전용)") && prompt.includes("## 구글 AI 답변 (구조 참고 전용)"), "AI 라벨");
  assert(prompt.includes("조사 커버리지 체크리스트로만 쓴다") && prompt.includes("인용하지 않는다"), "AI 라벨 본문");
  assert(prompt.includes("## 레퍼런스 블로그 포스팅 (구성 참고 전용)") && prompt.includes("문장·표현을 가져오지"), "블로그 라벨");
  assert(prompt.indexOf("나무위키 원문") < prompt.indexOf("네이버 AI 답변"), "AI 절은 인물DB·나무위키 다음");
  const plain = buildResearchPrompt({ job, baselineSources: [], outputPath: "/tmp/x.md", today: "2026-10-17", personSourcePack: { personDb: "a", namuwiki: "b", fetchedAt: "t", errors: [] } });
  assert(!plain.includes("구조 참고 전용") && !plain.includes("레퍼런스 블로그"), "새 항목이 비면 절을 싣지 않는다");
  console.log("✅ 프롬프트: 라벨 3종 존재, 순서, 빈 항목 생략");
}

// 9) 구글 AI 수동 첨부
{
  let meta: Record<string, unknown> | null = null;
  const deps = {
    readMetadata: async () => meta,
    mergeMetadata: async (_id: string, patch: Record<string, unknown>) => {
      meta = { ...(meta ?? {}), ...patch };
    },
  };
  let threw = false;
  await attachGoogleAiAnswer("j1", "구글 답변", deps).catch(() => (threw = true));
  assert(threw, "소스팩이 아직 없으면 거부");
  meta = { researchSourcePack: { personDb: "a", namuwiki: "b", fetchedAt: "t", errors: [] } };
  const next = await attachGoogleAiAnswer("j1", `  ${"구글".repeat(5000)}  `, deps);
  assert(bytes(next.googleAiAnswer ?? "") <= 6 * 1024, "6KB 상한");
  assert(readPersonSourcePack(meta)?.googleAiAnswer === next.googleAiAnswer && readPersonSourcePack(meta)?.personDb === "a", "기존 팩 유지 + 첨부");
  console.log("✅ 구글 AI 첨부: 팩 없으면 거부, 6KB 상한, 기존 필드 유지");
}

console.log("\n✅ person 조사 소스 확장 테스트 통과");
