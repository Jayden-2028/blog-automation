// 인물 제미나이 그림자 트랙 테스트. 실행: npm run test:gemini-person
// 외부 호출 없음 - fetch·Supabase·Telegram·GitHub는 전부 주입한다(실제 API를 부르지 않는다).
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { GEMINI_PERSON_MODEL, isGeminiPersonShadowEnabled } from "../../config/geminiPerson.js";
import { runGeminiResearch } from "../../services/llm/runGeminiResearch.js";
import type { RunGeminiResearchResult } from "../../services/llm/runGeminiResearch.js";
import type { ArticleJobRow } from "../../types/database.js";
import { dispatchResearch } from "../research/dispatchResearch.js";
import { renderManuscriptPage } from "../manuscripts/renderManuscriptPage.js";
import { withoutGeminiShadow } from "../manuscripts/manuscriptManifest.js";
import type { ManuscriptManifest, ManuscriptTopicEntry } from "../manuscripts/manuscriptManifest.js";
import { dispatchGeminiPersonShadow } from "./dispatchGeminiPersonShadow.js";
import { buildGeminiPersonResearchPrompt, buildGeminiPersonWritePrompt } from "./geminiPersonPrompts.js";
import { parseGeminiPersonOutput } from "./parseGeminiPersonOutput.js";
import { buildSources, runGeminiPerson } from "./runGeminiPerson.js";
import type { GeminiPersonDeps } from "./runGeminiPerson.js";
import { attachGeminiShadows, parseGeminiBody, toGeminiPageView } from "./geminiShadowView.js";
import type { GeminiShadow } from "./geminiShadowTypes.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const JOB_ID = "11111111-2222-4333-8444-555555555555";

function job(overrides: Partial<ArticleJobRow> = {}, metadata: Record<string, unknown> = {}): ArticleJobRow {
  return {
    id: JOB_ID,
    source_run_id: 1,
    source_rank: 1,
    keyword: "홍길동",
    headline: null,
    seed_query: null,
    category: "person",
    total_score: null,
    score_breakdown: null,
    status: "selected",
    selected_at: "2026-11-19T00:00:00Z",
    selected_via: "telegram",
    metadata: { personBackground: "드라마 주연으로 화제", ...metadata },
    created_at: "2026-11-19T00:00:00Z",
    updated_at: "2026-11-19T00:00:00Z",
    ...overrides,
  };
}

