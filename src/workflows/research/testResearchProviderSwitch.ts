// 자료조사 제공자 스위치 테스트(2026-11-01). 네트워크·LLM·DB 없이 주입으로만 돈다.
// 실행: npm run test:research-switch
//
// 지켜야 할 것:
//   ① 제공자가 실행 위치를 정한다 - claude/gemini는 Actions 큐, codex는 맥미니 대기열. 서로 침범하지 않는다.
//   ② 맥미니 폴러는 Codex만 돌린다(불변식 ①) - runResearchStage에 provider "codex"를 못 박아 넘긴다.
//   ③ Codex는 Actions에서 돌지 않는다(불변식 ②).
//   ④ codex stdout 파싱이 로그 잡음·JSON 2회에 견디고, 실패하면 원문을 덤프한다.
//   ⑤ 폴러가 같은 job을 두 번 돌리지 않는다(claim), 잔재가 된 claim은 다시 집는다.
//   ⑥ Codex 실패는 Claude로 폴백하지 않는다.
import { dispatchResearch } from "./dispatchResearch.js";
import { parseResearchProvider } from "../../config/researchProvider.js";
import {
  filterDueLocalResearch,
  LOCAL_RESEARCH_KEY,
  readLocalResearchRequest,
  requestLocalResearch,
} from "./localResearchQueue.js";
import type { LocalResearchRequest } from "./localResearchQueue.js";
import { extractResearchMarkdown, runCodexResearch, CODEX_OUTPUT_CONTRACT } from "../../services/llm/runCodexResearch.js";
import { stampResearchProvider } from "../writing/runArticleJob.js";
import { pollLocalResearchOnce } from "../../jobs/researchPollJob.js";
import type { ArticleJobRow } from "../../types/database.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const RESEARCH_BODY = [
  "---",
  "keyword: 테스트 키워드",
  "verdict: ok",
  "---",
  "",
  "## 1. 요약",
  "본문".repeat(120),
].join("\n");

function jobWith(request: Partial<LocalResearchRequest> | null, id = "job-1"): Pick<ArticleJobRow, "id" | "metadata"> {
  return { id, metadata: request ? { [LOCAL_RESEARCH_KEY]: request } : {} } as Pick<ArticleJobRow, "id" | "metadata">;
}

// ── ① 제공자 파싱: 알 수 없는 값은 claude로 떨어진다 ──────────────────────────
function testProviderParsing(): void {
  assert(parseResearchProvider(undefined) === "claude", "미설정은 claude");
  assert(parseResearchProvider("") === "claude", "빈 값은 claude");
  assert(parseResearchProvider(" CODEX ") === "codex", "대소문자·공백을 받아야 한다");
  assert(parseResearchProvider("gemini") === "gemini", "gemini 유지");
  assert(parseResearchProvider("claud") === "claude", "오타는 claude로 떨어진다");
  assert(parseResearchProvider("openai") === "claude", "모르는 제공자는 claude");
  console.log("✅ 제공자 파싱: 알 수 없는 값은 모두 claude");
}

