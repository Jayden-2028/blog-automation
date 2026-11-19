// 인물 제미나이 그림자 트랙 테스트. 실행: npm run test:gemini-person
// 외부 호출 없음 - fetch·Supabase·Telegram·GitHub는 전부 주입한다(실제 API를 부르지 않는다).
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { agyExtraArgs, geminiPersonModel, isGeminiPersonShadowEnabled } from "../../config/geminiPerson.js";
import { AGY_LOGIN_MESSAGE, isAgyAuthError, parseAgyEnvelope, runAgy } from "../../services/llm/runAgy.js";
import type { AgyExecutor, RunAgyResult } from "../../services/llm/runAgy.js";
import type { ArticleJobRow } from "../../types/database.js";
import { dispatchResearch } from "../research/dispatchResearch.js";
import { renderManuscriptPage } from "../manuscripts/renderManuscriptPage.js";
import { withoutGeminiShadow } from "../manuscripts/manuscriptManifest.js";
import type { ManuscriptManifest, ManuscriptTopicEntry } from "../manuscripts/manuscriptManifest.js";
import { dispatchGeminiPersonShadow } from "./dispatchGeminiPersonShadow.js";
import { claimGeminiShadow, closeExhausted, pickDue, STALE_START_MS } from "./geminiShadowQueue.js";
import type { PendingRow } from "./geminiShadowQueue.js";
import { pollGeminiPersonOnce } from "../../jobs/geminiPersonPollJob.js";
import { buildGeminiPersonResearchPrompt, buildGeminiPersonWritePrompt } from "./geminiPersonPrompts.js";
import { parseGeminiPersonOutput } from "./parseGeminiPersonOutput.js";
import { extractSources, runGeminiPerson } from "./runGeminiPerson.js";
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

// ── 3) agy 러너: 봉투 파싱·인자·인증 오류·타임아웃·빈 폴더 ──────────────────
function envelope(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    conversation_id: "c-1",
    status: "SUCCESS",
    response: "응답 본문",
    duration_seconds: 3,
    num_turns: 2,
    usage: { input_tokens: 100, output_tokens: 50, thinking_tokens: 20, cache_read_tokens: 5, total_tokens: 175 },
    ...over,
  });
}