// ── 1) 프롬프트는 zero-base다 ──────────────────────────────────────────────
{
  const subject = { name: "홍길동", requestNote: "드라마 주연으로 화제" };
  const research = buildGeminiPersonResearchPrompt(subject);
  const write = buildGeminiPersonWritePrompt(subject, "조사 노트 본문 https://example.com/a");
  assert(research.includes("홍길동") && research.includes("드라마 주연으로 화제"), "조사 프롬프트에 인물과 요청 설명이 들어간다");
  assert(research.includes("출처 URL을 남겨라"), "조사 프롬프트는 출처 URL을 요구한다");
  assert(research.length < 400, `조사 프롬프트는 짧아야 한다(실제 ${research.length}자)`);
  assert(write.includes("# 제목") && write.includes("조사 노트 본문"), "집필 프롬프트는 출력 약속과 조사 노트를 담는다");

  // 저장소 작성 규격의 고유 문장(20자 이상 줄)이 프롬프트에 섞이면 안 된다.
  const specFiles = ["prompts/research/researcher.md", "prompts/research/person-researcher.md", "prompts/writing/core-rules.md", "prompts/writing/writer.md"];
  for (const dir of ["prompts/writing/style", "prompts/writing/rules"]) {
    for (const name of readdirSync(join(process.cwd(), dir))) specFiles.push(`${dir}/${name}`);
  }
  specFiles.push("docs/seo-guide.md");
  const prompts = `${research}\n${write.replace("조사 노트 본문 https://example.com/a", "")}`;
  let compared = 0;
  for (const file of specFiles) {
    if (!existsSync(join(process.cwd(), file)) || !statSync(join(process.cwd(), file)).isFile()) continue;
    const text = readFileSync(join(process.cwd(), file), "utf-8");
    for (const line of text.split("\n").map((l) => l.trim()).filter((l) => l.length >= 20)) {
      compared += 1;
      assert(!prompts.includes(line), `프롬프트에 규격 문장이 섞였다(${file}): ${line.slice(0, 40)}`);
    }
  }
  assert(compared > 200, `규격 대조 줄 수가 너무 적다(${compared}) - 파일 경로가 바뀌었나?`);
  for (const banned of ["core-rules", "writer.md", "researcher.md", "금지 표현", "[IMAGE", "이미지", "소제목", "글자", "자 이상", "해요체", "합쇼체"]) {
    assert(!prompts.includes(banned), `프롬프트에 규격 용어가 있다: ${banned}`);
  }
  // 모듈 소스도 규격을 불러오지 않는다(import 줄만 본다 - 머리 주석은 금지 대상 이름을 적고 있다).
  for (const file of ["geminiPersonPrompts.ts", "runGeminiPerson.ts"]) {
    const imports = readFileSync(join(process.cwd(), "src/workflows/gemini-person", file), "utf-8")
      .split("\n")
      .filter((l) => /^\s*import\b/.test(l));
    for (const line of imports) {
      assert(!/specFiles|core-rules|writer|researcher|style|rules|seo|prompts\//.test(line), `${file}가 규격 모듈을 import한다: ${line}`);
    }
    const body = readFileSync(join(process.cwd(), "src/workflows/gemini-person", file), "utf-8");
    assert(!/readFile(Sync)?\(/.test(body), `${file}가 파일을 읽는다 - 프롬프트는 상수여야 한다`);
  }
  // 요청 설명이 아주 길어도 잘린다.
  assert(buildGeminiPersonResearchPrompt({ name: "A", requestNote: "가".repeat(5000) }).length < 1_800, "요청 설명 상한");
  console.log("✅ 프롬프트는 짧고 규격 문장·용어·이미지 요청이 없다(규격 파일 대조 %d줄)", compared);
}

// ── 2) 출력 파싱 ────────────────────────────────────────────────────────────
{
  const ok = parseGeminiPersonOutput("\n# 홍길동, 그가 걸어온 길\n\n## 데뷔\n본문입니다.\n");
  assert(ok?.title === "홍길동, 그가 걸어온 길" && ok.body.startsWith("## 데뷔") && !ok.warning, "# 제목 + 본문");
  const fenced = parseGeminiPersonOutput("```markdown\n# 제목\n본문\n```");
  assert(fenced?.title === "제목" && fenced.body === "본문", "코드펜스로 감싼 출력도 푼다");
  const noHash = parseGeminiPersonOutput("**제목 줄**\n본문");
  assert(noHash?.title === "제목 줄" && noHash.warning, "제목 줄 형식이 어긋나면 첫 줄을 제목으로 쓰고 경고한다");
  assert(parseGeminiPersonOutput("  \n \n") === null, "빈 출력은 null");
  console.log("✅ 출력 파싱(제목/본문/펜스/경고/빈 출력)");
}

// ── 3) 래퍼: 주입한 fetch로 grounding 옵션·사용량 필드 ───────────────────────
{
  const bodies: Record<string, unknown>[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: "응답" }] }, groundingMetadata: { groundingChunks: [{ web: { uri: "https://a.example/x", title: "a.example" } }] } }],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, totalTokenCount: 400, thoughtsTokenCount: 200, toolUsePromptTokenCount: 50 },
      }),
      { status: 200 }
    );
  }) as typeof fetch;
  try {
    const grounded = await runGeminiResearch({ prompt: "p", apiKey: "dummy-not-a-real-key" });
    const plain = await runGeminiResearch({ prompt: "p", apiKey: "dummy-not-a-real-key", grounding: false, temperature: 0.7, maxOutputTokens: 1234 });
    assert(grounded.ok && plain.ok, "래퍼 호출 성공");
    assert(Array.isArray(bodies[0].tools) && !("tools" in bodies[1]), "grounding 기본 켜짐, false면 tools 없음");
    const gen = bodies[1].generationConfig as { temperature: number; maxOutputTokens: number };
    assert(gen.temperature === 0.7 && gen.maxOutputTokens === 1234, "temperature/maxOutputTokens 전달");
    assert(grounded.ok && grounded.usage?.thinkingTokens === 200 && grounded.usage.toolUseTokens === 50, "thinking·도구 토큰을 읽는다");
  } finally {
    globalThis.fetch = realFetch;
  }
  console.log("✅ runGeminiResearch 확장(grounding 토글·temperature·thinking/toolUse 토큰)");
}

