// 종합 키워드 입력 툴 B부 테스트(링크 자동 추출). 네트워크 없이 고정 HTML·고정 API 응답으로 돈다. 실행: npm run test:link-extract
import { strict as assert } from "node:assert";

import type { FetchLike } from "../research/personSourcePack.js";
import type { InstagramInboxRow } from "../../services/supabase/repositories/instagramInboxRepository.js";
import type { TelegramReplyMarkup } from "../../notifications/TelegramNotifier.js";
import { handleInstagramUpdate } from "../instagram-capture/instagramWebhookHandler.js";
import type { InstagramWebhookDeps } from "../instagram-capture/instagramWebhookHandler.js";
import { decodeLinkSource, queueFieldsForLinkSource, resolveLinkSource } from "../instagram-capture/linkInput.js";
import { inputJobFields } from "../instagram-capture/inputJobFields.js";
import { InstagramCaptureBot } from "../../notifications/InstagramCaptureBot.js";
import { extractArticleText, extractTitle } from "./extractArticleText.js";
import { createExtractDeps } from "./createExtractDeps.js";
import { extractLinkSource } from "./extractLinkSource.js";
import type { ExtractDeps, NewsSearchItem } from "./extractLinkSource.js";
import { classifyLink } from "./linkClassify.js";
import { isPathAllowed, isUrlAllowedByRobots } from "./robots.js";

const LOREM = "이 문장은 본문 추출 테스트를 위한 충분히 긴 한국어 문단입니다. ".repeat(12);

const NAVER_BLOG_HTML = `<html><head><meta property="og:title" content="취나물밥 레시피"><title>취나물밥 : 네이버 블로그</title></head><body>
<div class="se-main-container"><div class="se-component se-text"><p>${LOREM}</p></div>
<div class="se-module-oglink">링크카드 제거 대상</div><div class="se-sticker">스티커</div></div>
<div class="u_cbox">댓글 영역</div></body></html>`;

const TISTORY_HTML = `<html><head><title>티스토리 글 - 블로그</title></head><body><header>메뉴</header>
<div class="entry-content"><p>${LOREM}</p></div><footer>푸터</footer></body></html>`;

const ARTICLE_HTML = `<html><head><title>언론사 기사</title></head><body><nav>메뉴 메뉴</nav>
<article><p>${LOREM}</p></article><aside>관련기사 광고</aside></body></html>`;

const HEURISTIC_HTML = `<html><head><title>아무 사이트</title></head><body><div id="menu"><p>짧은 메뉴</p></div>
<div id="wrap"><div class="x"><p>${LOREM}</p><p>${LOREM}</p></div></div></body></html>`;

const EMPTY_HTML = `<html><head><title>빈 페이지</title></head><body><div><p>짧다</p></div></body></html>`;

type Route = { status?: number; body: string };
function fakeFetch(routes: Record<string, Route>, calls: string[] = []): FetchLike {
  return async (url) => {
    calls.push(url);
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    if (!key) throw new Error(`unexpected fetch: ${url}`);
    const route = routes[key];
    const status = route.status ?? 200;
    return { ok: status >= 200 && status < 300, status, text: async () => route.body };
  };
}
const ROBOTS_OPEN = { "https://news.example.com/robots.txt": { body: "User-agent: *\nAllow: /" } };

