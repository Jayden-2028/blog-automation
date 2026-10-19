// 종합 키워드 입력 툴 A부 테스트(KEYWORD-INPUT-TOOL-2026-10.md). 실행: npm run test:keyword-input
// DB·텔레그램·모델은 전부 주입/순수 함수로 돈다.
import { strict as assert } from "node:assert";

import { buildResearchPrompt, buildUserSourceTextSection } from "../research/buildResearchPrompt.js";
import { isManualPublishOnly } from "../publish/manualPublishOnly.js";
import { buildWritingPrompt } from "../writing/buildWritingPrompt.js";
import { pickStyleFile, specCategoryOf, writingSpecFiles } from "../writing/specFiles.js";
import { classifyKeywordCategory } from "../../config/keywordCategoryRules.js";
import type { InstagramInboxRow } from "../../services/supabase/repositories/instagramInboxRepository.js";
import type { TelegramReplyMarkup } from "../../notifications/TelegramNotifier.js";
import {
  classifyUrl,
  directInputAck,
  extractFirstUrl,
  interpretDirectInput,
  isLongText,
  LONG_TEXT_THRESHOLD,
  queueFieldsForDirectInput,
  sourceOfUrl,
  stripCommandTail,
} from "./directInput.js";
import { inputJobFields, SOURCE_TEXT_MAX_BYTES } from "./inputJobFields.js";
import { handleInstagramUpdate } from "./instagramWebhookHandler.js";
import type { InstagramWebhookDeps } from "./instagramWebhookHandler.js";
import { categoryForTrack, jobMetadataForTrack, parseTrackPick, resolveTrackReply, trackFromWord } from "./instagramTrack.js";
import { applyTrackPick, listAwaitingTrack } from "./instagramQueue.js";
import { processPendingCaptures } from "./processPendingCaptures.js";
import type { InstagramQueueEntry } from "./types.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---- 1) URL 종류 / 출처 ----
assert.equal(classifyUrl("https://www.instagram.com/p/ABC/"), "instagram");
assert.equal(classifyUrl("https://www.instagram.com/reel/XYZ_1/?igsh=1"), "instagram");
assert.equal(classifyUrl("https://www.threads.com/@user/post/Cabc"), "threads");
assert.equal(classifyUrl("https://threads.net/@user/post/Cabc"), "threads");
assert.equal(classifyUrl("https://blog.naver.com/abc/123"), "other");
assert.equal(classifyUrl("https://www.instagram.com/someprofile/"), "other", "프로필은 게시물이 아니다");
assert.equal(extractFirstUrl("봐줘 https://threads.com/@a/post/B, 이거"), "https://threads.com/@a/post/B");
assert.equal(extractFirstUrl("그냥 글"), null);
assert.equal(sourceOfUrl("https://www.threads.com/@a/post/B"), "threads");
assert.equal(sourceOfUrl("https://www.instagram.com/p/A/"), "instagram");
assert.equal(sourceOfUrl(null), "text");
console.log("✅ URL 종류·출처 구분(instagram/threads/other)");

// ---- 2) 명령구 꼬리 제거(8케이스) + 질문형 보존 ----
const tailCases: Array<[string, string]> = [
  ["중간선거라는 주제로 원고 써줘", "중간선거"],
  ["전기차 보조금에 대해 써줘", "전기차 보조금"],
  ["AI 반도체 원고 작성", "AI 반도체"],
  ["주식 배당 세금 글 써 주세요", "주식 배당 세금"],
  ["나솔사계 정리 포스팅 작성해줘.", "나솔사계 정리"],
  ["수능이라는 주제에 대해 글 작성해 주세요", "수능"],
  ["아이폰 18 출시일에 대한 블로그 글 써줘", "아이폰 18 출시일"],
  ["청년 월세 지원을 주제로 써줘", "청년 월세 지원"],
  // 명령이 아닌 것은 건드리지 않는다
  ["기사 작성 방법", "기사 작성 방법"],
  ["글쓰기 앱 추천", "글쓰기 앱 추천"],
  ["민찌는 무슨 고기일까?", "민찌는 무슨 고기일까?"],
  ["미국 중간선거는 누굴 뽑는거지?", "미국 중간선거는 누굴 뽑는거지?"],
  ["이 글 써줘", "이 글 써줘"], // 남는 주제가 한 글자라 원문 유지
];
for (const [input, expected] of tailCases) assert.equal(stripCommandTail(input), expected, `꼬리 제거: ${input}`);
console.log(`✅ 명령구 꼬리 제거 ${tailCases.length}케이스(질문형 물음표 보존)`);