// ── 공용 가짜 ───────────────────────────────────────────────────────────────
function okResult(text: string, withSource = true): RunGeminiResearchResult {
  return {
    ok: true,
    text,
    groundingSources: withSource ? [{ title: "news.example", url: "https://news.example/a?utm_source=x" }] : [],
    durationMs: 1000,
    model: "gemini-3.1-pro-preview",
    usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 2500, thinkingTokens: 1000, toolUseTokens: 200 },
  };
}

type Harness = { deps: GeminiPersonDeps; merges: Record<string, unknown>[]; prompts: string[]; calls: unknown[]; notices: { text: string; pageUrl: string | null }[]; refreshes: number; usage: unknown[] };

function harness(options: { job?: ArticleJobRow | null; responses?: RunGeminiResearchResult[]; hasEntry?: boolean; enabled?: boolean; mergeThrows?: boolean; notifyThrows?: boolean } = {}): Harness {
  const h: Harness = { deps: {}, merges: [], prompts: [], calls: [], notices: [], refreshes: 0, usage: [] };
  const responses = [...(options.responses ?? [okResult("조사 노트\n출처: https://wiki.example/홍길동"), okResult("# 홍길동의 길\n\n## 데뷔\n그는 무대에서 시작했다.")])];
  let current = options.job === undefined ? job() : options.job;
  h.deps = {
    findJob: async () => current,
    mergeMetadata: async (_id, patch) => {
      if (options.mergeThrows) throw new Error("merge boom");
      h.merges.push(patch);
      if (current && "geminiShadow" in patch) current = { ...current, metadata: { ...current.metadata, geminiShadow: patch.geminiShadow } };
    },
    callGemini: (async (opts: { prompt: string }) => {
      h.prompts.push(opts.prompt);
      h.calls.push(opts);
      const next = responses.shift();
      if (!next) throw new Error("응답 소진");
      return next;
    }) as GeminiPersonDeps["callGemini"],
    recordUsage: async (input) => void h.usage.push(input),
    fetchImpl: (async (url: string) => ({ url: url.includes("grounding-api-redirect") ? "https://resolved.example/page" : url })) as unknown as typeof fetch,
    hasManifestEntry: async () => options.hasEntry ?? false,
    dispatchRefresh: async () => void (h.refreshes += 1),
    notify: async (_job, text, pageUrl) => {
      if (options.notifyThrows) throw new Error("telegram boom");
      h.notices.push({ text, pageUrl });
    },
    pageUrlFor: () => "https://pages.example/#" + JOB_ID,
    now: () => new Date("2026-11-19T01:00:00Z"),
    isEnabled: () => options.enabled ?? true,
  };
  return h;
}

