// 워크플로 실패 알림(scripts/notifyWorkflowFailure.mjs)을 **실제로 실행해** 검증한다.
// 쓰는 워크플로는 다섯이다 - job-research / job-write / job-translate / job-revise / job-publish-prepare.
// 실행: npm run test:workflow-failure-notify
//
// 외부 호출 없음: 가짜 Supabase REST와 가짜 Telegram API를 로컬(127.0.0.1)에 띄워 스크립트의
// SUPABASE_URL·TELEGRAM_API_BASE를 그쪽으로 돌린다. 토큰은 전부 더미다 - 실제 메시지는 나가지 않는다.
//
// 왜 subprocess로 돌리는가: 알림 경로의 핵심이 "node 하나로 돈다(node_modules 없이)"는 것이라,
// 모듈을 import해 함수만 부르면 정작 검증하려는 성질이 빠진다. 여기서는 워크플로가 부르는 명령
// (`node scripts/notifyWorkflowFailure.mjs`)을 그대로 실행한다.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { DEFAULT_TRACK, TRACK_ENV_KEYS, TRACK_LABEL } from "./telegramTracks.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const SCRIPT = "scripts/notifyWorkflowFailure.mjs";

type SentMessage = { token: string; chatId: string; text: string };
type Stub = {
  port: number;
  sent: SentMessage[];
  /** Supabase REST가 받은 쿼리스트링(조건을 코드와 대조한다). */
  queries: string[];
  close: () => Promise<void>;
};

/** Supabase REST(/rest/v1/article_jobs)와 Telegram(/bot<token>/sendMessage)을 한 서버로 흉내낸다. */
async function startStub(options: { rows?: unknown[]; restStatus?: number; sendStatus?: number }): Promise<Stub> {
  const sent: SentMessage[] = [];
  const queries: string[] = [];

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (url.pathname === "/rest/v1/article_jobs") {
      queries.push(url.search);
      const status = options.restStatus ?? 200;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(status === 200 ? JSON.stringify(options.rows ?? []) : JSON.stringify({ message: "boom" }));
      return;
    }

    const send = url.pathname.match(/^\/bot([^/]+)\/sendMessage$/);
    if (send && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const status = options.sendStatus ?? 200;
        if (status === 200) {
          const payload = JSON.parse(body) as { chat_id: string; text: string };
          sent.push({ token: send[1]!, chatId: payload.chat_id, text: payload.text });
        }
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: status === 200 }));
      });
      return;
    }

    res.writeHead(404);
    res.end("not found");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    port,
    sent,
    queries,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

type RunResult = { code: number | null; stdout: string; stderr: string };