// ── ① 발화 분기 ──────────────────────────────────────────────────────────────
async function testDispatchBranching(): Promise<void> {
  for (const provider of ["claude", "gemini"] as const) {
    const enqueued: string[] = [];
    const localQueued: string[] = [];
    const spawned: string[] = [];
    const result = await dispatchResearch("job-a", {
      provider,
      hasGithubToken: () => true,
      enqueue: async (id) => void enqueued.push(id),
      queueLocal: async (id) => {
        localQueued.push(id);
        return { queued: true };
      },
      spawnLocal: (id) => void spawned.push(id),
    });
    assert(result.route === "actions", `${provider}는 Actions로 가야 한다 (실제: ${result.route})`);
    assert(enqueued.length === 1, `${provider}: Actions 큐 1건`);
    assert(localQueued.length === 0, `${provider}: 맥미니 대기열을 침범하면 안 된다(불변식 ①)`);
    assert(spawned.length === 0, `${provider}: 토큰이 있으면 로컬 실행 금지`);
  }

  // codex: 토큰이 있어도 Actions로 보내지 않는다(불변식 ②).
  const enqueued: string[] = [];
  const localQueued: string[] = [];
  const spawned: string[] = [];
  const codex = await dispatchResearch("job-b", {
    provider: "codex",
    hasGithubToken: () => true,
    enqueue: async (id) => void enqueued.push(id),
    queueLocal: async (id) => {
      localQueued.push(id);
      return { queued: true };
    },
    spawnLocal: (id) => void spawned.push(id),
  });
  assert(codex.route === "macmini-codex", `codex는 맥미니 대기열이어야 한다 (실제: ${codex.route})`);
  assert(localQueued.length === 1 && localQueued[0] === "job-b", "codex: 맥미니 대기열 1건");
  assert(enqueued.length === 0, "codex: Actions로 보내면 안 된다(CLI·로그인이 맥에만 있다 - 불변식 ②)");
  assert(spawned.length === 0, "codex: detached 실행 대신 폴러가 집어 간다");

  // 토큰이 없고 claude면 기존 폴백(개발용) 그대로 - 맥 로컬 detached.
  const warned: string[] = [];
  const localSpawn: string[] = [];
  const fallback = await dispatchResearch("job-c", {
    provider: "claude",
    hasGithubToken: () => false,
    warnFallback: async (id) => void warned.push(id),
    spawnLocal: (id) => void localSpawn.push(id),
    queueLocal: async () => {
      throw new Error("claude가 맥미니 대기열에 올라가면 안 된다(불변식 ①)");
    },
  });
  assert(fallback.route === "local-dev", "토큰 없음 + claude = 맥 로컬(개발용)");
  assert(warned.length === 1 && localSpawn.length === 1, "로컬 폴백은 경고 후 실행한다");

  // 토큰이 없어도 codex는 맥미니 대기열이다(폴러가 집는다 - detached 실행 아님).
  const noTokenCodex = await dispatchResearch("job-d", {
    provider: "codex",
    hasGithubToken: () => false,
    queueLocal: async () => ({ queued: true }),
    spawnLocal: () => {
      throw new Error("codex는 detached로 돌지 않는다 - 폴러가 집어 간다");
    },
    warnFallback: async () => {
      throw new Error("codex 경로에는 클라우드 폴백 경고가 없다");
    },
  });
  assert(noTokenCodex.route === "macmini-codex", "토큰 없음 + codex = 맥미니 대기열");
  console.log("✅ 발화 분기: claude/gemini→Actions, codex→맥미니, 서로 침범 없음");
}

// ── 대기열 표식 ───────────────────────────────────────────────────────────────
async function testQueueMarker(): Promise<void> {
  const patches: Record<string, unknown>[] = [];
  const first = await requestLocalResearch("job-1", {
    existing: null,
    mergeMetadata: async (_id, patch) => void patches.push(patch),
    now: () => new Date("2026-11-01T01:00:00Z"),
  });
  assert(first.queued, "첫 요청은 큐에 올라간다");
  const marker = patches[0][LOCAL_RESEARCH_KEY] as LocalResearchRequest;
  assert(marker.status === "requested" && marker.provider === "codex", "표식은 requested/codex");
  assert(patches[0].researchProvider === "codex", "가시성: metadata.researchProvider도 남는다");

  // 두 번 눌러도 요청 시각이 밀리지 않는다.
  const again = await requestLocalResearch("job-1", {
    existing: marker,
    mergeMetadata: async () => {
      throw new Error("이미 대기 중인 요청을 덮어쓰면 안 된다");
    },
  });
  assert(!again.queued, "대기 중이면 다시 올리지 않는다");

  // provider가 codex가 아닌 표식은 아예 읽지 않는다(불변식 ① 방어선).
  const foreign = readLocalResearchRequest({ metadata: { [LOCAL_RESEARCH_KEY]: { status: "requested", provider: "claude", requestedAt: "x" } } } as Pick<ArticleJobRow, "metadata">);
  assert(foreign === null, "provider!=codex 표식은 폴러가 집지 않는다");

  // 끝난 건은 다시 요청할 수 있다.
  const done: LocalResearchRequest = { status: "done", provider: "codex", requestedAt: "2026-11-01T00:00:00Z" };
  const retry = await requestLocalResearch("job-1", { existing: done, mergeMetadata: async () => {} });
  assert(retry.queued, "끝난 건은 다시 요청할 수 있다");
  console.log("✅ 대기열 표식: 중복 요청 무시, codex 전용, 재요청 허용");
}