{
  const ok = parseAgyEnvelope(`진단 한 줄\n${envelope()}\n`);
  assert("ok" in ok && ok.ok && ok.text === "응답 본문" && ok.usage.thinkingTokens === 20 && ok.usage.totalTokens === 175 && ok.numTurns === 2, "봉투 파싱(앞 잡음 허용)");
  const bad = parseAgyEnvelope(envelope({ status: "ERROR", response: "boom" }));
  assert("error" in bad && bad.error.includes("ERROR") && !bad.authRequired, "SUCCESS가 아니면 사유");
  const auth1 = parseAgyEnvelope("", "Error: authentication required. Run agy to log in.");
  assert("error" in auth1 && auth1.authRequired && auth1.error === AGY_LOGIN_MESSAGE, "stderr 인증 오류 -> 로그인 필요");
  const auth2 = parseAgyEnvelope(envelope({ status: "ERROR", response: "Authentication required" }));
  assert("error" in auth2 && auth2.authRequired, "봉투 안 인증 오류도 같다");
  assert("error" in parseAgyEnvelope("그냥 글") && "error" in parseAgyEnvelope(envelope({ response: "  " })), "봉투 없음/빈 응답은 오류");
  assert(isAgyAuthError("Not logged in") && !isAgyAuthError("rate limit"), "인증 오류 판별");

  const seen: { binary: string; args: string[]; cwd: string }[] = [];
  const exec = (result: Partial<Awaited<ReturnType<AgyExecutor>>>): AgyExecutor => async (binary, args, o) => {
    seen.push({ binary, args, cwd: o.cwd });
    return { code: 0, stdout: envelope(), stderr: "", timedOut: false, ...result };
  };
  const r = await runAgy({ prompt: "질문", model: "m-1", extraArgs: ["--mode", "plan"], executor: exec({}) });
  assert(r.ok && r.text === "응답 본문", "러너 성공");
  const a = seen[0].args;
  assert(a[0] === "-p" && a[1] === "질문" && a.includes("--output-format") && a[a.indexOf("--output-format") + 1] === "json", "-p + json 출력");
  assert(a[a.indexOf("--model") + 1] === "m-1" && a[a.indexOf("--print-timeout") + 1] === "15m" && a.slice(-2).join(" ") === "--mode plan", "모델·타임아웃 15m·추가 인자");
  assert(!a.includes("--dangerously-skip-permissions"), "권한 우회 플래그를 넘기지 않는다");
  assert(!seen[0].cwd.startsWith(process.cwd()) && seen[0].cwd.includes("agy-person-"), "저장소 밖 빈 임시 폴더에서 실행한다");
  assert(!existsSync(seen[0].cwd), "임시 폴더는 실행 뒤 지운다");
  await runAgy({ prompt: "x", executor: exec({}) });
  assert(!seen[1].args.includes("--model"), "runAgy 자체는 모델을 안 주면 --model을 넘기지 않는다(호출부가 기본값을 준다)");

  const authRun = await runAgy({ prompt: "x", executor: exec({ code: 1, stdout: "", stderr: "authentication required" }) });
  assert(!authRun.ok && authRun.authRequired && authRun.error.includes("맥미니 agy 로그인 필요"), "인증 오류 -> authRequired");
  const timeout = await runAgy({ prompt: "x", executor: exec({ timedOut: true, stdout: "" }) });
  assert(!timeout.ok && timeout.error.includes("15분"), "타임아웃");
  const noBin = await runAgy({ prompt: "x", executor: exec({ spawnError: "spawn agy ENOENT" }) });
  assert(!noBin.ok && noBin.error.includes("PATH"), "agy가 없으면 PATH 안내");
  assert(agyExtraArgs(" --mode  plan ").join("|") === "--mode|plan" && agyExtraArgs("").length === 0 && geminiPersonModel("  ") === "gemini-3.8-flash-high" && geminiPersonModel(undefined) === "gemini-3.8-flash-high" && geminiPersonModel("m") === "m", "env 파서");
  console.log("✅ agy 러너: 봉투·인자·인증 오류·타임아웃·빈 임시 폴더·권한 우회 없음");
}

// ── 공용 가짜 ───────────────────────────────────────────────────────────────
function okResult(text: string, over: Partial<Extract<RunAgyResult, { ok: true }>> = {}): RunAgyResult {
  return {
    ok: true,
    text,
    model: "agy-model-x",
    usage: { inputTokens: 1000, outputTokens: 500, thinkingTokens: 1000, cacheReadTokens: 0, totalTokens: 2500 },
    durationMs: 1000,
    numTurns: 3,
    conversationId: "c",
    ...over,
  };
}

type Harness = { deps: GeminiPersonDeps; merges: Record<string, unknown>[]; prompts: string[]; calls: { model?: string; extraArgs?: string[] }[]; notices: { text: string; pageUrl: string | null }[]; refreshes: number };