// ---- 1) 링크 분류 ----
const blog = classifyLink("https://blog.naver.com/abcd/223456789012");
assert.ok(blog.kind === "naver_blog" && blog.mobileUrl === "https://m.blog.naver.com/abcd/223456789012", "blog.naver.com -> m.blog 변환");
assert.ok(classifyLink("https://m.blog.naver.com/abcd/223456789012").kind === "naver_blog");
assert.ok(classifyLink("https://blog.naver.com/PostView.naver?blogId=abcd&logNo=223456789012").kind === "naver_blog", "PostView 형식");
assert.equal(classifyLink("https://blog.naver.com/abcd").kind, "blocked", "글 번호 없는 블로그 홈은 읽지 않는다");
assert.deepEqual(classifyLink("https://n.news.naver.com/mnews/article/001/0014000000"), { kind: "naver_news", oid: "001", aid: "0014000000" });
assert.equal(classifyLink("https://cafe.naver.com/foo/123").kind, "naver_cafe");
assert.deepEqual(classifyLink("https://www.youtube.com/shorts/AbC123xyz_-"), { kind: "youtube", videoId: "AbC123xyz_-" });
assert.deepEqual(classifyLink("https://youtu.be/AbC123xyz_-?si=1"), { kind: "youtube", videoId: "AbC123xyz_-" });
assert.deepEqual(classifyLink("https://www.youtube.com/watch?v=AbC123xyz_-"), { kind: "youtube", videoId: "AbC123xyz_-" });
assert.equal(classifyLink("https://abc.tistory.com/12").kind, "tistory");
assert.equal(classifyLink("https://news.example.com/a/1").kind, "web");
assert.equal(classifyLink("http://localhost:3000/x").kind, "blocked", "내부 주소 차단");
assert.equal(classifyLink("http://192.168.0.1/x").kind, "blocked");
assert.equal(classifyLink("ftp://example.com/x").kind, "blocked");
assert.equal(classifyLink("https://www.threads.com/@a/post/B").kind, "blocked", "스레드 본문은 읽지 않는다");
console.log("✅ 링크 분류(네이버 블로그/뉴스/카페/유튜브/티스토리/일반/차단)");

// ---- 2) 본문 추출(고정 HTML) ----
const nb = extractArticleText(NAVER_BLOG_HTML);
assert.equal(nb.title, "취나물밥 레시피", "og:title 우선");
assert.ok(nb.text.includes("본문 추출 테스트"));
assert.equal(extractTitle(TISTORY_HTML), "티스토리 글 - 블로그", "og:title 없으면 <title>");
const ti = extractArticleText(TISTORY_HTML);
assert.ok(ti.text.includes("본문 추출 테스트") && !ti.text.includes("메뉴") && !ti.text.includes("푸터"), "티스토리 .entry-content, 헤더·푸터 제거");
const ar = extractArticleText(ARTICLE_HTML);
assert.ok(ar.text.includes("본문 추출 테스트") && !ar.text.includes("관련기사"), "<article> 폴백, aside 제거");
const he = extractArticleText(HEURISTIC_HTML);
assert.ok(he.text.includes("본문 추출 테스트") && !he.text.includes("짧은 메뉴"), "문단 최다 블록 휴리스틱");
assert.equal(extractArticleText(EMPTY_HTML).text, "", "짧으면 빈 문자열(붙여넣기 안내로 간다)");
assert.ok(Buffer.byteLength(extractArticleText(`<article><p>${"가".repeat(20000)}</p></article>`).text, "utf8") <= 8 * 1024, "8KB 상한");
console.log("✅ 본문 추출기(네이버 SmartEditor·티스토리·article·휴리스틱·빈 페이지·상한)");

// ---- 3) robots ----
assert.equal(isPathAllowed("User-agent: *\nDisallow: /", "/a"), false);
assert.equal(isPathAllowed("User-agent: *\nDisallow: /private\nAllow: /private/ok", "/private/ok/1"), true, "가장 긴 매칭이 이긴다");
assert.equal(isPathAllowed("User-agent: googlebot\nDisallow: /", "/a"), true, "다른 에이전트 그룹은 무관");
assert.equal(isPathAllowed("", "/a"), true);
assert.equal(await isUrlAllowedByRobots("https://x.example/a", fakeFetch({ "https://x.example/robots.txt": { body: "", status: 404 } })), true, "robots 없음(404)은 허용");
assert.equal(await isUrlAllowedByRobots("https://x.example/a", fakeFetch({ "https://x.example/robots.txt": { body: "", status: 503 } })), false, "5xx는 불허");
assert.equal(await isUrlAllowedByRobots("https://x.example/a", async () => { throw new Error("net"); }), false, "확인 못 하면 불허");
console.log("✅ robots 판정");