// ── ⑤ 폴러 중복 실행 방지 ────────────────────────────────────────────────────
async function testPollerDeduplication(): Promise<void> {
  const requested: LocalResearchRequest = { status: "requested", provider: "codex", requestedAt: "2026-11-01T01:00:00Z" };
  const now = new Date("2026-11-01T02:00:00Z");

  // 집기 전: due. 집은 직후(running): due 아님. 40분을 넘긴 running: 다시 due.
  assert(filterDueLocalResearch([jobWith(requested)], { now: () => now }).length === 1, "requested는 집는다");
  const justClaimed: LocalResearchRequest = { ...requested, status: "running", claimedAt: "2026-11-01T01:59:00Z" };
  assert(filterDueLocalResearch([jobWith(justClaimed)], { now: () => now }).length === 0, "돌고 있는 조사를 두 번 집으면 안 된다");
  const stale: LocalResearchRequest = { ...requested, status: "running", claimedAt: "2026-11-01T01:00:00Z" };
  assert(filterDueLocalResearch([jobWith(stale)], { now: () => now }).length === 1, "40분 넘긴 running은 잔재로 보고 다시 집는다");
  const noClaimAt: LocalResearchRequest = { ...requested, status: "running" };
  assert(filterDueLocalResearch([jobWith(noClaimAt)], { now: () => now }).length === 1, "claimedAt을 못 읽으면 다시 집는다(영영 멈추지 않게)");
  assert(filterDueLocalResearch([jobWith({ status: "done", provider: "codex", requestedAt: "x" })], { now: () => now }).length === 0, "done은 집지 않는다");

  // 오래된 요청 먼저.
  const ordered = filterDueLocalResearch(
    [jobWith({ ...requested, requestedAt: "2026-11-01T03:00:00Z" }, "late"), jobWith({ ...requested, requestedAt: "2026-11-01T01:00:00Z" }, "early")],
    { now: () => now }
  );
  assert(ordered[0].id === "early", "오래된 요청을 먼저 집는다");

  // 한 주기에 1건만, claim -> 조사 -> finish 순서.
  const calls: string[] = [];
  const outcome = await pollLocalResearchOnce({
    listPending: async () => [jobWith(requested, "job-x"), jobWith(requested, "job-y")],
    claim: async (jobId) => void calls.push(`claim:${jobId}`),
    finish: async (jobId, _req, result) => void calls.push(`finish:${jobId}:${result.ok}`),
    runResearch: async (jobId) => {
      calls.push(`run:${jobId}`);
      return { status: "success", job: {} as ArticleJobRow, sources: [], researchFilePath: "research/x.md", verdict: "ok", sourceCounts: { official: 0, medical: 0, news: 0, community: 0 }, durationMs: 1000 };
    },
    triggerWriting: async (jobId) => void calls.push(`write:${jobId}`),
  });
  assert(outcome.picked && outcome.status === "success", "성공 처리");
  assert(
    calls.join("|") === "claim:job-x|run:job-x|finish:job-x:true|write:job-x",
    `claim -> 조사 -> finish -> 집필 순서여야 한다 (실제: ${calls.join("|")})`
  );
  assert(!calls.some((c) => c.includes("job-y")), "한 주기에 1건만 처리한다");

  // 빈 대기열은 조용히 끝난다.
  const empty = await pollLocalResearchOnce({ listPending: async () => [] });
  assert(!empty.picked, "대기 없음");
  console.log("✅ 폴러: 1건씩, claim으로 중복 차단, 잔재는 재시도");
}