function harness(options: { job?: ArticleJobRow | null; responses?: RunAgyResult[]; hasEntry?: boolean; enabled?: boolean; mergeThrows?: boolean; notifyThrows?: boolean; refresh?: "dispatched" | "no_token" } = {}): Harness {
  const h: Harness = { deps: {}, merges: [], prompts: [], calls: [], notices: [], refreshes: 0 };
  const responses = [...(options.responses ?? [okResult("조사 노트\n출처: https://wiki.example/홍길동 와 [뉴스](https://news.example/a)."), okResult("# 홍길동의 길\n\n## 데뷔\n그는 무대에서 시작했다. https://body.example/z")])];
  let current = options.job === undefined ? job({}, { geminiShadow: { requestedAt: "2026-11-19T00:00:00Z", startedAt: "2026-11-19T00:59:00Z", claimId: "k", attempts: 1 } }) : options.job;
  h.deps = {
    findJob: async () => current,
    mergeMetadata: async (_id, patch) => {
      if (options.mergeThrows) throw new Error("merge boom");
      h.merges.push(patch);
      if (current && "geminiShadow" in patch) current = { ...current, metadata: { ...current.metadata, geminiShadow: patch.geminiShadow } };
    },
    runAgyImpl: (async (opts: { prompt: string; model?: string; extraArgs?: string[] }) => {
      h.prompts.push(opts.prompt);
      h.calls.push(opts);
      const next = responses.shift();
      if (!next) throw new Error("응답 소진");
      return next;
    }) as GeminiPersonDeps["runAgyImpl"],
    hasManifestEntry: async () => options.hasEntry ?? false,
    dispatchRefresh: async () => {
      h.refreshes += 1;
      return options.refresh ?? "dispatched";
    },
    notify: async (_job, text, pageUrl) => {
      if (options.notifyThrows) throw new Error("telegram boom");
      h.notices.push({ text, pageUrl });
    },
    pageUrlFor: () => "https://pages.example/#" + JOB_ID,
    now: () => new Date("2026-11-19T01:00:00Z"),
    isEnabled: () => options.enabled ?? true,
    model: undefined,
    extraArgs: ["--mode", "plan"],
  };
  return h;
}

// ── 4) 정상 실행: 메타데이터 모양·토큰·호출 설정·원장 없음 ───────────────────
{
  const h = harness();
  const result = await runGeminiPerson(JOB_ID, {}, h.deps);
  assert(result.status === "done", `정상 실행은 done이어야 한다: ${JSON.stringify(result)}`);
  const stored = h.merges[h.merges.length - 1].geminiShadow as GeminiShadow;
  assert(h.merges.length === 2, "시작 기록과 완료 기록 두 번 병합한다");
  assert(stored.title === "홍길동의 길" && stored.body?.startsWith("## 데뷔") && stored.model === "agy-model-x", "title/body/model(봉투가 알려 준 값)");
  assert(stored.researchNotes?.includes("조사 노트") && stored.requestedAt && stored.startedAt && stored.finishedAt && !stored.error, "researchNotes/시각");
  const urls = (stored.sources ?? []).map((x) => x.url);
  assert(urls.includes("https://wiki.example/홍길동") && urls.includes("https://news.example/a") && urls.includes("https://body.example/z"), `응답 본문 URL에서 출처를 뽑는다: ${urls.join(",")}`);
  assert((stored.sources ?? []).find((x) => x.url === "https://news.example/a")?.title === "뉴스", "마크다운 링크는 제목도 담는다");
  assert(stored.usage?.research?.thinkingTokens === 1000 && stored.usage.totalTokens === 5000, "토큰만 기록(합계 5000)");
  assert(!JSON.stringify(stored.usage).includes("cost"), "금액 필드가 없다(구독)");
  assert(h.calls.length === 2 && h.calls.every((c) => c.extraArgs?.join(" ") === "--mode plan" && c.model === "gemini-3.8-flash-high"), "두 호출, 기본 모델 gemini-3.8-flash-high 고정, 추가 인자 전달");
  assert(h.prompts[1].includes("조사 노트") && !h.prompts.join("\n").includes("[IMAGE"), "집필 프롬프트에 노트가 실리고 이미지 마커 요청이 없다");
  assert(h.prompts[0].includes("출처 URL을 남겨라"), "조사 프롬프트는 출처 URL을 요구한다");
  assert(h.refreshes === 0 && h.notices.length === 0 && result.status === "done" && result.refresh === "no_page", "페이지가 아직 없으면 저장만 한다");
  const src = readFileSync(join(process.cwd(), "src/workflows/gemini-person/runGeminiPerson.ts"), "utf-8");
  assert(!/recordApiUsage|apiPricing|estimateCostUsd/.test(src.split("\n").filter((l) => /^\s*import\b/.test(l)).join("\n")), "비용 원장·단가표를 import하지 않는다");
  console.log("✅ 정상 실행: 메타데이터 모양·출처 추출·토큰만 기록·호출 설정·원장 없음");
}