// ── 4) 정상 실행: 메타데이터 모양·사용량·호출 설정 ───────────────────────────
{
  const h = harness();
  const result = await runGeminiPerson(JOB_ID, {}, h.deps);
  assert(result.status === "done", `정상 실행은 done이어야 한다: ${JSON.stringify(result)}`);
  const stored = h.merges[h.merges.length - 1].geminiShadow as GeminiShadow;
  assert(h.merges.length === 2 && (h.merges[0].geminiShadow as GeminiShadow).startedAt, "시작 기록과 완료 기록 두 번 병합한다");
  assert(stored.model === GEMINI_PERSON_MODEL && stored.title === "홍길동의 길" && stored.body?.startsWith("## 데뷔"), "model/title/body");
  assert(stored.researchNotes?.includes("조사 노트") && stored.requestedAt && stored.startedAt && stored.finishedAt && !stored.error, "researchNotes/시각");
  assert(Array.isArray(stored.sources) && stored.sources.length >= 2, "출처: grounding + 노트 URL");
  const urls = stored.sources.map((s) => s.url);
  assert(urls.includes("https://news.example/a?utm_source=x") || urls.some((u) => u.startsWith("https://news.example")), "grounding 출처");
  assert(urls.includes("https://wiki.example/홍길동") && stored.sources.some((s) => s.via === "notes"), "조사 노트에 적힌 URL 출처");
  assert(new Set(urls.map((u) => u.split("?")[0])).size === urls.length, "중복 출처 없음");
  // 사용량: 입력 = prompt + toolUse, 출력 = candidates + thinking
  const u = stored.usage;
  assert(u?.research?.thinkingTokens === 1000 && u.write && u.totalCostUsd != null, "usage 구조");
  const expectedEach = (1200 * 2 + 1500 * 12) / 1_000_000;
  assert(Math.abs((u.research?.costUsd ?? 0) - expectedEach) < 1e-9, `호출당 비용 $${expectedEach} (실제 ${u.research?.costUsd})`);
  assert(h.usage.length === 2, "recordApiUsage가 두 번 불린다");
  const rec = h.usage[0] as { provider: string; operation: string; jobId: string; usage: { inputTokens: number; outputTokens: number } };
  assert(rec.provider === "gemini" && rec.jobId === JOB_ID && rec.operation === "gemini-person.research", "원장에 job_id가 붙는다");
  assert(rec.usage.inputTokens === 1200 && rec.usage.outputTokens === 1500, "원장 토큰은 도구/thinking을 합산한다");
  // 호출 설정: 둘 다 grounding, 집필 프롬프트에 조사 노트가 들어간다
  assert((h.calls[0] as { grounding: boolean }).grounding === true && (h.calls[1] as { grounding: boolean }).grounding === true, "두 호출 모두 grounding");
  assert(h.prompts[1].includes("조사 노트"), "집필 프롬프트에 조사 노트가 실린다");
  assert(!h.prompts.join("\n").includes("[IMAGE"), "이미지 마커를 요청하지 않는다");
  // 뷰어 행이 없으면 페이지 갱신·알림이 없다
  assert(h.refreshes === 0 && h.notices.length === 0 && result.status === "done" && !result.pageRefreshed, "페이지가 아직 없으면 저장만 한다");
  console.log("✅ 정상 실행: 메타데이터 모양·출처·사용량·원장(job_id)·호출 설정");
}

// ── 5) 페이지가 이미 있으면 갱신 + 알림 한 통 ────────────────────────────────
{
  const h = harness({ hasEntry: true });
  const result = await runGeminiPerson(JOB_ID, {}, h.deps);
  assert(result.status === "done" && result.pageRefreshed, "페이지 갱신 발화");
  assert(h.refreshes === 1 && h.notices.length === 1 && h.notices[0].pageUrl?.includes(JOB_ID), "갱신 1회 + 텔레그램 1통(📄 링크)");
  const failing = harness({ hasEntry: true, notifyThrows: true });
  const r2 = await runGeminiPerson(JOB_ID, {}, failing.deps);
  assert(r2.status === "done", "알림이 실패해도 결과는 done(저장됨)");
  console.log("✅ 완료 후 페이지 갱신 1회 + 알림 1통, 알림 실패는 결과를 바꾸지 않는다");
}