// ── ② 폴러는 Codex만 돌린다 + ⑥ 폴백 없음 ────────────────────────────────────
async function testPollerForcesCodexAndNoFallback(): Promise<void> {
  const request: LocalResearchRequest = { status: "requested", provider: "codex", requestedAt: "2026-11-01T01:00:00Z" };
  const finished: { ok: boolean; error?: string }[] = [];
  const notified: string[] = [];
  const outcome = await pollLocalResearchOnce({
    listPending: async () => [jobWith(request, "job-f")],
    claim: async () => {},
    finish: async (_id, _req, result) => void finished.push(result.ok ? { ok: true } : { ok: false, error: result.error }),
    runResearch: async () => ({ status: "failed", error: "codex가 종료 코드 1로 끝났습니다" }),
    triggerWriting: async () => {
      throw new Error("실패한 조사로 집필을 발화하면 안 된다");
    },
    notifyFailure: async (_id, message) => void notified.push(message),
  });
  assert(outcome.picked && outcome.status === "failed", "실패 처리");
  assert(finished.length === 1 && !finished[0].ok, "실패도 표식을 내려 다음 주기에 다시 집지 않는다");
  assert(notified.length === 1, "실패는 텔레그램으로 알린다(기존 실패 경로)");
  console.log("✅ Codex 실패: Claude 폴백 없이 기존 실패 경로로 떨어진다");
}

// ── ③ Codex는 Actions에서 돌지 않는다 ────────────────────────────────────────
async function testCodexRefusesActions(): Promise<void> {
  const result = await runCodexResearch({
    job: { keyword: "테스트", headline: null, category: null } as Parameters<typeof runCodexResearch>[0]["job"],
    baselineSources: [],
    today: "2026-11-01",
    isGithubActions: () => true,
    researcherSpec: "규격",
    run: async () => {
      throw new Error("Actions에서는 codex를 호출조차 하면 안 된다");
    },
  });
  assert(!result.ok && result.error.includes("GitHub Actions"), "Actions에서는 분명한 이유로 멈춘다");
  console.log("✅ 불변식 ②: Codex는 Actions에서 실행을 거부한다");
}

// ── ④ stdout 파싱 ────────────────────────────────────────────────────────────
function testStdoutParsing(): void {
  const payload = JSON.stringify({ research_markdown: RESEARCH_BODY });

  // 세션 로그 + "tokens used" 잡음에 섞인 경우.
  const noisy = ["[2026-11-01T01:00:00] OpenAI Codex v0.166.0", "--------", "thinking…", payload, "tokens used: 143,567"].join("\n");
  assert(extractResearchMarkdown(noisy)?.startsWith("---"), "로그 잡음에 섞여도 꺼낸다");

  // JSON이 두 번 찍힌 경우 - 뒤쪽(최종 요약)을 쓴다.
  const second = JSON.stringify({ research_markdown: `${RESEARCH_BODY}\n\n## 11. 최종` });
  const twice = [payload, "tokens used: 300,000", second].join("\n");
  assert(extractResearchMarkdown(twice)?.includes("## 11. 최종"), "JSON이 두 번이면 마지막 것을 쓴다");

  // 여러 줄로 예쁘게 출력된 경우.
  const pretty = ["prelude", JSON.stringify({ research_markdown: RESEARCH_BODY }, null, 2), "tokens used: 1"].join("\n");
  assert(extractResearchMarkdown(pretty)?.startsWith("---"), "여러 줄 JSON도 꺼낸다");

  // JSON 뒤에 꼬리가 붙어 균형 파서가 엉뚱한 덩어리를 잡는 경우(역방향 재시도가 건진다).
  const trailing = `${payload}\n{"unrelated": {"a": 1}}\ntokens used: 2`;
  assert(extractResearchMarkdown(trailing)?.startsWith("---"), "뒤에 다른 JSON이 와도 research_markdown을 찾는다");

  // 실패 케이스.
  assert(extractResearchMarkdown("tokens used: 10\nno json here") === null, "JSON이 없으면 null");
  assert(extractResearchMarkdown(JSON.stringify({ research_markdown: "너무 짧다" })) === null, "한 줄짜리 사과문을 성공으로 받지 않는다");
  assert(extractResearchMarkdown(JSON.stringify({ other: RESEARCH_BODY })) === null, "키가 다르면 null");
  console.log("✅ stdout 파싱: 잡음·JSON 2회·여러 줄·꼬리 JSON을 견디고 실패는 null");
}