// ---- 4) 오케스트레이션: 네이버 블로그 / 티스토리 / 일반 / 실패 ----
{
  const calls: string[] = [];
  const deps: ExtractDeps = { fetchImpl: fakeFetch({ "https://m.blog.naver.com/abcd/223456789012": { body: NAVER_BLOG_HTML } }, calls) };
  const r = await extractLinkSource("https://blog.naver.com/abcd/223456789012", "", deps);
  assert.ok(r.status === "ok" && r.via === "naver_blog" && r.title === "취나물밥 레시피" && r.text.includes("본문 추출 테스트"));
  assert.deepEqual(calls, ["https://m.blog.naver.com/abcd/223456789012"], "m.blog만 fetch(robots 조회 없음), blog.naver.com 본체는 안 건드린다");
}
{
  const deps: ExtractDeps = { fetchImpl: fakeFetch({ "https://abc.tistory.com/robots.txt": { body: "User-agent: *\nAllow: /" }, "https://abc.tistory.com/12": { body: TISTORY_HTML } }) };
  const r = await extractLinkSource("https://abc.tistory.com/12", "", deps);
  assert.ok(r.status === "ok" && r.via === "tistory");
}
{
  const deps: ExtractDeps = { fetchImpl: fakeFetch({ ...ROBOTS_OPEN, "https://news.example.com/a/1": { body: EMPTY_HTML } }) };
  const r = await extractLinkSource("https://news.example.com/a/1", "", deps);
  assert.ok(r.status === "needs_paste" && r.reply.includes("본문을 복사해 텍스트로"), "본문을 못 찾으면 비치명 안내");
}
{
  const deps: ExtractDeps = { fetchImpl: fakeFetch({ "https://news.example.com/robots.txt": { body: "User-agent: *\nDisallow: /" } }) };
  const r = await extractLinkSource("https://news.example.com/a/1", "", deps);
  assert.ok(r.status === "needs_paste", "robots가 막으면 본문을 fetch하지 않는다");
}
{
  const deps: ExtractDeps = { fetchImpl: fakeFetch({ "https://m.blog.naver.com/": { body: "", status: 403 } }) };
  const r = await extractLinkSource("https://blog.naver.com/abcd/223456789012", "", deps);
  assert.ok(r.status === "needs_paste" && r.reply.includes("HTTP 403"), "m.blog 403이면 비치명 + 사유 표시(클라우드 probe 신호)");
}
{
  const calls: string[] = [];
  const r = await extractLinkSource("https://cafe.naver.com/foo/123", "", { fetchImpl: fakeFetch({}, calls) });
  assert.ok(r.status === "needs_paste" && calls.length === 0, "카페는 fetch하지 않는다");
  const r2 = await extractLinkSource("https://www.threads.com/@a/post/B", "", { fetchImpl: fakeFetch({}, calls) });
  assert.ok(r2.status === "needs_paste" && calls.length === 0, "스레드·내부 주소는 fetch하지 않는다");
}
console.log("✅ 오케스트레이션: 블로그(m.blog만)·티스토리·일반 실패·robots 차단·403 비치명·카페/스레드 무fetch");

