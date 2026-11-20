// scenepick 트랙 테스트(2026-11-21). DB·codex·Storage·텔레그램 없이 돈다 - 전부 주입한다. 납품물은 임시 폴더에 만든다.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { viewerPageLink, VIEWER_PAGE_FILE } from "../../config/manuscriptViewerPages.js";
import { TRACK_ENV_KEYS, TRACK_PUBLISH_CHANNELS, isChannelAllowedForTrack, trackOfJob } from "../../notifications/telegramTracks.js";
import { buildCodexWorkspaceArgs, isCodexAuthError, parseCodexTokensUsed, runCodexWorkspace, CODEX_LOGIN_MESSAGE } from "../../services/llm/runCodexWorkspace.js";
import type { CodexExecutor, RunCodexWorkspaceOptions, RunCodexWorkspaceResult } from "../../services/llm/runCodexWorkspace.js";
import { parseManuscriptBlocks } from "../manuscripts/parseManuscriptBlocks.js";
import type { ManuscriptTopicEntry } from "../manuscripts/manuscriptManifest.js";
import { renderManuscriptPage } from "../manuscripts/renderManuscriptPage.js";
import { isManualPublishOnly } from "../publish/manualPublishOnly.js";
import { buildScenepickEntry, normalizeScenepickBody } from "./buildScenepickEntry.js";
import { pollScenepickOnce } from "../../jobs/scenepickPollJob.js";
import { MAX_CODEX_RUNS, runScenepickJob, scenepickWorkspace } from "./runScenepickJob.js";
import type { ScenepickJobLike, ScenepickRunDeps } from "./runScenepickJob.js";
import { acceptedReply, handleScenepickTopic, parseScenepickTopic, scenepickJobFields, INPUT_TOPIC_MAX_BYTES } from "./scenepickIntake.js";
import { buildScenepickFixPrompt, buildScenepickPrompt, scenepickOutputDir } from "./scenepickPrompt.js";
import { claimScenepick, pickScenepickDue, STALE_RUNNING_MS } from "./scenepickQueue.js";
import type { ScenepickPendingRow } from "./scenepickQueue.js";
import { SCENEPICK_CATEGORIES, readScenepickState } from "./scenepickTypes.js";
import { validateScenepickDelivery } from "./validateScenepickDelivery.js";
import type { ScenepickValidation } from "./validateScenepickDelivery.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

// ---------- 픽스처 ----------

/** 시그니처만 맞춘 "이미지" 바이트(형식 판정은 매직 바이트로 한다). 크기 하한(10KB 초과)을 넘긴다. */
function fakePng(bytes = 12 * 1024): Buffer {
  const buf = Buffer.alloc(bytes, 7);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  return buf;
}
function fakeJpeg(bytes = 12 * 1024): Buffer {
  const buf = Buffer.alloc(bytes, 3);
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]).copy(buf, 0);
  return buf;
}

const PARAGRAPH = "고양이가 상자를 좋아하는 이유는 여러 연구에서 스트레스 완화와 관련이 있다고 설명합니다. ".repeat(9);

function goodBody(markers = 3): string {
  const parts = ["# 이 H1은 버려져야 한다", "", PARAGRAPH, "", "[IMAGE: 상자 속 고양이 대표 이미지]", ""];
  for (let i = 2; i <= markers; i += 1) {
    parts.push(`## 질문 ${i}: 왜 그럴까?`, "", PARAGRAPH, "", `[IMAGE: 설명 이미지 ${i}]`, "");
  }
  parts.push("## 정리", "", PARAGRAPH);
  return parts.join("\n");
}

function goodMeta(count = 3): Record<string, unknown> {
  return {
    title: "고양이는 왜 상자를 좋아할까?",
    category: "일상 속 과학",
    tags: ["#고양이", "상자", "반려동물", "상자"],
    summary: "고양이가 상자를 좋아하는 이유를 연구 결과로 정리했습니다.",
    images: Array.from({ length: count }, (_, i) => ({
      index: count - i, // 순서를 섞어 둔다 - index로 정렬돼야 한다
      file: `images/${count - i}.png`,
      description: `그림 설명 ${count - i}`,
      ...(count - i === 1 ? { alt: "상자 안에 웅크린 고양이", caption: "AI 생성 이미지입니다.", method: "ai-generated", prompt: "a cat in a box" } : {}),
      ...(count - i === 2 ? { method: "diagram", unknownField: 42 } : {}),
    })),
    sources: [
      { title: "연구 A", url: "https://example.org/a", publishedAt: "2024-01-01", checkedAt: "2026-11-21" },
      { title: "깨진 출처", url: "javascript:alert(1)" },
    ],
    extraTopLevel: "모르는 필드는 무시",
  };
}