// ---- 3) 짧은 글 / 긴 글 ----
assert.deepEqual(interpretDirectInput("민찌는 무슨 고기일까?"), { kind: "topic", topic: "민찌는 무슨 고기일까?" });
const longBody = "카페 본문 ".repeat(120);
assert.ok(isLongText(longBody) && longBody.replace(/\s+/g, "").length > LONG_TEXT_THRESHOLD);
assert.ok(!isLongText("가".repeat(LONG_TEXT_THRESHOLD)), "상한 이하는 짧은 글");
const long = interpretDirectInput(longBody);
assert.equal(long.kind, "source");
assert.deepEqual(queueFieldsForDirectInput("테슬라 신형"), { source: "text", status: "needs_track", userTopic: "테슬라 신형" });
const longFields = queueFieldsForDirectInput(longBody);
assert.equal(longFields.status, "needs_topic");
assert.equal(longFields.sourceText, longBody.trim());
assert.ok(directInputAck({ kind: "topic", topic: "민찌는 무슨 고기일까?" }).startsWith('접수: 주제 "민찌는 무슨 고기일까?" — 트랙을 답해주세요 (엔터/사회/일상/테크)'));
console.log("✅ 짧은 글=주제 / 긴 글=소스 본문(needs_topic) / 접수 문구");

// ---- 4) 트랙 단어 4종 ----
assert.equal(trackFromWord("엔터"), "entertainment");
assert.equal(trackFromWord("사회"), "social");
assert.equal(trackFromWord("일상"), "living");
assert.equal(trackFromWord("테크"), "tech");
assert.equal(trackFromWord("일상생활"), null);
assert.deepEqual(parseTrackPick("track:tg-1:tech"), { queueId: "tg-1", track: "tech" });
assert.equal(parseTrackPick("track:tg-1:nope"), null);
console.log("✅ 트랙 단어 답장 4종");

// ---- 5) track -> category -> metadata ----
assert.equal(categoryForTrack("living"), "living");
assert.equal(categoryForTrack("tech"), "tech");
assert.equal(categoryForTrack("social"), null);
assert.deepEqual(jobMetadataForTrack("living"), { track: "living" });
assert.deepEqual(jobMetadataForTrack("tech"), { track: "tech" });
assert.deepEqual(jobMetadataForTrack("social"), { track: "social" });
assert.deepEqual(jobMetadataForTrack("entertainment"), {}, "엔터는 값 없음(=메인봇)");
const baseEntry = (patch: Partial<InstagramQueueEntry>): InstagramQueueEntry => ({
  id: "tg-1", instagramUrl: "", rawCaption: "", telegramChatId: "1", telegramMessageId: 1, receivedAt: "x", status: "pending", source: "text", ...patch,
});
const techFields = inputJobFields(baseEntry({ track: "tech", userTopic: "민찌는 무슨 고기일까?" }));
assert.equal(techFields.category, "tech");
assert.equal(techFields.keyword, "민찌는 무슨 고기일까?");
assert.deepEqual({ source: techFields.metadata.source, track: techFields.metadata.track }, { source: "keyword_input", track: "tech" });
const livingFields = inputJobFields(baseEntry({ track: "living", userTopic: "빨래 냄새", sourceText: "본문" }));
assert.equal(livingFields.category, "living");
assert.equal(livingFields.metadata.sourceText, "본문");
const bigFields = inputJobFields(baseEntry({ track: "social", userTopic: "t", sourceText: "가".repeat(20000) }));
assert.ok(Buffer.byteLength(String(bigFields.metadata.sourceText), "utf8") <= SOURCE_TEXT_MAX_BYTES, "sourceText는 8KB 상한");
assert.equal(bigFields.category, null, "사회 트랙은 category를 정하지 않는다(null)");
console.log("✅ track→category→metadata (sourceText 8KB 상한)");