// ── 5) 페이지가 이미 있으면 갱신 + 알림 한 통 / 토큰 없으면 알림에 명시 ───────
{
  const h = harness({ hasEntry: true });
  const result = await runGeminiPerson(JOB_ID, {}, h.deps);
  assert(result.status === "done" && result.refresh === "dispatched", "페이지 갱신 발화");
  assert(h.refreshes === 1 && h.notices.length === 1 && h.notices[0].pageUrl?.includes(JOB_ID) && !h.notices[0].text.includes("GITHUB_TOKEN"), "갱신 1회 + 텔레그램 1통(📄 링크)");
  const noToken = harness({ hasEntry: true, refresh: "no_token" });
  const r1 = await runGeminiPerson(JOB_ID, {}, noToken.deps);
  assert(r1.status === "done" && r1.refresh === "no_token" && noToken.notices[0].text.includes("GITHUB_TOKEN이 없어"), "토큰이 없으면 갱신을 건너뛰고 메시지에 그렇다고 적는다");
  const failing = harness({ hasEntry: true, notifyThrows: true });
  assert((await runGeminiPerson(JOB_ID, {}, failing.deps)).status === "done", "알림이 실패해도 결과는 done(저장됨)");
  console.log("✅ 완료 후 페이지 갱신 + 알림 1통, 토큰 없음 처리, 알림 실패 무영향");
}

// ── 6) 킬 스위치·표식만 남기는 디스패치·비 person ────────────────────────────
{
  assert(isGeminiPersonShadowEnabled(undefined) && isGeminiPersonShadowEnabled("") && isGeminiPersonShadowEnabled("true"), "미설정·빈 값·true = 켜짐");
  assert(!isGeminiPersonShadowEnabled("false") && !isGeminiPersonShadowEnabled(" FALSE ") && !isGeminiPersonShadowEnabled("0") && !isGeminiPersonShadowEnabled("off"), "false/0/off = 꺼짐");
  const off = harness({ enabled: false });
  assert((await runGeminiPerson(JOB_ID, {}, off.deps)).status === "skipped" && off.calls.length === 0 && off.merges.length === 0, "스위치 꺼짐: 호출도 기록도 없다");

  const merges: Record<string, unknown>[] = [];
  const mcount = (): number => merges.length;
  const mk = (j: ArticleJobRow | null, enabled = true) => ({ isEnabled: () => enabled, findJob: async () => j, mergeMetadata: async (_: string, p: Record<string, unknown>) => void merges.push(p), now: () => new Date("2026-11-19T01:00:00Z") });
  assert(!(await dispatchGeminiPersonShadow(JOB_ID, mk(job(), false))).dispatched && mcount() === 0, "디스패치도 스위치를 따른다");
  const prevToken = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  const first = await dispatchGeminiPersonShadow(JOB_ID, mk(job()));
  assert(first.dispatched && mcount() === 1 && JSON.stringify(merges[0]) === '{"geminiShadow":{"requestedAt":"2026-11-19T01:00:00.000Z"}}', "GITHUB_TOKEN 없이도 requestedAt 표식만 적는다(워크플로 발화 없음)");
  if (prevToken !== undefined) process.env.GITHUB_TOKEN = prevToken;
  const src = readFileSync(join(process.cwd(), "src/workflows/gemini-person/dispatchGeminiPersonShadow.ts"), "utf-8");
  assert(!/dispatchGithubWorkflow|GITHUB_TOKEN/.test(src.split("\n").filter((l) => /^\s*(import|const|if)\b/.test(l)).join("\n")), "디스패처가 GitHub 발화·토큰을 쓰지 않는다");
  const again = await dispatchGeminiPersonShadow(JOB_ID, mk(job({}, { geminiShadow: { requestedAt: "2026-11-19T00:00:00Z" } })));
  assert(!again.dispatched && again.reason === "already_requested" && mcount() === 1, "멱등: 키가 있으면 다시 적지 않는다");
  for (const [label, j, reason] of [
    ["엔터 키워드", job({ category: "entertainment" }), "not_person"],
    ["카테고리 없음", job({ category: null }), "not_person"],
    ["진행 중(status)", job({ status: "writing" }), "status_writing"],
    ["조사 재시도", job({}, { forceFreshResearch: true }), "re_research"],
  ] as const) {
    const r = await dispatchGeminiPersonShadow(JOB_ID, mk(j));
    assert(!r.dispatched && r.reason === reason && mcount() === 1, `${label}: 표식 없음(${reason})`);
  }
  const boom = await dispatchGeminiPersonShadow(JOB_ID, { ...mk(job()), mergeMetadata: async () => { throw new Error("db"); } });
  assert(!boom.dispatched && boom.reason === "error", "저장이 실패해도 던지지 않는다");

  const doneJob = job({}, { geminiShadow: { requestedAt: "2026-11-19T00:00:00Z", startedAt: "2026-11-19T00:00:10Z", finishedAt: "2026-11-19T00:10:00Z", title: "t", body: "b" } });
  const skip = harness({ job: doneJob });
  assert((await runGeminiPerson(JOB_ID, {}, skip.deps)).status === "skipped" && skip.calls.length === 0, "끝난 기록이 있으면 건너뛴다");
  const forced = harness({ job: doneJob });
  assert((await runGeminiPerson(JOB_ID, { force: true }, forced.deps)).status === "done" && forced.calls.length === 2, "force면 다시 돈다");
  const nonPerson = harness({ job: job({ category: "entertainment" }) });
  assert((await runGeminiPerson(JOB_ID, {}, nonPerson.deps)).status === "skipped" && nonPerson.calls.length === 0, "person이 아니면 실행하지 않는다");
  console.log("✅ 킬 스위치·표식만 남기는 디스패치(토큰 불필요)·멱등·비 person·force");
}