// ── 6) 킬 스위치·멱등·비 person ─────────────────────────────────────────────
{
  assert(isGeminiPersonShadowEnabled(undefined) && isGeminiPersonShadowEnabled("") && isGeminiPersonShadowEnabled("  ") && isGeminiPersonShadowEnabled("true"), "미설정·빈 값·true = 켜짐");
  assert(!isGeminiPersonShadowEnabled("false") && !isGeminiPersonShadowEnabled(" FALSE ") && !isGeminiPersonShadowEnabled("0") && !isGeminiPersonShadowEnabled("off"), "false/0/off = 꺼짐");

  const off = harness({ enabled: false });
  assert((await runGeminiPerson(JOB_ID, {}, off.deps)).status === "skipped" && off.calls.length === 0 && off.merges.length === 0, "스위치 꺼짐: 호출도 기록도 없다");

  let dispatched: number = 0;
  const count = (): number => dispatched;
  const base = { hasGithubToken: () => true, dispatch: async () => void (dispatched += 1), now: () => new Date("2026-11-19T01:00:00Z") };
  const merges: Record<string, unknown>[] = [];
  const mk = (j: ArticleJobRow | null) => ({ ...base, findJob: async () => j, mergeMetadata: async (_: string, p: Record<string, unknown>) => void merges.push(p) });

  assert((await dispatchGeminiPersonShadow(JOB_ID, { ...mk(job()), isEnabled: () => false })).dispatched === false && count() === 0, "디스패치도 스위치를 따른다");
  const first = await dispatchGeminiPersonShadow(JOB_ID, { ...mk(job()), isEnabled: () => true });
  assert(first.dispatched && count() === 1 && (merges[0].geminiShadow as { requestedAt: string }).requestedAt, "새 person job: requestedAt을 적고 디스패치");
  const again = await dispatchGeminiPersonShadow(JOB_ID, { ...mk(job({}, { geminiShadow: { requestedAt: "2026-11-19T00:00:00Z" } })), isEnabled: () => true });
  assert(!again.dispatched && again.reason === "already_requested" && count() === 1, "멱등: requestedAt이 있으면 다시 쏘지 않는다");
  for (const [label, j, reason] of [
    ["엔터 키워드", job({ category: "entertainment" }), "not_person"],
    ["카테고리 없음", job({ category: null }), "not_person"],
    ["수정/진행 중(status)", job({ status: "writing" }), "status_writing"],
    ["조사 재시도", job({}, { forceFreshResearch: true }), "re_research"],
  ] as const) {
    const r = await dispatchGeminiPersonShadow(JOB_ID, { ...mk(j), isEnabled: () => true });
    assert(!r.dispatched && r.reason === reason && count() === 1, `${label}: 디스패치 없음(${reason})`);
  }
  const mergesBefore: number = merges.length;
  const noToken = await dispatchGeminiPersonShadow(JOB_ID, { ...mk(job()), isEnabled: () => true, hasGithubToken: () => false });
  assert(!noToken.dispatched && noToken.reason === "no_github_token" && merges.length === mergesBefore, "토큰이 없으면 키도 적지 않는다(나중에 다시 시도 가능)");

  // 디스패치가 실패하면 던지지 않고 키를 지운다.
  const cleaned: Record<string, unknown>[] = [];
  const failed = await dispatchGeminiPersonShadow(JOB_ID, {
    ...mk(job()),
    isEnabled: () => true,
    mergeMetadata: async (_: string, p: Record<string, unknown>) => void cleaned.push(p),
    dispatch: async () => {
      throw new Error("GitHub 500");
    },
  });
  assert(!failed.dispatched && cleaned.length === 2 && cleaned[1].geminiShadow === null, "디스패치 실패: 던지지 않고 requestedAt을 지운다");

  // 실행 쪽 멱등: 끝난 기록이 있으면 건너뛰고 force면 다시 돈다.
  const doneJob = job({}, { geminiShadow: { requestedAt: "2026-11-19T00:00:00Z", startedAt: "2026-11-19T00:00:10Z", finishedAt: "2026-11-19T00:10:00Z", title: "t", body: "b" } });
  const skip = harness({ job: doneJob });
  assert((await runGeminiPerson(JOB_ID, {}, skip.deps)).status === "skipped" && skip.calls.length === 0, "끝난 기록이 있으면 건너뛴다");
  const forced = harness({ job: doneJob });
  assert((await runGeminiPerson(JOB_ID, { force: true }, forced.deps)).status === "done" && forced.calls.length === 2, "force면 다시 돈다");
  const running = harness({ job: job({}, { geminiShadow: { requestedAt: "2026-11-19T00:00:00Z", startedAt: "2026-11-19T00:50:00Z" } }) });
  assert((await runGeminiPerson(JOB_ID, {}, running.deps)).status === "skipped", "30분 안에 시작된 실행이 있으면 건너뛴다");
  const nonPerson = harness({ job: job({ category: "entertainment" }) });
  assert((await runGeminiPerson(JOB_ID, {}, nonPerson.deps)).status === "skipped" && nonPerson.calls.length === 0, "person이 아니면 실행하지 않는다");
  console.log("✅ 킬 스위치·멱등·비 person·재시도·디스패치 실패 처리");
}