// ---- 6) 문체 라우팅 + 기존 living(트렌드 경로) 불변 ----
const trendLiving = { category: "living", metadata: { source: "trend" } };
assert.equal(specCategoryOf(trendLiving), "living", "트렌드 경로 living은 category 그대로");
assert.equal(specCategoryOf({ category: "living", metadata: null }), "living");
assert.equal(specCategoryOf({ category: "living" }), "living");
assert.equal(pickStyleFile(specCategoryOf(trendLiving)), "prompts/writing/style/trend.md", "기존 living job은 여전히 trend.md");
assert.ok(writingSpecFiles(specCategoryOf(trendLiving)).some((f) => f.path.endsWith("style/voice.md")), "기존 living은 voice.md 유지");
const inputLiving = { category: "living", metadata: { track: "living" } };
assert.equal(specCategoryOf(inputLiving), "incident");
assert.equal(pickStyleFile(specCategoryOf(inputLiving)), "prompts/writing/style/incident.md");
assert.equal(specCategoryOf({ category: "tech", metadata: { track: "tech" } }), "incident");
assert.equal(specCategoryOf({ category: "tech", metadata: {} }), "incident", "tech 카테고리는 입력 툴에서만 생긴다");
assert.equal(specCategoryOf({ category: "incident", metadata: null }), "incident");
assert.equal(specCategoryOf({ category: "social-ish", metadata: { track: "social" } }), "social-ish", "사회 트랙 라벨은 문체 라우팅을 바꾸지 않는다");
const jobBase = { keyword: "k", headline: null, researchFilePath: "/r.md", draftFilePath: "/d.md", isMedical: false, today: "2026-10-19" };
const trendPrompt = buildWritingPrompt({ ...jobBase, job: { keyword: "k", headline: null, category: "living", metadata: { source: "trend" } } as never });
assert.ok(trendPrompt.includes("style/trend.md") && !trendPrompt.includes("style/incident.md"), "기존 living 집필 프롬프트는 trend.md");
const inputPrompt = buildWritingPrompt({ ...jobBase, job: { keyword: "k", headline: null, category: "living", metadata: { track: "living" } } as never });
assert.ok(inputPrompt.includes("style/incident.md") && !inputPrompt.includes("style/trend.md"), "입력 툴 일상 job은 incident.md");
const techPrompt = buildWritingPrompt({ ...jobBase, job: { keyword: "k", headline: null, category: "tech", metadata: { track: "tech" } } as never });
assert.ok(techPrompt.includes("style/incident.md"), "테크 job은 incident.md");
// 트렌드 수집·분류 규칙은 tech를 만들지 않는다
for (const kw of ["갤럭시 신제품 출시", "AI 반도체 전망", "아이폰 18", "챗GPT 업데이트", "빨래 냄새 제거"]) {
  assert.notEqual(classifyKeywordCategory(kw), "tech", `분류 규칙은 tech를 돌려주지 않는다: ${kw}`);
}
console.log("✅ 문체 라우팅: 입력 툴 일상·테크=incident / 기존 living(트렌드)=trend 불변 / 분류 규칙은 tech 미생성");

// ---- 7) 발행 게이트: 일상·테크는 뷰어 복붙, 트렌드 living은 그대로 ----
assert.equal(isManualPublishOnly({ category: "person" }), true);
assert.equal(isManualPublishOnly({ category: "tech" }), true);
assert.equal(isManualPublishOnly({ category: "living", metadata: { track: "living" } }), true);
assert.equal(isManualPublishOnly({ category: "living", metadata: { source: "trend" } }), false, "트렌드 living은 발행 버튼 유지");
assert.equal(isManualPublishOnly({ category: "living" }), false);
assert.equal(isManualPublishOnly({ category: "entertainment", metadata: { track: "social" } }), false);
console.log("✅ 발행 게이트(일상·테크 복붙 / 트렌드 living·사회 무영향)");

