// `job-publish-prepare` 실패 알림(scripts/notifyWorkflowFailure.mjs)을 **실제로 실행해** 검증한다.
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

console.log("\n✅ testNotifyWorkflowFailure 전체 통과");