// ── 7) 실패는 던지지 않는다 ─────────────────────────────────────────────────
{
  const apiFail = harness({ responses: [{ ok: false, error: "Gemini API가 429로 응답했습니다", durationMs: 5 }] });
  const r = await runGeminiPerson(JOB_ID, {}, apiFail.deps);
  assert(r.status === "failed" && r.shadow.error?.includes("429") && r.shadow.finishedAt, "API 실패: failed + error 기록");
  assert(apiFail.notices.length === 1 && apiFail.notices[0].text.includes("실패"), "실패 시 텔레그램 한 줄");
  assert(apiFail.usage.length === 0, "실패한 호출은 원장에 올리지 않는다");

  const writeFail = harness({ responses: [okResult("노트"), { ok: false, error: "시간 초과", durationMs: 5 }] });
  const r2 = await runGeminiPerson(JOB_ID, {}, writeFail.deps);
  assert(r2.status === "failed" && r2.shadow.researchNotes === "노트" && writeFail.usage.length === 1, "집필 실패: 조사 노트는 남기고 조사 비용만 기록");

  const thrown = harness();
  thrown.deps.callGemini = (async () => {
    throw new Error("네트워크 폭발");
  }) as GeminiPersonDeps["callGemini"];
  assert((await runGeminiPerson(JOB_ID, {}, thrown.deps)).status === "failed", "호출이 던져도 failed로 돌려준다");

  const storeFail = harness({ mergeThrows: true });
  assert((await runGeminiPerson(JOB_ID, {}, storeFail.deps)).status === "failed", "저장소가 죽어도 던지지 않는다");

  const emptyOut = harness({ responses: [okResult("노트"), okResult("   ")] });
  assert((await runGeminiPerson(JOB_ID, {}, emptyOut.deps)).status === "failed", "빈 집필 결과는 failed");

  const missing = harness({ job: null });
  assert((await runGeminiPerson(JOB_ID, {}, missing.deps)).status === "skipped", "job이 없으면 skipped");
  console.log("✅ 실패 경로: API 실패·집필 실패·예외·저장 실패·빈 결과 모두 던지지 않고 기록한다");
}

// ── 8) dispatchResearch 연결: 기존 흐름이 먼저, 그림자 실패는 영향 없음 ────────
{
  const order: string[] = [];
  const result = await dispatchResearch(JOB_ID, {
    provider: "claude",
    hasGithubToken: () => true,
    enqueue: async () => void order.push("research"),
    dispatchShadow: async () => void order.push("shadow"),
  });
  assert(result.route === "actions" && result.queued && order.join(",") === "research,shadow", "조사 발화 뒤에 그림자를 쏜다");
  const codex = await dispatchResearch(JOB_ID, {
    provider: "codex",
    queueLocal: async () => ({ queued: true }),
    dispatchShadow: async () => void order.push("shadow-codex"),
  });
  assert(codex.route === "macmini-codex" && order.includes("shadow-codex"), "조사 제공자가 codex여도 그림자는 독립으로 쏜다");
  const broken = await dispatchResearch(JOB_ID, {
    provider: "claude",
    hasGithubToken: () => true,
    enqueue: async () => {},
    dispatchShadow: async () => {
      throw new Error("shadow boom");
    },
  });
  assert(broken.route === "actions" && broken.queued, "그림자가 던져도 조사 발화 결과는 그대로다");
  console.log("✅ dispatchResearch: 조사 발화 → 그림자(독립), 그림자 실패는 무영향");
}