async function writeDelivery(dir: string, opts: { body?: string; meta?: unknown; metaRaw?: string; images?: Record<string, Buffer> } = {}): Promise<void> {
  await mkdir(join(dir, "images", "src"), { recursive: true });
  if (opts.body !== undefined) await writeFile(join(dir, "manuscript.md"), opts.body);
  if (opts.metaRaw !== undefined) await writeFile(join(dir, "meta.json"), opts.metaRaw);
  else if (opts.meta !== undefined) await writeFile(join(dir, "meta.json"), JSON.stringify(opts.meta));
  for (const [name, bytes] of Object.entries(opts.images ?? {})) await writeFile(join(dir, name), bytes);
  // 부산물(리드 지시: 있어도 실패하지 않는다)
  await writeFile(join(dir, "sources.json"), "[]");
  await writeFile(join(dir, "review.md"), "검토 메모");
  await writeFile(join(dir, "images", "src", "diagram.svg"), "<svg/>");
}

const goodImages = (n = 3): Record<string, Buffer> =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`images/${i + 1}.png`, i === 1 ? fakeJpeg() : fakePng()]));

const root = await mkdtemp(join(tmpdir(), "scenepick-test-"));
let caseNo = 0;
async function caseDir(): Promise<string> {
  caseNo += 1;
  const dir = join(root, `case-${caseNo}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

try {
  // ---------- 1) 접수 판정 ----------
  const chat = "777";
  const plain = { message: { message_id: 5, chat: { id: 777 }, text: "  고양이는 왜 상자를 좋아할까\n자세히 알려줘  " } };
  const parsed = parseScenepickTopic(plain, chat);
  assert(parsed && parsed.text.startsWith("고양이는") && parsed.messageId === 5 && parsed.chatId === "777", "사회 채팅의 일반 메시지 = 주제");
  assert(parseScenepickTopic({ message: { ...plain.message, reply_to_message: { message_id: 1 } } }, chat) === null, "답장은 주제가 아니다(수정 피드백)");
  assert(parseScenepickTopic({ message: { ...plain.message, text: "/start" } }, chat) === null, "명령은 주제가 아니다");
  assert(parseScenepickTopic({ message: { ...plain.message, chat: { id: 1 } } }, chat) === null, "다른 채팅은 받지 않는다");
  assert(parseScenepickTopic(plain, null) === null, "허용 채팅이 설정되지 않았으면 받지 않는다");
  assert(parseScenepickTopic({ message: { ...plain.message, text: "   " } }, chat) === null, "빈 글은 주제가 아니다");
  assert(parseScenepickTopic({ callback_query: { id: "x" }, message: plain.message }, chat) === null, "버튼(callback)은 주제가 아니다");
  assert(parseScenepickTopic({ message: { message_id: 6, chat: { id: 777 } } }, chat) === null, "글자 없는 메시지(사진 등)는 주제가 아니다");
  console.log("✅ 접수 판정: 일반 메시지만, 답장·명령·다른 채팅·버튼 제외");

  // ---------- 2) job 필드 ----------
  const now = new Date("2026-11-21T03:00:00Z");
  const longLine = "가".repeat(80);
  const fields = scenepickJobFields({ text: `\n${longLine}\n둘째 줄`, messageId: 9, now });
  assert(fields.keyword === "가".repeat(60) && fields.headline === fields.keyword, "keyword = 첫 줄 60자");
  assert(fields.category === "living", "category는 기존 값(living)");
  const meta = fields.metadata as Record<string, unknown>;
  assert(meta.track === "scenepick" && meta.source === "scenepick_input" && meta.scenepickMessageId === 9, "트랙·출처·메시지 번호");
  const state = readScenepickState(meta);
  assert(state?.status === "requested" && state.attempts === 0 && state.requestedAt === now.toISOString(), "대기열 상태 requested, attempts 0");
  const huge = scenepickJobFields({ text: "주제\n" + "긴 글 ".repeat(5000), messageId: null, now });
  assert(Buffer.byteLength(String(huge.metadata.inputTopic), "utf8") <= INPUT_TOPIC_MAX_BYTES, "inputTopic 4KB 상한");
  assert(!("scenepickMessageId" in huge.metadata), "메시지 번호가 없으면 키도 없다");
  assert(trackOfJob({ metadata: meta }) === "scenepick", "trackOfJob: metadata.track=scenepick -> scenepick");
  console.log("✅ job 필드: 첫 줄 keyword, living, requested, 4KB 상한, 트랙 판정");

  // ---------- 3) 접수 처리 ----------
  const created: unknown[] = [];
  const replies: string[] = [];
  const intakeDeps = {
    allowedChatId: chat,
    createJob: async (f: unknown) => {
      created.push(f);
      return { id: "job-new" };
    },
    findByMessageId: async (id: number) => (id === 99 ? { id: "job-old" } : null),
    reply: async (text: string) => void replies.push(text),
    now: () => now,
  };
  const outcome = await handleScenepickTopic(plain, intakeDeps);
  assert(outcome.handled && outcome.status === "created" && outcome.jobId === "job-new", "주제 -> job 생성");
  assert(created.length === 1 && replies[0] === acceptedReply("고양이는 왜 상자를 좋아할까"), "접수 답장");
  assert(replies[0].includes("📝 접수했습니다: 고양이는 왜 상자를 좋아할까") && replies[0].includes("15~30분"), "답장 문구");
  const dup = await handleScenepickTopic({ message: { ...plain.message, message_id: 99 } }, intakeDeps);
  assert(dup.handled && dup.status === "duplicate" && created.length === 1, "같은 메시지 재배달은 job을 또 만들지 않는다");
  const passthrough = await handleScenepickTopic({ message: { ...plain.message, reply_to_message: { message_id: 3 } } }, intakeDeps);
  assert(!passthrough.handled && created.length === 1, "답장은 TelegramBot으로 넘긴다");
  assert(acceptedReply("<a&b>").includes("&lt;a&amp;b&gt;"), "답장은 HTML 이스케이프");
  console.log("✅ 접수 처리: 생성·답장, 중복 방지, 답장은 통과");

  // ---------- 4) 주문서 ----------
  const order = { jobId: "abc-123", topic: "고양이는 왜 상자를 좋아할까", outputDir: scenepickOutputDir("abc-123"), today: "2026-11-21" };
  const prompt = buildScenepickPrompt(order);
  assert(order.outputDir === "jobs/abc-123", "납품 폴더 = jobs/<jobId>");
  for (const piece of ["abc-123", "고양이는 왜 상자를 좋아할까", "jobs/abc-123", "2026-11-21", "AGENTS.md의 납품 규격을 따른다", ...SCENEPICK_CATEGORIES]) {
    assert(prompt.includes(piece), `주문서에 ${piece}`);
  }
  const fix = buildScenepickFixPrompt({ ...order, failures: ["meta.json이 없습니다.", "이미지 2: 파일 images/2.png이 없습니다."] });
  assert(fix.includes("이 항목만 고쳐서 다시 납품") && fix.includes("- meta.json이 없습니다.") && fix.includes("images/2.png"), "재작업 주문에 실패 항목");
  console.log("✅ 주문서: job id·주제·폴더·날짜·카테고리·AGENTS.md, 재작업 주문");

  // ---------- 5) 납품 검사 ----------
  const good = await caseDir();
  await writeDelivery(good, { body: goodBody(), meta: goodMeta(), images: goodImages() });
  const okResult = await validateScenepickDelivery(good);
  assert(okResult.ok, `정상 납품은 통과해야 한다: ${okResult.ok ? "" : okResult.failures.join(" | ")}`);
  assert(okResult.delivery.images.map((i) => i.index).join(",") === "1,2,3", "이미지는 index 순");
  assert(okResult.delivery.images[1].mimeType === "image/jpeg", "실제 바이트로 형식 판정");
  assert(okResult.delivery.tags.join(",") === "고양이,상자,반려동물", "태그 # 제거·중복 제거");
  assert(okResult.delivery.sources.length === 1 && okResult.delivery.sources[0].publishedAt === "2024-01-01", "http(s) 출처만, publishedAt 유지");
  assert(okResult.delivery.images[0].caption === "AI 생성 이미지입니다." && okResult.delivery.images[0].method === "ai-generated", "선택 필드(caption·method) 수용");
  console.log("✅ 정상 납품 통과(부산물 파일·모르는 필드 무시)");

  const expectFail = async (label: string, setup: (dir: string) => Promise<void>, needle: string): Promise<void> => {
    const dir = await caseDir();
    await setup(dir);
    const result = await validateScenepickDelivery(dir);
    assert(!result.ok, `${label}: 실패해야 한다`);
    assert(result.failures.some((f) => f.includes(needle)), `${label}: "${needle}" 항목이 있어야 한다 (실제: ${result.failures.join(" | ")})`);
  };
  await expectFail("meta 없음", (d) => writeDelivery(d, { body: goodBody(), images: goodImages() }), "meta.json이 없습니다");
  await expectFail("본문 없음", (d) => writeDelivery(d, { meta: goodMeta(), images: goodImages() }), "manuscript.md가 없습니다");
  await expectFail("JSON 깨짐", (d) => writeDelivery(d, { body: goodBody(), metaRaw: "{ title: ", images: goodImages() }), "JSON으로 읽을 수 없습니다");
  await expectFail("제목 없음", (d) => writeDelivery(d, { body: goodBody(), meta: { ...goodMeta(), title: "  " }, images: goodImages() }), "title이 비어");
  await expectFail("카테고리 이탈", (d) => writeDelivery(d, { body: goodBody(), meta: { ...goodMeta(), category: "사회" }, images: goodImages() }), "category가 다섯 중 하나가 아닙니다");
  await expectFail("본문 짧음", (d) => writeDelivery(d, { body: "짧다\n\n[IMAGE: a]\n\n[IMAGE: b]\n\n[IMAGE: c]", meta: goodMeta(), images: goodImages() }), "본문이 너무 짧습니다");
  await expectFail("마커 수 불일치", (d) => writeDelivery(d, { body: goodBody(2), meta: goodMeta(), images: goodImages() }), "마커 수(2)");
  await expectFail(
    "index 건너뜀",
    (d) => writeDelivery(d, { body: goodBody(), meta: { ...goodMeta(), images: (goodMeta().images as { index: number }[]).map((img) => (img.index === 3 ? { ...img, index: 4 } : img)) }, images: goodImages() }),
    "1부터 빠짐없이"
  );
  await expectFail("파일 없음", (d) => writeDelivery(d, { body: goodBody(), meta: goodMeta(), images: { "images/1.png": fakePng(), "images/2.png": fakeJpeg() } }), "images/3.png이 없습니다");
  await expectFail("파일 작음", (d) => writeDelivery(d, { body: goodBody(), meta: goodMeta(), images: { ...goodImages(), "images/3.png": fakePng(5000) } }), "너무 작습니다");
  await expectFail("형식 아님", (d) => writeDelivery(d, { body: goodBody(), meta: goodMeta(), images: { ...goodImages(), "images/3.png": Buffer.alloc(20 * 1024, 65) } }), "PNG/JPEG/WEBP가 아닙니다");
  await expectFail("이미지 0장", (d) => writeDelivery(d, { body: goodBody().replace(/\[IMAGE:[^\]]*\]/g, ""), meta: { ...goodMeta(), images: [] }, images: {} }), "이미지가 없습니다");
  await expectFail("문장 속 마커", (d) => writeDelivery(d, { body: goodBody().replace("[IMAGE: 설명 이미지 2]", "문장 앞 [IMAGE: 설명 이미지 2] 문장 뒤"), meta: goodMeta(), images: goodImages() }), "한 줄 전체여야");
  await expectFail(
    "폴더 밖 경로",
    (d) => writeDelivery(d, { body: goodBody(), meta: { ...goodMeta(), images: (goodMeta().images as { index: number; file: string }[]).map((img) => (img.index === 1 ? { ...img, file: "../../etc/passwd" } : img)) }, images: goodImages() }),
    "납품 폴더 안의 상대 경로"
  );
  console.log("✅ 납품 검사 실패 사례 14가지 각각 잡힘");

  // ---------- 6) 뷰어 행 만들기 ----------
  const delivery = okResult.delivery;
  const uploads = delivery.images.map((img) => ({ index: img.index, url: `https://storage.example/${img.index}.webp?v=1`, extension: "webp", width: 1664, height: 936 }));
  const entry = buildScenepickEntry({ jobId: "job-1", keyword: "고양이 상자", delivery, uploads, readyAt: now.toISOString(), date: "2026-11-21", filePath: "x" });
  const body = entry.manuscript.body;
  assert(!body.includes("이 H1은") && !/^#/m.test(body), "H1·# 소제목이 본문에 남지 않는다");
  assert(body.includes("**질문 2: 왜 그럴까?**\n고양이가"), "소제목은 **볼드** 한 줄 + 바로 다음 줄 첫 문단");
  const blocks = parseManuscriptBlocks(body);
  const imageBlocks = blocks.filter((b) => b.type === "image");
  assert(imageBlocks.length === 3, `마커 3개가 이미지 블록으로 인식(실제 ${imageBlocks.length})`);
  assert(blocks.filter((b) => b.type === "heading").length === 3, "소제목 3개가 heading 블록");
  assert(entry.manuscript.images.map((i) => i.index).join(",") === "1,2,3" && entry.manuscript.images.every((i) => i.url?.startsWith("https://storage.example/")), "이미지 index 순 + 업로드 URL");
  assert(entry.manuscript.images[0].description === "상자 안에 웅크린 고양이" && entry.manuscript.images[0].prompt === "a cat in a box", "alt -> description, prompt 유지");
  assert(entry.manuscript.images[0].caption === "AI 생성 이미지입니다." && entry.manuscript.images[1].provider === "codex-diagram" && entry.manuscript.images[0].provider === "codex-ai", "caption·provider(method)");
  assert(entry.manuscript.images[0].fileName === "01.webp" && entry.manuscript.images[0].width === 1664, "파일명·치수");
  assert(entry.manuscript.track === "scenepick" && entry.category === "일상 속 과학", "트랙·블로그 카테고리");
  assert(entry.manuscript.sources?.length === 1 && !body.includes("example.org"), "출처는 본문 밖(entry.sources)에만");
  assert(entry.manuscript.searchDescription === delivery.summary && entry.manuscript.tags.length === 3, "요약·태그");
  assert(normalizeScenepickBody("## A\n\n[IMAGE: x]\n\n본문") === "**A**\n\n[IMAGE: x]\n\n본문", "소제목 바로 뒤 이미지는 붙이지 않는다");
  console.log("✅ 뷰어 행: 소제목 변환, 마커 순서, 이미지·캡션·출처 분리");

  // ---------- 7) 뷰어 페이지 ----------
  const socialTopic: ManuscriptTopicEntry = { ...entry, jobId: "soc-1", manuscript: { ...entry.manuscript, track: "social", title: "사회원고" } };
  const html = renderManuscriptPage({ topics: [entry, socialTopic] }, now, { track: "scenepick" });
  assert(html.includes("scenepick 원고 뷰어") && html.includes("#5B3A8C"), "scenepick 페이지 문구·강조색");
  assert(!html.includes('id="publish-') && !html.includes("/api/publish-request"), "scenepick 페이지에 발행 버튼·요청 코드가 없다");
  assert(html.includes("고양이는 왜 상자를 좋아할까?") && !html.includes("사회원고"), "scenepick 원고만 그린다");
  assert(html.includes("cap-note") && html.includes("src-list"), "그림 아래 캡션·출처 칸");
  const socialHtml = renderManuscriptPage({ topics: [socialTopic] }, now, { track: "social" });
  assert(!socialHtml.includes('id="publish-tistory"') && !socialHtml.includes("/api/publish-request"), "사회 페이지에서 티스토리 버튼이 빠졌다(2026-11-21)");
  assert(VIEWER_PAGE_FILE.scenepick === "scenepick.html" && viewerPageLink("https://x.pages.dev", "scenepick", "j1") === "https://x.pages.dev/scenepick.html#j1", "scenepick.html 링크");
  console.log("✅ 뷰어 페이지: scenepick.html, 버튼 없음, 사회 티스토리 버튼 제거");

  // ---------- 8) 트랙 표 ----------
  assert(JSON.stringify(TRACK_ENV_KEYS.scenepick) === JSON.stringify(TRACK_ENV_KEYS.social), "scenepick은 사회 봇을 같이 쓴다");
  assert(TRACK_PUBLISH_CHANNELS.scenepick.length === 0 && TRACK_PUBLISH_CHANNELS.social.length === 0, "scenepick·사회 발행 버튼 없음");
  assert(!isChannelAllowedForTrack("scenepick", "naver") && !isChannelAllowedForTrack("social", "tistory"), "서버도 받지 않는다");
  assert(isManualPublishOnly({ category: "living", metadata: { track: "scenepick" } }), "scenepick은 수동 발행 전용");
  console.log("✅ 트랙 표: 사회 봇 공유, 발행 채널 없음");

  // ---------- 9) 대기열 ----------
  const t0 = new Date("2026-11-21T05:00:00Z");
  const iso = (msAgo: number) => new Date(t0.getTime() - msAgo).toISOString();
  const rows: ScenepickPendingRow[] = [
    { id: "running-fresh", state: { status: "running", requestedAt: "2026-11-21T01:00:00Z", startedAt: iso(STALE_RUNNING_MS * 2), heartbeatAt: iso(10 * 60 * 1000), claims: 1 } },
    { id: "req-new", state: { status: "requested", requestedAt: "2026-11-21T04:00:00Z" } },
    { id: "req-old", state: { status: "requested", requestedAt: "2026-11-21T03:00:00Z" } },
  ];
  assert(pickScenepickDue(rows, t0)?.id === "req-old", "진행 중(심장 박동 최근)은 건너뛰고 가장 오래된 대기");
  const staleRows: ScenepickPendingRow[] = [{ id: "stale-1", state: { status: "running", requestedAt: "2026-11-21T01:00:00Z", startedAt: iso(STALE_RUNNING_MS + 1000), claims: 1 } }];
  assert(pickScenepickDue(staleRows, t0)?.kind === "stale", "60분 넘은 running(1회 집음) -> 다시 집는다");
  staleRows[0].state.claims = 2;
  assert(pickScenepickDue(staleRows, t0)?.kind === "exhausted", "2회 집은 잔재 -> 실패로 닫는다");
  assert(pickScenepickDue([], t0) === null, "대기 없음");

  const store = new Map<string, Record<string, unknown>>([["j", { scenepickCodex: { status: "requested", requestedAt: "x", attempts: 0 } }]]);
  const queueDeps = {
    findJob: async (id: string) => (store.has(id) ? { metadata: store.get(id)! } : null),
    mergeMetadata: async (id: string, patch: Record<string, unknown>) => void store.set(id, { ...store.get(id)!, ...patch }),
    now: () => t0,
    newClaimId: () => "claim-A",
  };
  assert(await claimScenepick("j", queueDeps), "집기 성공");
  const claimed = readScenepickState(store.get("j"));
  assert(claimed?.status === "running" && claimed.claims === 1 && claimed.heartbeatAt === t0.toISOString(), "running + claims 1 + 심장 박동");
  const racing = { ...queueDeps, mergeMetadata: async (id: string, patch: Record<string, unknown>) => {
    store.set(id, { ...store.get(id)!, ...patch });
    store.set(id, { scenepickCodex: { ...readScenepickState(store.get(id))!, claimId: "someone-else" } });
  } };
  assert(!(await claimScenepick("j", racing)), "다른 폴러가 먼저 쓰면 진다");
  store.set("done", { scenepickCodex: { status: "done", requestedAt: "x", attempts: 1 } });
  assert(!(await claimScenepick("done", queueDeps)), "끝난 job은 집지 않는다");

  const polled: string[] = [];
  const pollOutcome = await pollScenepickOnce({
    loadRows: async () => rows,
    claim: async (id) => (polled.push(`claim:${id}`), true),
    run: async (id) => (polled.push(`run:${id}`), { status: "done", title: "t", category: "c", imageCount: 1, attempts: 1, refresh: "dispatched" }),
    now: () => t0,
  });
  assert(pollOutcome.picked && pollOutcome.jobId === "req-old" && polled.join(",") === "claim:req-old,run:req-old", "폴러: 집고 돌린다");
  const closed: string[] = [];
  const exhaustedOutcome = await pollScenepickOnce({ loadRows: async () => staleRows, closeExhausted: async (id) => void closed.push(id), now: () => t0 });
  assert(exhaustedOutcome.picked && exhaustedOutcome.status === "closed_exhausted" && closed[0] === "stale-1", "폴러: 잔재는 실패로 닫는다");
  console.log("✅ 대기열: 가장 오래된 대기, 심장 박동, 잔재 재집기 1회, claim 경합");

  // ---------- 10) Codex 실행기 ----------
  assert(
    JSON.stringify(buildCodexWorkspaceArgs("/ws")) ===
      JSON.stringify(["exec", "--sandbox", "workspace-write", "--cd", "/ws", "--skip-git-repo-check", "-c", "tools.web_search=true", "-"]),
    "codex 인자: workspace-write, --cd, git 검사 생략, 웹 검색, stdin 프롬프트"
  );
  assert(parseCodexTokensUsed("...\ntokens used\n12,345\n") === 12345 && parseCodexTokensUsed("nothing") === null, "tokens used 파싱");
  assert(isCodexAuthError("Error: Not logged in. Run `codex login`") && !isCodexAuthError("network timeout"), "로그인 오류 판정");
  let seen: { binary: string; args: string[]; stdin: string; cwd: string } | null = null;
  const okExec: CodexExecutor = async (binary, args, o) => {
    seen = { binary, args, stdin: o.stdin, cwd: o.cwd };
    return { code: 0, stdout: "done\ntokens used\n2,000", stderr: "", timedOut: false };
  };
  const okRun = await runCodexWorkspace({ prompt: "주문서", workspace: "/ws", binary: "codex-test", executor: okExec });
  assert(okRun.ok && okRun.tokensUsed === 2000, "성공 + 토큰");
  assert(seen!.stdin === "주문서" && seen!.cwd === "/ws" && seen!.binary === "codex-test", "프롬프트는 stdin, cwd는 작업장");
  const authRun = await runCodexWorkspace({ prompt: "p", workspace: "/ws", executor: async () => ({ code: 1, stdout: "", stderr: "401 Unauthorized: please run codex login", timedOut: false }) });
  assert(!authRun.ok && authRun.authRequired && authRun.error === CODEX_LOGIN_MESSAGE, "로그인 만료 -> 맥미니 codex 로그인 필요");
  const timeoutRun = await runCodexWorkspace({ prompt: "p", workspace: "/ws", executor: async () => ({ code: null, stdout: "", stderr: "", timedOut: true }) });
  assert(!timeoutRun.ok && !timeoutRun.authRequired && timeoutRun.error.includes("40분"), "시한 초과");
  const unauthorizedInBody = await runCodexWorkspace({ prompt: "p", workspace: "/ws", executor: async () => ({ code: 0, stdout: "기사: unauthorized: 접근", stderr: "", timedOut: false }) });
  assert(unauthorizedInBody.ok, "성공한 실행은 본문 글자로 로그인 오류를 판정하지 않는다");
  assert(scenepickWorkspace({}).endsWith("blog-automation/scenepick-workspace") && scenepickWorkspace({ SCENEPICK_WORKSPACE: "/tmp/ws" }) === "/tmp/ws", "작업장 기본값·환경변수");
  console.log("✅ Codex 실행기: 인자·stdin·토큰·로그인 만료·시한");

  // ---------- 11) job 1건 끝까지 ----------
  const agentsSource = join(root, "AGENTS.md");
  await writeFile(agentsSource, "# 발주서");

  type Harness = {
    deps: ScenepickRunDeps;
    log: string[];
    jobMeta: Record<string, unknown>;
    notified: string[];
    topics: ManuscriptTopicEntry[];
    codexPrompts: string[];
  };
  const harness = (opts: { codex: (prompt: string, call: number) => Promise<RunCodexWorkspaceResult>; validate: (call: number) => Promise<ScenepickValidation>; attempts?: number; agents?: string; workspace: string }): Harness => {
    const log: string[] = [];
    const notified: string[] = [];
    const topics: ManuscriptTopicEntry[] = [];
    const codexPrompts: string[] = [];
    const job: ScenepickJobLike = {
      id: "job-run",
      keyword: "고양이 상자",
      metadata: { track: "scenepick", inputTopic: "고양이는 왜 상자를 좋아할까", scenepickCodex: { status: "running", requestedAt: "2026-11-21T02:00:00Z", attempts: opts.attempts ?? 0, claims: 1 } },
    };
    let codexCalls = 0;
    let validateCalls = 0;
    const h: Harness = {
      log,
      jobMeta: job.metadata!,
      notified,
      topics,
      codexPrompts,
      deps: {
        findJob: async () => ({ ...job, metadata: h.jobMeta }),
        queue: {
          findJob: async () => ({ metadata: h.jobMeta }),
          mergeMetadata: async (_id, patch) => void (h.jobMeta = { ...h.jobMeta, ...patch }),
        },
        mergeMetadata: async (_id, patch) => {
          log.push(`merge:${Object.keys(patch).join(",")}`);
          h.jobMeta = { ...h.jobMeta, ...patch };
        },
        updateStatus: async (_id, status) => void log.push(`status:${status}`),
        runCodex: async (o: RunCodexWorkspaceOptions) => {
          codexCalls += 1;
          codexPrompts.push(o.prompt);
          log.push(`codex:${codexCalls}`);
          return opts.codex(o.prompt, codexCalls);
        },
        validate: async () => {
          validateCalls += 1;
          return opts.validate(validateCalls);
        },
        uploadImage: async (input) => {
          log.push(`upload:${input.index}:${input.optimize === true ? "photo" : "diagram"}`);
          return { ok: true, url: `https://s/${input.index}.webp`, path: "p", extension: "webp", width: 10, height: 5 };
        },
        saveTopic: async (topic) => {
          log.push("saveTopic");
          topics.push(topic);
        },
        dispatchRefresh: async () => (log.push("refresh"), "dispatched"),
        pageUrlFor: (jobId) => `https://x.pages.dev/scenepick.html#${jobId}`,
        notify: async (_job, text) => void notified.push(text),
        workspace: opts.workspace,
        agentsSourcePath: opts.agents ?? agentsSource,
        now: () => now,
      },
    };
    return h;
  };
  const okCodex = async (): Promise<RunCodexWorkspaceResult> => ({ ok: true, durationMs: 1, tokensUsed: 1000, stdoutTail: "" });

  // 11-a) 1회차 형식 실패 -> 재작업 주문 -> 통과
  const ws1 = join(root, "ws1");
  const h1 = harness({
    workspace: ws1,
    codex: okCodex,
    validate: async (call) => (call === 1 ? { ok: false, failures: ["meta.json이 없습니다."] } : okResult),
  });
  const r1 = await runScenepickJob("job-run", h1.deps);
  assert(r1.status === "done" && r1.attempts === 2 && r1.imageCount === 3, `재작업 뒤 완료 (실제 ${JSON.stringify(r1)})`);
  assert(h1.codexPrompts[0].includes("# scenepick 원고 발주") && h1.codexPrompts[1].includes("이 항목만 고쳐서 다시 납품") && h1.codexPrompts[1].includes("meta.json이 없습니다."), "1회차 발주, 2회차 재작업 주문");
  assert(h1.log.filter((l) => l.startsWith("upload:")).join(",") === "upload:1:photo,upload:2:diagram,upload:3:photo", "이미지 업로드(도해는 화질 보존)");
  const order1 = ["saveTopic", "merge:channelManuscriptsReadyAt", "status:approved", "refresh"].map((step) => h1.log.indexOf(step));
  assert(order1.every((i, k) => i >= 0 && (k === 0 || i > order1[k - 1])), `저장 -> 준비 시각 -> approved -> 재배포 순서 (실제 ${h1.log.join(",")})`);
  assert(h1.topics.length === 1 && h1.topics[0].manuscript.track === "scenepick", "manifest에는 이 원고 한 행만");
  const done = readScenepickState(h1.jobMeta);
  assert(done?.status === "done" && done.tokensUsed === 2000 && done.title === "고양이는 왜 상자를 좋아할까?" && done.imageCount === 3 && typeof done.durationSec === "number", "done + 토큰·제목·이미지 수·소요");
  assert(
    h1.notified[0] === "✅ 원고 준비 완료 — 고양이는 왜 상자를 좋아할까?\n카테고리: 일상 속 과학 · 이미지 3장\nhttps://x.pages.dev/scenepick.html#job-run",
    `완료 알림 문구 (실제 ${h1.notified[0]})`
  );
  const { readFile } = await import("node:fs/promises");
  assert((await readFile(join(ws1, "AGENTS.md"), "utf8")) === "# 발주서", "AGENTS.md를 작업장 루트로 복사");
  console.log("✅ 1건 처리: 재작업 1회 뒤 완료, 업로드·한 행 저장·마감 순서·알림");

  // 11-b) 두 번 다 형식 실패 -> 실패 마감
  const h2 = harness({ workspace: join(root, "ws2"), codex: okCodex, validate: async () => ({ ok: false, failures: ["본문이 너무 짧습니다.", "이미지가 없습니다.", "title이 비어 있습니다."] }) });
  const r2 = await runScenepickJob("job-run", h2.deps);
  assert(r2.status === "failed" && h2.codexPrompts.length === MAX_CODEX_RUNS, "2회 모두 실패 -> 실패(Codex는 2회까지)");
  assert(h2.log.includes("status:rejected") && h2.log.includes("merge:rejectedAt") && !h2.log.includes("saveTopic"), "실패는 rejected, 뷰어에 안 올린다");
  assert(h2.notified[0].startsWith("⚠️ 원고 발주 실패 — 고양이 상자\n원인: 본문이 너무 짧습니다. / 이미지가 없습니다. 외 1건") && h2.notified[0].endsWith("다시 보내면 새로 발주합니다."), `실패 알림 (실제 ${h2.notified[0]})`);
  assert(readScenepickState(h2.jobMeta)?.status === "failed", "상태 failed");
  console.log("✅ 2회 형식 실패 -> failed + rejected + 알림");

  // 11-c) 로그인 만료 -> 즉시 실패, 재작업 없음
  const h3 = harness({
    workspace: join(root, "ws3"),
    codex: async () => ({ ok: false, error: CODEX_LOGIN_MESSAGE, authRequired: true, durationMs: 1, tokensUsed: null, stdoutTail: "" }),
    validate: async () => okResult,
  });
  const r3 = await runScenepickJob("job-run", h3.deps);
  assert(r3.status === "failed" && r3.authRequired && h3.codexPrompts.length === 1, "로그인 만료는 재시도하지 않는다");
  assert(h3.notified[0].includes("맥미니 codex 로그인 필요"), "알림에 로그인 필요");
  console.log("✅ 로그인 만료 -> 즉시 실패(맥미니 codex 로그인 필요)");

  // 11-d) 지침 파일 없음 -> Codex를 부르지 않고 실패
  const h4 = harness({ workspace: join(root, "ws4"), agents: join(root, "missing.md"), codex: okCodex, validate: async () => okResult });
  const r4 = await runScenepickJob("job-run", h4.deps);
  assert(r4.status === "failed" && r4.error.includes("발주 지침 파일이 없습니다") && h4.codexPrompts.length === 0, "AGENTS.md 없으면 분명한 사유로 실패");
  console.log("✅ 지침 파일 없음 -> Codex 호출 없이 실패");

  // 11-e) 잔재 재집기: 이미 통과하는 납품이 있으면 Codex를 다시 부르지 않는다. package/는 건드리지 않는다.
  const ws5 = join(root, "ws5");
  await mkdir(join(ws5, "package"), { recursive: true });
  await writeFile(join(ws5, "package", "style.md"), "사용자 문체 패키지");
  const h5 = harness({ workspace: ws5, attempts: 1, codex: okCodex, validate: async () => okResult });
  const r5 = await runScenepickJob("job-run", h5.deps);
  assert(r5.status === "done" && h5.codexPrompts.length === 0, "앞선 회차의 납품이 통과하면 그대로 받는다");
  assert((await readFile(join(ws5, "package", "style.md"), "utf8")) === "사용자 문체 패키지", "package/는 손대지 않는다");
  console.log("✅ 잔재 재집기: 통과한 납품은 그대로 받음, package/ 보존");

  // 11-f) Codex가 오류로 끝나도 납품이 통과하면 받는다 / 끝난 job은 건너뛴다
  const h6 = harness({ workspace: join(root, "ws6"), codex: async () => ({ ok: false, error: "exit 1", authRequired: false, durationMs: 1, tokensUsed: null, stdoutTail: "" }), validate: async () => okResult });
  assert((await runScenepickJob("job-run", h6.deps)).status === "done", "실행 오류여도 납품이 통과하면 완료");
  const h7 = harness({ workspace: join(root, "ws7"), codex: okCodex, validate: async () => okResult });
  h7.jobMeta = { ...h7.jobMeta, scenepickCodex: { status: "done", requestedAt: "x", attempts: 1 } };
  const r7 = await runScenepickJob("job-run", h7.deps);
  assert(r7.status === "skipped" && h7.codexPrompts.length === 0, "끝난 job은 건너뛴다(--force 없이)");
  const r7f = await runScenepickJob("job-run", h7.deps, { force: true });
  assert(r7f.status === "done" && (h7.codexPrompts.length as number) === 1, "--force는 끝난 job도 다시 돈다");
  console.log("✅ 실행 오류여도 통과 납품은 받음, 끝난 job 건너뜀, --force");

  console.log("\n✅ testScenepick 전체 통과");
} finally {
  await rm(root, { recursive: true, force: true });
}