// ── 7) 실패는 던지지 않는다(인증 오류 포함) ──────────────────────────────────
{
  const authFail = harness({ responses: [{ ok: false, error: AGY_LOGIN_MESSAGE, authRequired: true, durationMs: 5 }] });
  const r = await runGeminiPerson(JOB_ID, {}, authFail.deps);
  assert(r.status === "failed" && r.authRequired && r.shadow.error?.includes("맥미니 agy 로그인 필요") && r.shadow.finishedAt, "인증 오류: error에 로그인 필요");
  assert(authFail.notices.length === 1 && authFail.notices[0].text.includes("로그인 필요") && authFail.notices[0].text.includes("--force"), "텔레그램 한 줄(재실행 안내)");

  const writeFail = harness({ responses: [okResult("노트"), { ok: false, error: "시간 초과", authRequired: false, durationMs: 5 }] });
  const r2 = await runGeminiPerson(JOB_ID, {}, writeFail.deps);
  assert(r2.status === "failed" && r2.shadow.researchNotes === "노트", "집필 실패: 조사 노트는 남긴다");
  const thrown = harness();
  thrown.deps.runAgyImpl = (async () => {
    throw new Error("폭발");
  }) as GeminiPersonDeps["runAgyImpl"];
  assert((await runGeminiPerson(JOB_ID, {}, thrown.deps)).status === "failed", "호출이 던져도 failed로 돌려준다");
  assert((await runGeminiPerson(JOB_ID, {}, harness({ mergeThrows: true }).deps)).status === "failed", "저장소가 죽어도 던지지 않는다");
  assert((await runGeminiPerson(JOB_ID, {}, harness({ responses: [okResult("노트"), okResult("   ")] }).deps)).status === "failed", "빈 집필 결과는 failed");
  assert((await runGeminiPerson(JOB_ID, {}, harness({ job: null }).deps)).status === "skipped", "job이 없으면 skipped");
  console.log("✅ 실패 경로: 인증·집필·예외·저장·빈 결과 모두 던지지 않고 기록한다");
}