// ── 9) 출처 해석 ────────────────────────────────────────────────────────────
{
  const sources = await buildSources(
    [
      { title: "a.example", url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AAA" },
      { title: "b.example", url: "https://b.example/x" },
    ],
    "참고 https://b.example/x, https://c.example/y).",
    (async (url: string) => ({ url: url.includes("grounding-api-redirect") ? "https://a.example/real" : url })) as unknown as typeof fetch
  );
  const urls = sources.map((s) => s.url);
  assert(urls.includes("https://a.example/real") && !urls.some((u) => u.includes("grounding-api-redirect")), "grounding 리디렉션을 실제 주소로 푼다");
  assert(urls.filter((u) => u === "https://b.example/x").length === 1 && urls.includes("https://c.example/y"), "중복 제거 + 본문 URL 끝 구두점 제거");
  console.log("✅ 출처: 리디렉션 해석·중복 제거·본문 URL 수집");
}

// ── 10) 뷰어 ────────────────────────────────────────────────────────────────
{
  const shadow: GeminiShadow = {
    requestedAt: "2026-11-19T00:00:00Z",
    model: "gemini-3.1-pro-preview",
    startedAt: "2026-11-19T00:00:10Z",
    finishedAt: "2026-11-19T00:10:00Z",
    title: "홍길동의 길",
    body: "## 데뷔\n그는 무대에서 시작했다.\n둘째 줄\n\n- 항목 하나\n- 항목 둘",
    researchNotes: "노트",
    sources: [{ title: "news.example", url: "https://news.example/a", via: "grounding" }],
    usage: { research: null, write: null, totalCostUsd: 0.12 },
  };
  const topic = (jobId: string, category: string, extra: Partial<ManuscriptTopicEntry["manuscript"]> = {}): ManuscriptTopicEntry => ({
    jobId,
    keyword: `키워드-${jobId}`,
    category,
    date: "2026-11-19",
    readyAt: "2026-11-19T02:00:00Z",
    manuscript: { title: `기존 제목 ${jobId}`, searchDescription: null, slug: null, tags: [], body: "기존 본문입니다.", imagePrompts: [], images: [], filePath: "x", ...extra },
  });

  const blocks = parseGeminiBody(shadow.body ?? "");
  assert(blocks.length === 3 && blocks[0].type === "heading" && blocks[1].type === "text" && (blocks[1] as { lines: string[] }).lines.length === 2, "본문 블록 분해");
  assert(toGeminiPageView({ ...shadow, finishedAt: undefined }) === null, "진행 중(finishedAt 없음)은 뷰어에 올리지 않는다");
  assert(toGeminiPageView({ requestedAt: "x", finishedAt: "y", error: "실패" })?.error === "실패", "실패한 실행은 사유와 함께 올린다");

  // 덧입힘: person만, 끝난 것만, 로더 실패는 원본 유지
  const manifest: ManuscriptManifest = { topics: [topic("p-1", "person"), topic("p-2", "person"), topic("e-1", "entertainment")] };
  const attached = await attachGeminiShadows(manifest, async () => new Map([["p-1", shadow], ["p-2", { ...shadow, finishedAt: undefined }]]));
  assert(attached.topics[0].manuscript.geminiShadow?.title === "홍길동의 길", "p-1에 덧입힌다");
  assert(!attached.topics[1].manuscript.geminiShadow && !attached.topics[2].manuscript.geminiShadow, "진행 중·비 person에는 덧입히지 않는다");
  assert(!("geminiShadow" in manifest.topics[0].manuscript), "원본 manifest는 바뀌지 않는다");
  let loaded: string[] = [];
  await attachGeminiShadows(manifest, async (ids) => {
    loaded = ids;
    return new Map();
  });
  assert(loaded.join(",") === "p-1,p-2", "person 행만 조회한다");
  const failedLoad = await attachGeminiShadows(manifest, async () => {
    throw new Error("db down");
  });
  assert(failedLoad === manifest, "로더가 실패하면 manifest를 그대로 돌려준다(배포를 막지 않는다)");
  assert(!("geminiShadow" in withoutGeminiShadow(attached.topics[0].manuscript)), "saveManifest는 geminiShadow를 떼어 낸다");

  // 렌더: 있을 때만 데이터에 gemini가 실린다
  const html = renderManuscriptPage(attached);
  const data = JSON.parse(html.match(/<script id="manuscript-data" type="application\/json">([\s\S]*?)<\/script>/)![1]) as { jobId: string; gemini: { title: string; sources: unknown[]; blocks: unknown[]; costUsd: number } | null }[];
  const byId = Object.fromEntries(data.map((t) => [t.jobId, t]));
  assert(byId["p-1"].gemini?.title === "홍길동의 길" && byId["p-1"].gemini.sources.length === 1 && byId["p-1"].gemini.blocks.length === 3, "제미나이 블록이 있는 원고에 데이터가 실린다");
  assert(byId["p-2"].gemini === null && byId["e-1"].gemini === null, "없는 원고는 gemini=null(탭이 뜨지 않는다)");
  assert(html.includes('data-mode="gemini"') && html.includes("function renderGemini"), "탭과 제미나이 렌더 함수가 페이지에 있다");
  const noShadowHtml = renderManuscriptPage(manifest);
  assert(JSON.parse(noShadowHtml.match(/<script id="manuscript-data" type="application\/json">([\s\S]*?)<\/script>/)![1]).every((t: { gemini: unknown }) => t.gemini === null), "제미나이가 없으면 어떤 원고에도 데이터가 없다");

  // 제미나이 화면에는 이미지·수정·저장·발행 버튼이 없다(renderGemini 함수 본문만 본다).
  const start = html.indexOf("function renderGemini(");
  let depth = 0;
  let end = -1;
  for (let i = html.indexOf("{", start); i < html.length; i += 1) {
    if (html[i] === "{") depth += 1;
    else if (html[i] === "}" && --depth === 0) {
      end = i + 1;
      break;
    }
  }
  const fn = html.slice(start, end);
  for (const forbidden of ["edit-toggle", "submit-edits", "publish", "dl-zip", "dl-images", "c-prompt", "contenteditable", "/api/"]) {
    assert(!fn.includes(forbidden), `제미나이 화면에 ${forbidden}가 있다 - 읽기 전용이어야 한다`);
  }
  for (const needed of ["g-body", "g-body-plain", "g-title", "g-src"]) assert(fn.includes(needed), `제미나이 화면에 복사 버튼 ${needed}가 있다`);

  // 복사 로직을 실제로 실행: 소제목 19px 굵게, 문단·목록 서식은 기존 뷰어와 같은 함수(linesToHtml)를 쓴다.
  const pieces: string[] = [];
  const consts = html.match(/var BODY_PX = [^\n]+;/);
  assert(consts, "BODY_PX 선언");
  pieces.push(consts[0]);
  for (const name of ["esc", "isListLine", "stripListMarker", "inlineHtml", "linesToHtml", "geminiPlain", "geminiRichHtml", "geminiBodyHtml"]) {
    const s = html.indexOf(`function ${name}(`);
    assert(s >= 0, `${name}() 없음`);
    let d = 0;
    let e = -1;
    for (let i = html.indexOf("{", s); i < html.length; i += 1) {
      if (html[i] === "{") d += 1;
      else if (html[i] === "}" && --d === 0) {
        e = i + 1;
        break;
      }
    }
    pieces.push(html.slice(s, e));
  }
  // eslint-disable-next-line no-new-func
  const run = new Function("g", `${pieces.join("\n")}\nreturn { rich: geminiRichHtml(g), plain: geminiPlain(g), body: geminiBodyHtml(g) };`) as (g: unknown) => { rich: string; plain: string; body: string };
  const out = run(byId["p-1"].gemini);
  assert(out.rich.includes('<p style="font-size:19px"><b>데뷔</b></p>') && out.rich.includes("<ul") && out.rich.includes("그는 무대에서 시작했다.<br>둘째 줄"), `서식 유지 복사: ${out.rich}`);
  assert(out.plain === "데뷔\n\n그는 무대에서 시작했다.\n둘째 줄\n\n- 항목 하나\n- 항목 둘", `서식 없는 복사: ${JSON.stringify(out.plain)}`);
  assert(out.body.includes('<p class="h">데뷔</p>') && out.body.includes("<li>항목 하나</li>"), "화면 본문 HTML");
  console.log("✅ 뷰어: 제미나이 블록은 있을 때만, 읽기 전용, 복사 버튼, 덧입힘·저장 시 제거");
}

console.log("\n✅ 전체 통과");