// ---- 8) 소스 텍스트 주입 라벨 ----
const section = buildUserSourceTextSection("카페 원문입니다.", null).join("\n");
assert.ok(section.includes("## 사용자 제공 소스 텍스트 (1차 근거·출처 불명)"));
assert.ok(section.includes("사실은 공식·뉴스") && section.includes("소스로 재확인한다") && section.includes("표절·유사문서 리스크"));
assert.ok(section.includes("카페 원문입니다."));
assert.ok(buildUserSourceTextSection("출처 있음", "https://blog.naver.com/a/1").join("\n").includes("출처 URL: https://blog.naver.com/a/1"));
assert.deepEqual(buildUserSourceTextSection("   ", null), [], "빈 텍스트는 절을 만들지 않는다");
const researchWith = buildResearchPrompt({ job: { keyword: "k", headline: null, category: "tech" }, baselineSources: [], outputPath: "/o.md", today: "2026-10-19", userSourceText: "붙여넣은 글" });
assert.ok(researchWith.includes("사용자 제공 소스 텍스트") && researchWith.includes("붙여넣은 글") && researchWith.includes("prompts/research/researcher.md"), "사회 규격 researcher.md 그대로 + 소스 절");
const researchWithout = buildResearchPrompt({ job: { keyword: "k", headline: null, category: "tech" }, baselineSources: [], outputPath: "/o.md", today: "2026-10-19" });
assert.ok(!researchWithout.includes("사용자 제공 소스 텍스트"), "소스가 없으면 절이 없다");
console.log("✅ sourceText 주입 라벨(researcher.md 분기 없음)");

// ---- 9) 웹훅 분기 ----
function harness() {
  const rows: InstagramInboxRow[] = [];
  const sent: { text: string; markup?: TelegramReplyMarkup }[] = [];
  const deps: InstagramWebhookDeps = {
    allowedChatId: "99",
    insertInbox: async (row) => { rows.push(row); },
    sendMessage: async (_c, text, markup) => { sent.push({ text, markup }); },
    editReplyMarkup: async () => {},
    now: () => new Date("2026-10-19T00:00:00Z"),
  };
  return { rows, sent, deps };
}
const msg = (id: number, text: string, extra: object = {}) => ({ update_id: id, message: { message_id: id, chat: { id: 99 }, text, ...extra } });

{
  const h = harness();
  const ig = await handleInstagramUpdate(msg(1, "https://www.instagram.com/p/ABC/ 이거"), h.deps);
  assert.equal(ig.handled, "link");
  assert.equal(h.rows[0].instagramUrl, "https://www.instagram.com/p/ABC/");

  const th = await handleInstagramUpdate(msg(2, "https://www.threads.com/@user/post/Cabc 재밌음"), h.deps);
  assert.equal(th.handled, "link");
  assert.equal(h.rows[1].kind, "link");
  assert.equal(h.rows[1].instagramUrl, "https://www.threads.com/@user/post/Cabc");
  assert.equal(h.rows[1].rawCaption, "재밌음");
  const th2 = await handleInstagramUpdate(msg(3, "일상 https://threads.net/@u/post/Zz"), h.deps);
  assert.equal(th2.handled === "link" && th2.track, "living", "스레드 링크에도 트랙 단어가 먹는다");

  const blog = await handleInstagramUpdate(msg(4, "https://blog.naver.com/abc/123"), h.deps);
  assert.deepEqual(blog, { handled: "ignored", reason: "unsupported_url" });
  assert.equal(h.rows.length, 3, "그 외 URL은 A부에서 수신함에 안 넣는다");
  assert.ok(h.sent.at(-1)!.text.includes("지원 예정"));

  const topic = await handleInstagramUpdate(msg(5, "민찌는 무슨 고기일까? 원고 써줘"), h.deps);
  assert.deepEqual(topic, { handled: "input", queueId: "tg-5", kind: "topic" });
  const row = h.rows.at(-1)!;
  assert.equal(row.kind, "input");
  assert.equal(row.instagramUrl, null);
  assert.equal(row.rawCaption, "민찌는 무슨 고기일까? 원고 써줘", "원문은 그대로 수신함, 해석은 맥이 같은 규칙으로");
  const ack = h.sent.at(-1)!;
  assert.ok(ack.text.includes('접수: 주제 "민찌는 무슨 고기일까?"') && ack.text.includes("엔터/사회/일상/테크"));
  const buttons = (ack.markup?.inline_keyboard ?? []).flat().map((b) => b.callback_data);
  assert.deepEqual(buttons, ["igtrack:tg-5:entertainment", "igtrack:tg-5:social", "igtrack:tg-5:living", "igtrack:tg-5:tech"], "4트랙 버튼");

  const longOut = await handleInstagramUpdate(msg(6, longBody), h.deps);
  assert.deepEqual(longOut, { handled: "input", queueId: "tg-6", kind: "source" });
  assert.ok(h.sent.at(-1)!.text.includes("소스 본문"));

  const reply = await handleInstagramUpdate(msg(7, "주제는 이것", { reply_to_message: { message_id: 3 } }), h.deps);
  assert.equal(reply.handled, "reply", "답장은 직접 입력이 아니라 topic_reply");
  const bare = await handleInstagramUpdate(msg(8, "테크"), h.deps);
  assert.equal(bare.handled, "reply", "단어만 보낸 것은 트랙 답");
  assert.equal(h.rows.at(-1)!.replyText, "테크");

  const pick = await handleInstagramUpdate({ update_id: 9, callback_query: { id: "c", data: "igtrack:tg-5:tech", message: { message_id: 20, chat: { id: 99 } } } }, h.deps);
  assert.equal(pick.handled, "track_pick");
  assert.equal(h.rows.at(-1)!.replyText, "track:tg-5:tech");
}
console.log("✅ 웹훅 분기: instagram/threads/그 외 URL/짧은 글/긴 글/답장/단어/테크 버튼");