// ── 8) dispatchResearch 연결: 기존 흐름이 먼저, 그림자 실패는 영향 없음 ────────
{
  const order: string[] = [];
  const result = await dispatchResearch(JOB_ID, { provider: "claude", hasGithubToken: () => true, enqueue: async () => void order.push("research"), dispatchShadow: async () => void order.push("shadow") });
  assert(result.route === "actions" && order.join(",") === "research,shadow", "조사 발화 뒤에 표식을 남긴다");
  const codex = await dispatchResearch(JOB_ID, { provider: "codex", queueLocal: async () => ({ queued: true }), dispatchShadow: async () => void order.push("shadow-codex") });
  assert(codex.route === "macmini-codex" && order.includes("shadow-codex"), "조사 제공자가 codex여도 독립으로 남긴다");
  const broken = await dispatchResearch(JOB_ID, { provider: "claude", hasGithubToken: () => true, enqueue: async () => {}, dispatchShadow: async () => { throw new Error("shadow boom"); } });
  assert(broken.route === "actions" && broken.queued, "그림자가 던져도 조사 발화 결과는 그대로다");
  console.log("✅ dispatchResearch: 조사 발화 -> 표식(독립), 실패는 무영향");
}

// ── 9) 출처 추출 ────────────────────────────────────────────────────────────
{
  const sources = extractSources([
    { text: "참고 https://b.example/x, https://c.example/y). [제목](https://d.example/z)", via: "notes" },
    { text: "again https://b.example/x/ 와 https://위키.example/a_(b)", via: "body" },
  ]);
  const urls = sources.map((x) => x.url);
  assert(urls.filter((u) => u.startsWith("https://b.example/x")).length === 1, "중복 제거(끝 슬래시 무시)");
  assert(urls.includes("https://c.example/y") && urls.includes("https://d.example/z") && sources.find((x) => x.url === "https://d.example/z")?.title === "제목", "끝 구두점 제거·링크 제목");
  console.log("✅ 출처 추출: 중복 제거·구두점·마크다운 링크");
}