// ---- 5) 뉴스: originallink 경로 / 요약 폴백 / 직접 fetch 금지 ----
{
  const calls: string[] = [];
  const news: NewsSearchItem[] = [
    { title: "다른 기사", description: "x", link: "https://n.news.naver.com/mnews/article/999/0000000001", originallink: "https://other.example/1" },
    { title: "전기차 보조금 확대", description: "정부가 보조금을 늘린다", link: "https://n.news.naver.com/mnews/article/001/0014000000?sid=101", originallink: "https://news.example.com/a/1" },
  ];
  const searched: string[] = [];
  const deps: ExtractDeps = {
    fetchImpl: fakeFetch({ ...ROBOTS_OPEN, "https://news.example.com/a/1": { body: ARTICLE_HTML } }, calls),
    searchNews: async (q) => { searched.push(q); return news; },
  };
  const r = await extractLinkSource("https://n.news.naver.com/mnews/article/001/0014000000", "전기차 보조금 확대", deps);
  assert.deepEqual(searched, ["전기차 보조금 확대"]);
  assert.ok(r.status === "ok" && r.via === "news_original" && r.url === "https://news.example.com/a/1", "originallink(언론사 원문)를 읽는다");
  assert.ok(calls.every((u) => !u.includes("naver.com")), "n.news.naver.com은 직접 fetch하지 않는다");

  // 원문 fetch가 실패하면 API의 제목·요약만 쓴다
  const deps2: ExtractDeps = { fetchImpl: fakeFetch({ ...ROBOTS_OPEN, "https://news.example.com/a/1": { body: "", status: 500 } }), searchNews: async () => news };
  const r2 = await extractLinkSource("https://n.news.naver.com/mnews/article/001/0014000000", "전기차 보조금 확대", deps2);
  assert.ok(r2.status === "ok" && r2.via === "news_api_summary" && r2.text.includes("정부가 보조금을 늘린다") && r2.title === "전기차 보조금 확대");

  // 못 찾으면 / 제목 힌트 없으면 / 검색 키 없으면 붙여넣기 안내
  const r3 = await extractLinkSource("https://n.news.naver.com/mnews/article/777/0000000009", "엉뚱한 제목", deps2);
  assert.equal(r3.status, "needs_paste");
  const r4 = await extractLinkSource("https://n.news.naver.com/mnews/article/001/0014000000", "", deps2);
  assert.equal(r4.status, "needs_paste");
  const r5 = await extractLinkSource("https://n.news.naver.com/mnews/article/001/0014000000", "제목", { fetchImpl: fakeFetch({}) });
  assert.equal(r5.status, "needs_paste");
}
console.log("✅ 뉴스: 검색 API originallink 경로 / 원문 실패 시 요약 폴백 / 직접 fetch 없음 / 비치명 안내");

// ---- 6) 유튜브: 키 없음 비치명 / 키 있음 메타만 ----
{
  const calls: string[] = [];
  const noKey = await extractLinkSource("https://www.youtube.com/shorts/AbC123xyz_-", "", { fetchImpl: fakeFetch({}, calls) });
  assert.ok(noKey.status === "needs_paste" && noKey.reply.includes("요점") && calls.length === 0, "YOUTUBE_API_KEY 부재: 비치명 + 요점 요청 + 호출 없음");

  const apiBody = JSON.stringify({ items: [{ snippet: { title: "쇼츠 제목", description: "쇼츠 설명", channelTitle: "채널A" } }] });
  const withKey = await extractLinkSource("https://www.youtube.com/shorts/AbC123xyz_-", "", {
    fetchImpl: fakeFetch({ "https://www.googleapis.com/youtube/v3/videos?part=snippet&id=AbC123xyz_-": { body: apiBody } }, calls),
    youtubeApiKey: "TESTKEY",
  });
  assert.ok(withKey.status === "ok" && withKey.via === "youtube_meta" && withKey.title === "쇼츠 제목" && withKey.text.includes("채널: 채널A") && withKey.text.includes("쇼츠 설명"));
  assert.ok(!withKey.text.includes("TESTKEY"), "키가 본문에 새지 않는다");
  assert.ok(!/자막|transcript|captions/i.test(calls.join(" ")), "자막은 수집하지 않는다");

  const failing = await extractLinkSource("https://youtu.be/AbC123xyz_-", "", {
    fetchImpl: async () => { throw new Error("boom https://www.googleapis.com/...key=TESTKEY"); },
    youtubeApiKey: "TESTKEY",
  });
  assert.ok(failing.status === "needs_paste" && !failing.reply.includes("TESTKEY"), "오류 메시지로 키가 새지 않는다");

  // createExtractDeps: env에 키가 없으면 비활성
  assert.equal(createExtractDeps({}).youtubeApiKey, null);
  assert.equal(createExtractDeps({}).searchNews, undefined);
  assert.equal(createExtractDeps({ YOUTUBE_API_KEY: " k " }).youtubeApiKey, "k");
  assert.ok(typeof createExtractDeps({ NAVER_CLIENT_ID: "a", NAVER_CLIENT_SECRET: "b" }).searchNews === "function");
}
console.log("✅ 유튜브: 키 부재 비치명 / 메타만(자막 없음) / 키 비노출");