// ── ④ 파싱 실패 시 원문 덤프 + 실패한 실행의 stdout 구제 ─────────────────────
async function testDumpAndSalvage(): Promise<void> {
  const base = {
    job: { keyword: "테스트", headline: null, category: null } as Parameters<typeof runCodexResearch>[0]["job"],
    baselineSources: [],
    today: "2026-11-01",
    researcherSpec: "규격",
    isGithubActions: () => false,
  };

  const dumped: string[] = [];
  const failed = await runCodexResearch({
    ...base,
    run: async () => ({ ok: false, error: "codex 출력에서 JSON을 찾지 못했습니다", durationMs: 900_000, rawStdout: "세션 로그만 있고 JSON이 없다" }),
    dumpStdout: async (stdout) => {
      dumped.push(stdout);
      return "/tmp/dump.txt";
    },
  });
  assert(!failed.ok, "파싱 실패는 실패로 보고한다");
  assert(dumped.length === 1 && failed.ok === false && failed.dumpPath === "/tmp/dump.txt", "원문을 파일로 남겨 재분석할 수 있어야 한다");
  assert(failed.ok === false && failed.error.includes("/tmp/dump.txt"), "덤프 경로를 에러 메시지에 적는다");

  // 종료 코드가 0이 아니었어도 stdout에 답이 있으면 건진다(15분치 실행을 버리지 않는다).
  const salvaged = await runCodexResearch({
    ...base,
    run: async () => ({
      ok: false,
      error: "codex가 종료 코드 1로 끝났습니다",
      durationMs: 800_000,
      rawStdout: `${JSON.stringify({ research_markdown: RESEARCH_BODY })}\ntokens used: 5`,
    }),
    dumpStdout: async () => {
      throw new Error("구제됐으면 덤프하지 않는다");
    },
  });
  assert(salvaged.ok && salvaged.markdown.startsWith("---"), "실패한 실행의 stdout에서도 건진다");

  // runHeadlessCodex가 잡음 덩어리를 data로 집어 왔을 때도 원문에서 다시 꺼낸다.
  const reparsed = await runCodexResearch({
    ...base,
    run: async () => ({
      ok: true,
      data: { unrelated: 1 },
      durationMs: 1000,
      rawStdout: JSON.stringify({ research_markdown: RESEARCH_BODY }),
    }),
    dumpStdout: async () => null,
  });
  assert(reparsed.ok, "data 모양이 틀리면 원문에서 다시 꺼낸다");
  console.log("✅ 파싱 실패는 원문 덤프, 실패한 실행도 stdout에서 구제");
}

// ── 출력 계약·frontmatter 가시성 ──────────────────────────────────────────────
function testContractAndStamp(): void {
  assert(CODEX_OUTPUT_CONTRACT.includes('{"research_markdown": "<파일 전문>"}'), "출력 계약 한 줄이 프롬프트에 붙는다");

  const stamped = stampResearchProvider(RESEARCH_BODY, "codex");
  assert(stamped !== null && /^research_provider: codex$/m.test(stamped), "frontmatter에 제공자를 남긴다");
  assert(stamped !== null && stamped.indexOf("research_provider") < stamped.indexOf("## 1. 요약"), "본문이 아니라 frontmatter 안에 들어간다");
  assert(stampResearchProvider(stamped as string, "codex") === null, "같은 값이면 되쓰지 않는다(재사용 파일 mtime 보존)");
  const changed = stampResearchProvider(stamped as string, "claude");
  assert(changed !== null && /^research_provider: claude$/m.test(changed) && !changed.includes("codex"), "값이 바뀌면 교체한다");
  assert(stampResearchProvider("frontmatter 없는 파일", "codex") === null, "frontmatter가 없으면 건드리지 않는다");
  console.log("✅ 출력 계약 + frontmatter 제공자 기록");
}

async function main(): Promise<void> {
  testProviderParsing();
  await testDispatchBranching();
  await testQueueMarker();
  await testPollerDeduplication();
  await testPollerForcesCodexAndNoFallback();
  await testCodexRefusesActions();
  testStdoutParsing();
  await testDumpAndSalvage();
  testContractAndStamp();
  console.log("\n🎉 자료조사 제공자 스위치 테스트 통과");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