// ---- 10) 큐 흐름: 긴 글 = needs_topic 상태에서 트랙만 먼저 와도 받는다 ----
{
  const dir = mkdtempSync(join(tmpdir(), "kit-queue-"));
  const path = join(dir, "q.jsonl");
  const longEntry = baseEntry({ id: "L", status: "needs_topic", sourceText: "본문", askedMessageId: 50 });
  const topicEntry = baseEntry({ id: "T", status: "needs_track", userTopic: "주제" });
  const igEntry: InstagramQueueEntry = { ...baseEntry({ id: "I", status: "needs_topic", track: "social" }), source: "instagram", instagramUrl: "https://www.instagram.com/p/a/" };
  writeFileSync(path, [longEntry, topicEntry, igEntry].map((e) => JSON.stringify(e)).join("\n") + "\n");
  assert.deepEqual(listAwaitingTrack(path).map((e) => e.id), ["L", "T"], "트랙 없는 needs_topic도 트랙 대기에 든다. 인스타(트랙 있음)는 제외");
  assert.equal(applyTrackPick("L", "tech", path), "applied");
  assert.equal(applyTrackPick("I", "tech", path), "already_handled", "트랙이 이미 있는 needs_topic은 버튼으로 되돌리지 않는다");
  assert.equal(applyTrackPick("T", "living", path), "applied");
  const after = listAwaitingTrack(path);
  assert.deepEqual(after.map((e) => e.id), [], "트랙이 정해지면 대기에서 빠진다");
  const reply = resolveTrackReply([longEntry, topicEntry], { text: "일상", replyToMessageId: null });
  assert.equal(reply.status, "ambiguous", "여럿이면 다시 묻는다");
}
console.log("✅ 큐: 긴 글은 주제 대기 중에도 트랙을 받는다(인스타 가드 유지)");

// ---- 11) 처리: 직접 입력은 캡처 없이 job, 스레드는 자동 캡처에서 제외 ----
{
  const created: string[] = [];
  const marks: Array<[string, Record<string, unknown>]> = [];
  const researched: string[] = [];
  let captureCalls = 0;
  const result = await processPendingCaptures({
    listPending: () => [baseEntry({ id: "T", track: "tech", userTopic: "주제" })],
    createInput: async (e) => { created.push(e.id); return { jobId: "job-T" }; },
    runSession: async () => { captureCalls += 1; throw new Error("캡처하면 안 된다"); },
    mark: (id, patch) => { marks.push([id, patch as Record<string, unknown>]); },
    triggerResearch: async (id) => { researched.push(id); },
    checkLogin: async () => "logged_in" as never,
  });
  assert.equal(result.created, 1);
  assert.deepEqual(created, ["T"]);
  assert.deepEqual(researched, ["job-T"]);
  assert.equal(captureCalls, 0);

  // createInput이 던지면 실패로 세고 attempts를 올린다(3회 후 skipped)
  const failing = await processPendingCaptures({
    listPending: () => [baseEntry({ id: "F", track: "tech", userTopic: "주제", attempts: 2 })],
    createInput: async () => { throw new Error("db down"); },
    mark: (id, patch) => { marks.push([id, patch as Record<string, unknown>]); },
    triggerResearch: async () => {},
  });
  assert.equal(failing.failed, 1);
  assert.equal(failing.givenUp, 1);
  assert.ok(marks.some(([id, p]) => id === "F" && p.status === "skipped"));
}
console.log("✅ 처리: 직접 입력 → createInput(캡처 없음) / 실패 시 재시도·포기");

console.log("\n✅ testKeywordInput(A부) 전체 통과");