// ---- 7) 링크 해석 -> 큐 항목 -> job 필드 ----
{
  const okExtract = async () => ({ status: "ok" as const, url: "https://m.blog.naver.com/a/123456", title: "글 제목", text: "본문 본문", via: "naver_blog" as const });
  const r = await resolveLinkSource("https://blog.naver.com/a/123456", "테크", okExtract);
  assert.ok(r.ok && r.payload.track === "tech" && r.payload.note === "", "링크 옆 트랙 단어를 뗀다");
  const decoded = r.ok ? decodeLinkSource(JSON.stringify(r.payload)) : null;
  assert.deepEqual(decoded, r.ok ? r.payload : null);
  const f = r.ok ? queueFieldsForLinkSource(r.payload) : null;
  assert.ok(f && f.status === "pending" && f.track === "tech" && f.userTopic === "글 제목" && f.source === "text" && f.sourceUrl === "https://blog.naver.com/a/123456", "출처는 사용자가 보낸 원래 링크");

  const withNote = await resolveLinkSource("https://blog.naver.com/a/123456", "전기차 보조금에 대해 써줘", okExtract);
  const f2 = withNote.ok ? queueFieldsForLinkSource(withNote.payload) : null;
  assert.ok(f2 && f2.userTopic === "전기차 보조금" && f2.status === "needs_track", "메모가 있으면 명령구를 떼어 주제로");

  const fail = await resolveLinkSource("https://cafe.naver.com/x/1", "", async () => ({ status: "needs_paste", reply: "붙여넣어 주세요" }));
  assert.deepEqual(fail, { ok: false, reply: "붙여넣어 주세요" });

  // 유튜브 키 없음 + 요점 동봉 = 요점이 소스 본문이 된다(주제는 따로 묻는다)
  const yt = await resolveLinkSource("https://www.youtube.com/shorts/AbC123xyz_-", "이 쇼츠는 전기차 화재 시 대처법을 알려준다", async () => ({ status: "needs_paste", reply: "요점" }));
  const fy = yt.ok ? queueFieldsForLinkSource(yt.payload) : null;
  assert.ok(yt.ok && fy && fy.sourceText === "이 쇼츠는 전기차 화재 시 대처법을 알려준다" && fy.status === "needs_topic");

  // 유튜브 메타 + 요점 동봉: 제목이 주제, 요점은 소스 본문에 합친다
  const yt2 = await resolveLinkSource("https://www.youtube.com/shorts/AbC123xyz_-", "화재 대처 요점 3가지", async () => ({ status: "ok", url: "https://www.youtube.com/shorts/AbC123xyz_-", title: "쇼츠 제목", text: "제목: 쇼츠 제목", via: "youtube_meta" }));
  const fy2 = yt2.ok ? queueFieldsForLinkSource(yt2.payload) : null;
  assert.ok(fy2 && fy2.userTopic === "쇼츠 제목" && fy2.sourceText?.includes("사용자 요점: 화재 대처 요점 3가지"));

  const job = inputJobFields({ id: "x", instagramUrl: "", rawCaption: "", telegramChatId: "1", telegramMessageId: 1, receivedAt: "x", ...(f as object), status: "pending" } as never);
  assert.equal(job.metadata.sourceUrl, "https://blog.naver.com/a/123456");
  assert.equal(job.metadata.sourceText, "본문 본문");
  assert.equal(job.category, "tech");
}
console.log("✅ 링크 해석 -> 큐 항목(트랙 단어·명령구·유튜브 요점) -> job 필드(sourceUrl)");