async function runScript(env: Record<string, string>, args: string[] = []): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      cwd: process.cwd(),
      // 부모 환경을 물려주지 않는다 - 운영 .env가 로드된 셸에서 돌려도 실제 봇으로 나가지 않는다.
      env: { PATH: process.env.PATH ?? "", ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const DUMMY_TOKENS = {
  TELEGRAM_BOT_TOKEN: "dummy-ent-token",
  TELEGRAM_CHAT_ID: "100",
  SOCIAL_TELEGRAM_BOT_TOKEN: "dummy-social-token",
  SOCIAL_TELEGRAM_CHAT_ID: "200",
  KSCENE_TELEGRAM_BOT_TOKEN: "dummy-kscene-token",
  KSCENE_TELEGRAM_CHAT_ID: "300",
};

function baseEnv(port: number): Record<string, string> {
  return {
    ...DUMMY_TOKENS,
    SUPABASE_URL: `http://127.0.0.1:${port}`,
    SUPABASE_SERVICE_ROLE_KEY: "dummy-not-a-real-key",
    TELEGRAM_API_BASE: `http://127.0.0.1:${port}`,
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_REPOSITORY: "Jayden-2028/blog-automation",
    GITHUB_RUN_ID: "43040388380",
    GITHUB_WORKFLOW: "job-publish-prepare",
    FAILED_WORKFLOW_FILE: "job-publish-prepare.yml",
  };
}

// 1) 트랙 표가 TS(telegramTracks.ts)와 갈라지지 않았다. .mjs는 TS를 import할 수 없어 표를
//    복제했으므로, 복제가 낡으면 알림이 엉뚱한 봇으로 간다.
{
  const result = await runScript({}, ["--print-tracks"]);
  assert(result.code === 0, `--print-tracks가 실패했다: ${result.stderr}`);
  const dumped = JSON.parse(result.stdout) as {
    DEFAULT_TRACK: string;
    TRACK_ENV_KEYS: Record<string, { botToken: string; chatId: string }>;
    TRACK_LABEL: Record<string, string>;
  };
  assert(dumped.DEFAULT_TRACK === DEFAULT_TRACK, "기본 트랙이 telegramTracks.ts와 다르다");
  assert(
    JSON.stringify(dumped.TRACK_ENV_KEYS) === JSON.stringify(TRACK_ENV_KEYS),
    "봇 환경변수 표가 telegramTracks.ts와 다르다 - 알림이 다른 트랙 봇으로 간다"
  );
  assert(JSON.stringify(dumped.TRACK_LABEL) === JSON.stringify(TRACK_LABEL), "트랙 이름표가 telegramTracks.ts와 다르다");
  console.log("✅ 트랙 표가 telegramTracks.ts와 일치한다");
}

// 2) 사용설명서 트랙 원고 1건: 그 트랙 봇으로 가고, 제목·jobId·run URL·재실행 안내가 들어간다.
{
  const stub = await startStub({
    rows: [{ id: "job-kscene-1", keyword: "한효주", metadata: { track: "kscene" } }],
  });
  const result = await runScript(baseEnv(stub.port));
  await stub.close();

  assert(result.code === 0, `스크립트가 실패했다: ${result.stderr}`);
  assert(stub.sent.length === 1, `알림이 1통이어야 한다 - ${stub.sent.length}통`);
  const [message] = stub.sent;
  assert(message!.token === DUMMY_TOKENS.KSCENE_TELEGRAM_BOT_TOKEN, "사용설명서 트랙인데 다른 봇으로 갔다");
  assert(message!.chatId === DUMMY_TOKENS.KSCENE_TELEGRAM_CHAT_ID, "사용설명서 채팅방이 아니다");
  assert(message!.text.includes("한효주"), "원고 제목이 없다");
  assert(message!.text.includes("job-kscene-1"), "jobId가 없다");
  assert(
    message!.text.includes("https://github.com/Jayden-2028/blog-automation/actions/runs/43040388380"),
    "run URL이 없다 - 사람이 로그를 찾아갈 수 없다"
  );
  assert(
    message!.text.includes("gh workflow run job-publish-prepare.yml"),
    "다시 돌리는 방법이 없다 - 알림만 받고 무엇을 할지 모른다"
  );

  // 대기열 조회 조건이 listApprovedWithoutManuscript와 같아야 그 run이 집었을 job이 나온다.
  assert(stub.queries.length === 1, "Supabase 조회가 한 번이어야 한다");
  const query = decodeURIComponent(stub.queries[0]!);
  assert(query.includes("status=eq.approved"), "approved 조건이 빠졌다");
  assert(query.includes("metadata->>channelManuscriptsReadyAt=is.null"), "준비 완료 플래그 조건이 빠졌다");
  assert(query.includes("order=selected_at.asc"), "선정 순서가 아니다 - 다른 job을 집는다");
  console.log("✅ 사용설명서 원고 1건: 그 트랙 봇으로 제목·jobId·run URL·재실행 안내가 간다");
}

// 3) 트랙이 섞인 run: 봇마다 자기 트랙 원고만 받는다(사회 봇에 엔터 원고가 섞이면 안 된다).
{
  const stub = await startStub({
    rows: [
      { id: "job-ent-1", keyword: "엔터 원고", metadata: {} },
      { id: "job-social-1", keyword: "사회 원고", metadata: { track: "social" } },
      { id: "job-living-1", keyword: "일상 원고", metadata: { track: "living" } },
    ],
  });
  const result = await runScript(baseEnv(stub.port));
  await stub.close();

  assert(result.code === 0, `스크립트가 실패했다: ${result.stderr}`);
  assert(stub.sent.length === 2, `봇 2개로 가야 한다 - ${stub.sent.length}통`);
  const ent = stub.sent.find((m) => m.token === DUMMY_TOKENS.TELEGRAM_BOT_TOKEN);
  const social = stub.sent.find((m) => m.token === DUMMY_TOKENS.SOCIAL_TELEGRAM_BOT_TOKEN);
  assert(ent && social, "엔터·사회 봇 각각 한 통이어야 한다");
  assert(ent!.text.includes("엔터 원고") && !ent!.text.includes("사회 원고"), "엔터 봇에 다른 트랙 원고가 섞였다");
  assert(social!.text.includes("사회 원고"), "사회 봇에 사회 원고가 없다");
  // living 트랙 알림은 사회 봇이 받는다(trackOfJob 규칙).
  assert(social!.text.includes("일상 원고"), "living 트랙이 사회 봇으로 가지 않았다");
  console.log("✅ 트랙이 섞인 run: 봇마다 자기 트랙 원고만 받는다");
}

// 4) job을 못 읽는 상황(DB 조회 실패): 기본 봇으로 보내고 "job 식별 실패"를 적는다.
{
  const stub = await startStub({ restStatus: 500 });
  const result = await runScript(baseEnv(stub.port));
  await stub.close();

  assert(result.code === 0, `스크립트가 실패했다: ${result.stderr}`);
  assert(stub.sent.length === 1, `기본 봇으로 1통이어야 한다 - ${stub.sent.length}통`);
  assert(stub.sent[0]!.token === DUMMY_TOKENS.TELEGRAM_BOT_TOKEN, "기본 봇(엔터)이 아니다");
  assert(stub.sent[0]!.text.includes("job 식별 실패"), "job 식별 실패를 적지 않았다");
  assert(stub.sent[0]!.text.includes("HTTP 500"), "조회가 왜 실패했는지 적지 않았다");
  assert(stub.sent[0]!.text.includes("actions/runs/43040388380"), "run URL이 없다");
  console.log("✅ 대기열 조회 실패: 기본 봇으로 가고 사유가 적힌다");
}

// 5) Supabase 자격증명이 아예 없는 환경(워크플로 시크릿 누락)에서도 알림은 나간다.
{
  const stub = await startStub({});
  const env = baseEnv(stub.port);
  delete env.SUPABASE_URL;
  delete env.SUPABASE_SERVICE_ROLE_KEY;
  const result = await runScript(env);
  await stub.close();

  assert(result.code === 0, `스크립트가 실패했다: ${result.stderr}`);
  assert(stub.sent.length === 1, "Supabase가 없어도 한 통은 가야 한다");
  assert(stub.sent[0]!.text.includes("job 식별 실패"), "job 식별 실패를 적지 않았다");
  console.log("✅ Supabase 자격증명이 없어도 알림 자체는 나간다");
}

// 6) 대기열이 비어 있으면(이미 처리됨) 그 사실을 적어 기본 봇으로 보낸다 - 실패는 실패다.
{
  const stub = await startStub({ rows: [] });
  const result = await runScript(baseEnv(stub.port));
  await stub.close();

  assert(stub.sent.length === 1, "대기열이 비어도 한 통은 가야 한다");
  assert(stub.sent[0]!.text.includes("준비 대기 중인 원고가 없습니다"), "대기열이 빈 사실을 적지 않았다");
  console.log("✅ 대기열이 비어 있어도 실패 자체는 알린다");
}

// 7) 발송이 거부되면(봇 토큰 문제 등) 조용히 끝나지 않고 exit 1 + 사유가 로그에 남는다.
{
  const stub = await startStub({ rows: [{ id: "job-1", keyword: "제목", metadata: {} }], sendStatus: 401 });
  const result = await runScript(baseEnv(stub.port));
  await stub.close();

  assert(result.code === 1, `발송 실패는 exit 1이어야 한다 - ${result.code}`);
  assert(result.stderr.includes("보내지 못했습니다"), "발송 실패 사유가 로그에 없다");
  assert(!result.stderr.includes("dummy-ent-token"), "로그에 봇 토큰이 찍혔다");
  console.log("✅ 발송 실패는 exit 1 + 사유 로그(토큰은 찍지 않는다)");
}

// 8) 외부 입력(원고 제목)이 Telegram HTML을 깨뜨리지 않는다.
{
  const stub = await startStub({ rows: [{ id: "job-1", keyword: "<b>태그</b> & 기호", metadata: {} }] });
  const result = await runScript(baseEnv(stub.port));
  await stub.close();

  assert(result.code === 0, `스크립트가 실패했다: ${result.stderr}`);
  assert(stub.sent[0]!.text.includes("&lt;b&gt;태그&lt;/b&gt; &amp; 기호"), "제목이 escape되지 않았다");
  console.log("✅ 제목의 HTML 특수문자를 escape한다");
}

// 9) jobId를 환경변수로 받으면 **대기열을 읽지 않는다**. 입력값이 이미 어느 원고인지 말해 주므로
//    status 조건으로 추측할 필요가 없다 - 조사·집필 중(approved가 아닌) job도 그대로 집는다.
{
  const stub = await startStub({
    rows: [{ id: "job-revise-1", keyword: "한효주", metadata: { track: "kscene" } }],
  });
  const result = await runScript({
    ...baseEnv(stub.port),
    GITHUB_WORKFLOW: "job-revise",
    FAILED_WORKFLOW_FILE: "job-revise.yml",
    FAILED_JOB_ID: "job-revise-1",
  });
  await stub.close();

  assert(result.code === 0, `스크립트가 실패했다: ${result.stderr}`);
  assert(stub.sent.length === 1, `알림이 1통이어야 한다 - ${stub.sent.length}통`);
  assert(stub.sent[0]!.token === DUMMY_TOKENS.KSCENE_TELEGRAM_BOT_TOKEN, "그 job의 트랙 봇으로 가지 않았다");
  assert(stub.sent[0]!.text.includes("한효주"), "원고 제목이 없다");

  assert(stub.queries.length === 1, `조회가 한 번이어야 한다 - ${stub.queries.length}번`);
  const query = decodeURIComponent(stub.queries[0]!);
  assert(query.includes("id=eq.job-revise-1"), "jobId로 직접 묻지 않았다");
  assert(!query.includes("status=eq.approved"), "jobId를 아는데 대기열 조건으로 추측했다 - 다른 job을 집는다");
  assert(
    !query.includes("channelManuscriptsReadyAt"),
    "jobId를 아는데 준비 완료 플래그로 걸렀다 - 조사·집필 중인 job을 못 찾는다"
  );
  console.log("✅ jobId를 받으면 대기열 조회를 생략하고 그 job만 집는다");
}

// 10) 워크플로마다 **무엇이 멈췄는지와 다시 돌리는 명령**이 달라야 한다. "준비 실패"라고만 적으면
//     재작성을 기다리던 사용자는 자기 답장이 날아간 줄 모르고, 재실행 인자도 워크플로마다 다르다.
{
  const expectations: { file: string; title: string; rerun: string; jobId?: string }[] = [
    { file: "job-research.yml", title: "자료조사 실패", rerun: "gh workflow run job-research.yml -f job_id=job-x", jobId: "job-x" },
    { file: "job-write.yml", title: "원고 집필 실패", rerun: "gh workflow run job-write.yml -f job_id=job-x", jobId: "job-x" },
    { file: "job-translate.yml", title: "영어본 번역 실패", rerun: "gh workflow run job-translate.yml -f job_id=job-x", jobId: "job-x" },
    { file: "job-revise.yml", title: "원고 수정 실패", rerun: "gh workflow run job-revise.yml -f job_id=job-x -f feedback=", jobId: "job-x" },
    { file: "job-publish-prepare.yml", title: "원고 준비 실패", rerun: "gh workflow run job-publish-prepare.yml" },
  ];

  const titles = new Set<string>();
  for (const { file, title, rerun, jobId } of expectations) {
    const stub = await startStub({ rows: [{ id: "job-x", keyword: "제목", metadata: {} }] });
    const env: Record<string, string> = {
      ...baseEnv(stub.port),
      FAILED_WORKFLOW_FILE: file,
      GITHUB_WORKFLOW: file.replace(/\.yml$/, ""),
    };
    if (jobId) env.FAILED_JOB_ID = jobId;
    const result = await runScript(env);
    await stub.close();

    assert(result.code === 0, `${file}: 스크립트가 실패했다: ${result.stderr}`);
    assert(stub.sent.length === 1, `${file}: 알림이 1통이어야 한다`);
    const text = stub.sent[0]!.text;
    assert(text.includes(title), `${file}: 제목이 "${title}"이 아니다 - 무엇이 멈췄는지 알 수 없다`);
    assert(text.includes(rerun), `${file}: 다시 돌리는 명령이 "${rerun}"이 아니다`);
    titles.add(title);
  }
  assert(titles.size === expectations.length, "워크플로 문구가 겹친다 - 무엇이 멈췄는지 구분되지 않는다");
  console.log(`✅ 워크플로 ${expectations.length}개의 문구·재실행 명령이 서로 다르다`);
}

// 11) jobId가 가리키는 job이 없을 때(이미 지워졌거나 잘못된 id): 기본 봇으로 보내고 jobId를 남긴다.
//     행을 못 읽어도 jobId만 있으면 사람이 다시 돌릴 수 있다.
{
  const stub = await startStub({ rows: [] });
  const result = await runScript({
    ...baseEnv(stub.port),
    FAILED_WORKFLOW_FILE: "job-write.yml",
    GITHUB_WORKFLOW: "job-write",
    FAILED_JOB_ID: "job-gone",
  });
  await stub.close();

  assert(result.code === 0, `스크립트가 실패했다: ${result.stderr}`);
  assert(stub.sent.length === 1, `기본 봇으로 1통이어야 한다 - ${stub.sent.length}통`);
  assert(stub.sent[0]!.token === DUMMY_TOKENS.TELEGRAM_BOT_TOKEN, "기본 봇(엔터)이 아니다");
  const text = stub.sent[0]!.text;
  assert(text.includes("job 식별 실패"), "job 식별 실패를 적지 않았다");
  assert(text.includes("찾지 못했습니다"), "행을 찾지 못한 사유가 없다");
  assert(text.includes("jobId job-gone"), "jobId가 본문에 없다 - 다시 돌릴 단서가 없다");
  assert(text.includes("gh workflow run job-write.yml -f job_id=job-gone"), "재실행 명령에 jobId가 들어가지 않았다");
  console.log("✅ jobId가 가리키는 job이 없어도 기본 봇으로 가고 jobId가 남는다");
}

console.log("\n✅ testNotifyWorkflowFailure 전체 통과");