// ── 9b) 대기열: claim·stale·소진 ────────────────────────────────────────────
{
  const now = new Date("2026-11-19T12:00:00Z");
  const iso = (minAgo: number): string => new Date(now.getTime() - minAgo * 60_000).toISOString();
  const rows: PendingRow[] = [
    { id: "done", shadow: { requestedAt: iso(300), startedAt: iso(290), finishedAt: iso(280) } },
    { id: "running", shadow: { requestedAt: iso(200), startedAt: iso(10), attempts: 1 } },
    { id: "newer", shadow: { requestedAt: iso(20) } },
    { id: "older", shadow: { requestedAt: iso(100) } },
  ];
  const due = pickDue(rows, now);
  assert(due?.kind === "fresh" && due.id === "older", "가장 오래된 대기 1건(끝난 것·진행 중인 것은 건너뜀)");
  assert(pickDue([rows[0], rows[1]], now) === null, "진행 중(40분 이내)이면 집지 않는다");
  const stale = pickDue([{ id: "s", shadow: { requestedAt: iso(300), startedAt: iso(STALE_START_MS / 60_000 + 1), attempts: 1 } }], now);
  assert(stale?.kind === "stale", "40분 넘은 진행 표식은 잔재로 보고 다시 집는다");
  const exhausted = pickDue([{ id: "x", shadow: { requestedAt: iso(300), startedAt: iso(100), attempts: 2 } }], now);
  assert(exhausted?.kind === "exhausted", "두 번 집은 잔재는 소진 - 실패로 닫는다");

  // claim: 병합 뒤 다시 읽어 내 claimId가 맞아야 한다.
  let stored: Record<string, unknown> = { geminiShadow: { requestedAt: iso(5) } };
  const q = { findJob: async () => ({ metadata: stored }), mergeMetadata: async (_: string, p: Record<string, unknown>) => void (stored = { ...stored, ...p }), now: () => now, newClaimId: () => "me" };
  assert(await claimGeminiShadow("j", q), "정상 claim");
  const claimed = stored.geminiShadow as GeminiShadow;
  assert(claimed.claimId === "me" && claimed.startedAt === now.toISOString() && claimed.attempts === 1 && claimed.requestedAt, "startedAt·claimId·attempts 기록");
  // 다른 폴러가 사이에 덮어쓰면 진다.
  let racing: Record<string, unknown> = { geminiShadow: { requestedAt: iso(5) } };
  const lost = await claimGeminiShadow("j", {
    findJob: async () => ({ metadata: racing }),
    mergeMetadata: async () => void (racing = { geminiShadow: { requestedAt: iso(5), startedAt: iso(0), claimId: "other", attempts: 1 } }),
    now: () => now,
    newClaimId: () => "me",
  });
  assert(!lost, "다른 폴러의 claimId가 남아 있으면 claim에 진다");
  assert(!(await claimGeminiShadow("j", { findJob: async () => ({ metadata: { geminiShadow: { requestedAt: "x", finishedAt: "y" } } }), mergeMetadata: async () => {} })), "끝난 건은 집지 않는다");
  stored = { geminiShadow: { requestedAt: iso(300), startedAt: iso(100), claimId: "old", attempts: 1 } };
  await claimGeminiShadow("j", q);
  assert((stored.geminiShadow as GeminiShadow).attempts === 2, "stale 재집기는 attempts가 2가 된다");
  stored = { geminiShadow: { requestedAt: iso(300), startedAt: iso(100), claimId: "old", attempts: 2 } };
  await closeExhausted("j", q);
  assert((stored.geminiShadow as GeminiShadow).finishedAt && (stored.geminiShadow as GeminiShadow).error?.includes("두 번"), "소진은 error와 함께 닫힌다");

  // 폴러: 한 주기에 1건, 스위치, 잃은 claim
  const ran: string[] = [];
  const base = { now: () => now, loadRows: async () => rows, claim: async () => true, run: async (id: string) => { ran.push(id); return { status: "skipped", reason: "t" } as const; } };
  const out = await pollGeminiPersonOnce(base);
  assert(out.picked && out.jobId === "older" && ran.length === 1, "한 주기에 가장 오래된 1건만 돌린다");
  assert(!(await pollGeminiPersonOnce({ ...base, isEnabled: () => false })).picked && ran.length === 1, "스위치 꺼짐이면 아무것도 집지 않는다");
  assert((await pollGeminiPersonOnce({ ...base, claim: async () => false })).picked && ran.length === 1, "claim에 지면 돌리지 않는다");
  assert(!(await pollGeminiPersonOnce({ ...base, loadRows: async () => [] })).picked, "대기가 없으면 조용히 끝난다");
  const closed: string[] = [];
  const ex = await pollGeminiPersonOnce({ ...base, loadRows: async () => [{ id: "x", shadow: { requestedAt: iso(300), startedAt: iso(100), attempts: 2 } }], closeStale: async (id) => void closed.push(id) });
  assert(ex.picked && ex.status === "closed_exhausted" && closed[0] === "x" && ran.length === 1, "소진 잔재는 닫기만 한다");
  console.log("✅ 대기열: 가장 오래된 1건·claim 재확인·stale 1회 재시도·소진 닫기·스위치");
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
    sources: [{ title: "news.example", url: "https://news.example/a", via: "notes" }],
    usage: { research: null, write: null, totalTokens: 12345 },
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
  const data = JSON.parse(html.match(/<script id="manuscript-data" type="application\/json">([\s\S]*?)<\/script>/)![1]) as { jobId: string; gemini: { title: string; sources: unknown[]; blocks: unknown[]; totalTokens: number } | null }[];
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