// ---- 8) 웹훅·봇 연결 ----
{
  const rows: InstagramInboxRow[] = [];
  const sent: { text: string; markup?: TelegramReplyMarkup }[] = [];
  const mk = (extractLink?: InstagramWebhookDeps["extractLink"]): InstagramWebhookDeps => ({
    allowedChatId: "99",
    insertInbox: async (row) => { rows.push(row); },
    sendMessage: async (_c, text, markup) => { sent.push({ text, markup }); },
    editReplyMarkup: async () => {},
    ...(extractLink ? { extractLink } : {}),
  });
  const upd = (id: number, text: string) => ({ update_id: id, message: { message_id: id, chat: { id: 99 }, text } });

  const ok = await handleInstagramUpdate(upd(1, "https://blog.naver.com/a/123456 일상"), mk(async () => ({ status: "ok", url: "https://m.blog.naver.com/a/123456", title: "제목", text: "본문", via: "naver_blog" })));
  assert.deepEqual(ok, { handled: "source", queueId: "tg-1", track: "living" });
  assert.equal(rows[0].kind, "source");
  assert.equal(rows[0].instagramUrl, "https://blog.naver.com/a/123456");
  assert.equal(decodeLinkSource(rows[0].rawCaption)?.track, "living");
  assert.equal(sent.at(-1)!.markup, undefined, "트랙을 같이 보냈으면 버튼 없이 확정");

  const ask = await handleInstagramUpdate(upd(2, "https://abc.tistory.com/12"), mk(async () => ({ status: "ok", url: "https://abc.tistory.com/12", title: "티스토리 제목", text: "본문", via: "tistory" })));
  assert.deepEqual(ask, { handled: "source", queueId: "tg-2", track: null });
  assert.equal((sent.at(-1)!.markup?.inline_keyboard ?? []).flat().length, 4, "트랙 4버튼");

  const before = rows.length;
  const fail = await handleInstagramUpdate(upd(3, "https://cafe.naver.com/x/1"), mk(async () => ({ status: "needs_paste", reply: "카페는 못 읽습니다. 본문을 복사해 텍스트로 보내 주세요." })));
  assert.deepEqual(fail, { handled: "ignored", reason: "extract_failed" });
  assert.equal(rows.length, before, "실패는 수신함에 넣지 않는다");
  assert.ok(sent.at(-1)!.text.includes("본문을 복사해 텍스트로"));

  const noExtractor = await handleInstagramUpdate(upd(4, "https://abc.tistory.com/12"), mk());
  assert.deepEqual(noExtractor, { handled: "ignored", reason: "unsupported_url" }, "추출기가 없으면 A부 안내로 남는다");

  // 폴링 모드 봇도 같은 경로
  const enqueued: unknown[] = [];
  const replies: string[] = [];
  const bot = new InstagramCaptureBot({
    botToken: "t",
    fetchUpdates: async () => [{ update_id: 9, message: { message_id: 9, chat: { id: 111 }, text: "https://abc.tistory.com/12" } }],
    sendMessage: async (_c, text) => { replies.push(text); return 5; },
    getStoredOffset: async () => 1,
    advanceStoredOffset: async () => {},
    enqueue: async (e) => { enqueued.push(e); },
    extractLink: async () => ({ status: "ok", url: "https://abc.tistory.com/12", title: "티스토리 제목", text: "본문", via: "tistory" }),
  });
  const polled = await bot.pollOnce();
  assert.equal(polled.enqueued, 1);
  assert.equal((enqueued[0] as { userTopic?: string }).userTopic, "티스토리 제목");
}
console.log("✅ 웹훅·폴링 봇: 추출 성공(트랙 동봉/버튼) · 실패 비치명 · 추출기 부재");

console.log("\n✅ testLinkExtract(B부) 전체 통과");
