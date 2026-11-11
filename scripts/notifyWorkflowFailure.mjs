// `job-publish-prepare` 워크플로가 실패했을 때 그 트랙 봇으로 텔레그램 한 통을 보낸다.
// 실행: node scripts/notifyWorkflowFailure.mjs   (워크플로의 `if: failure()` 스텝이 부른다)
//
// ─ 왜 이 파일만 의존성이 없는가 ────────────────────────────────────────────────
// 이 알림이 막아야 하는 사고는 **Node 프로세스가 시작조차 못 하고 죽는 경우**다. 2026-11-11
// 한효주 인물 백과 수정 반영 run 43040388380은 `npm run job:publish-poll`에 닿기도 전에
// 폰트·Chromium 설치(apt 이름풀이)에서 죽었고, 그래서 `job:publish-poll` 안의 try/catch로는
// 절대 잡히지 않는다. 같은 이유로 알림 경로가 `npm ci`·`tsx`·`dist/`에 기대면 안 된다 - npm ci가
// 흔들린 run에서는 알림도 함께 죽는다.
//   · TypeScript(src/**)가 아니라 .mjs인 이유: tsx도 node_modules도 필요 없다.
//   · curl+jq 대신 node인 이유: 러너에 node는 setup-node 이전부터 있고(미리 설치됨),
//     JSON 파싱·HTML escape·여러 트랙 분기를 bash로 쓰면 테스트가 불가능하다. 지금 이 파일은
//     `npm run test:workflow-failure-notify`가 가짜 Supabase·Telegram 서버를 띄워 **실제로 실행**한다.
//   · 그래도 못 보내는 경우: checkout 실패(파일 자체가 없다)와 러너 자체가 죽는 경우. 그건
//     워크플로 안에서는 어떻게도 못 덮는다(바깥 감시인 몫 - watchdog.yml 계열).
//
// 자격증명은 어떤 경우에도 로그로 출력하지 않는다.

import { pathToFileURL } from "node:url";

const TELEGRAM_API_BASE = process.env.TELEGRAM_API_BASE ?? "https://api.telegram.org";
const FETCH_TIMEOUT_MS = Number(process.env.NOTIFY_FETCH_TIMEOUT_MS ?? 15_000);
const TELEGRAM_CHAR_LIMIT = 3900;
// prepareApprovedManuscripts의 maxJobsPerRun과 같은 수 - 그 run이 집었을 job만 적는다.
const MAX_JOBS = 3;

// src/notifications/telegramTracks.ts의 표를 그대로 옮긴 것. TS를 import할 수 없어 복제했고,
// 갈라지지 않도록 `--print-tracks`로 덤프해 테스트가 TS 쪽 표와 대조한다.
const DEFAULT_TRACK = "entertainment";
const TRACK_ENV_KEYS = {
  entertainment: { botToken: "TELEGRAM_BOT_TOKEN", chatId: "TELEGRAM_CHAT_ID" },
  social: { botToken: "SOCIAL_TELEGRAM_BOT_TOKEN", chatId: "SOCIAL_TELEGRAM_CHAT_ID" },
  kscene: { botToken: "KSCENE_TELEGRAM_BOT_TOKEN", chatId: "KSCENE_TELEGRAM_CHAT_ID" },
};
const TRACK_LABEL = { entertainment: "엔터", social: "사회 이슈", kscene: "사용설명서" };

/** trackOfJob(telegramTracks.ts)과 같은 규칙. 모르는 값·빈 값은 엔터다. */
export function trackOfJob(job) {
  const raw = job?.metadata?.track;
  if (typeof raw === "string") {
    if (Object.hasOwn(TRACK_ENV_KEYS, raw)) return raw;
    // 종합 키워드 입력 툴의 living·tech 트랙은 알림이 사회로 간다.
    if (raw === "living" || raw === "tech") return "social";
  }
  return DEFAULT_TRACK;
}

function escapeHtml(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 사람이 알아볼 제목. keyword가 비면 job id만 남는다. */
function jobLine(job) {
  const title = typeof job.keyword === "string" && job.keyword.trim() ? job.keyword.trim() : "(제목 없음)";
  const id = typeof job.id === "string" ? job.id : "?";
  return `• ${escapeHtml(title)}\n  <code>jobId ${escapeHtml(id)}</code>`;
}

/**
 * 알림 본문. jobs가 비면(식별 실패·대기열 없음) reason을 적어 그대로 보낸다 - 무엇이 실패했는지는
 * job을 몰라도 알려야 한다.
 */
export function buildFailureMessage({ workflowFile, workflowName, runUrl, jobs, unidentifiedReason, now }) {
  const stamp = (now ?? new Date()).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
  const lines = [
    `🚨 <b>원고 준비 실패</b> — ${escapeHtml(workflowName || workflowFile)}`,
    stamp,
    "",
    "승인된 원고를 준비하는 워크플로가 끝까지 돌지 못했습니다.",
    "뷰어·발행 버튼은 <b>아직 갱신되지 않았습니다</b>.",
    "",
  ];

  if (jobs.length > 0) {
    lines.push("<b>준비되지 않은 원고</b>", ...jobs.map(jobLine), "");
  } else {
    lines.push(`<b>job 식별 실패</b> — ${escapeHtml(unidentifiedReason ?? "대기 중인 원고를 확인하지 못했습니다")}`, "");
  }

  lines.push(
    `실패한 run: ${escapeHtml(runUrl)}`,
    "어느 단계에서 죽었는지는 위 run 로그에서 봅니다.",
    "",
    `다시 돌리기: <code>gh workflow run ${escapeHtml(workflowFile)}</code>`,
    "(대기 중인 원고를 처음부터 다시 준비합니다 - 입력값 없음)"
  );

  const message = lines.join("\n");
  return message.length > TELEGRAM_CHAR_LIMIT ? `${message.slice(0, TELEGRAM_CHAR_LIMIT)}\n…(생략)` : message;
}

async function fetchJson(url, init) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  const body = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.slice(0, 200)}`);
  return body ? JSON.parse(body) : null;
}

/**
 * 이 run이 준비하려던 job. ArticleJobRepository.listApprovedWithoutManuscript와 같은 조건
 * (status=approved + metadata.channelManuscriptsReadyAt is null, selected_at 오름차순)을
 * PostgREST로 직접 묻는다 - supabase-js를 쓰면 node_modules가 필요하다.
 */
export async function loadPendingJobs(env = process.env) {
  const baseUrl = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!baseUrl || !key) throw new Error("SUPABASE_URL 또는 SUPABASE_SERVICE_ROLE_KEY가 없습니다");

  const url = new URL("/rest/v1/article_jobs", baseUrl);
  url.searchParams.set("select", "id,keyword,metadata,selected_at");
  url.searchParams.set("status", "eq.approved");
  url.searchParams.set("metadata->>channelManuscriptsReadyAt", "is.null");
  url.searchParams.set("order", "selected_at.asc");
  url.searchParams.set("limit", String(MAX_JOBS));

  const rows = await fetchJson(url, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  return Array.isArray(rows) ? rows : [];
}

/** 트랙별로 묶는다. 한 run이 여러 트랙의 원고를 집을 수 있어 봇도 여러 개가 된다. */
export function groupJobsByTrack(jobs) {
  const groups = new Map();
  for (const job of jobs) {
    const track = trackOfJob(job);
    if (!groups.has(track)) groups.set(track, []);
    groups.get(track).push(job);
  }
  return groups;
}

async function sendTelegram(track, text, env) {
  const keys = TRACK_ENV_KEYS[track];
  const botToken = env[keys.botToken];
  const chatId = env[keys.chatId];
  if (!botToken || !chatId) throw new Error(`${keys.botToken} 또는 ${keys.chatId}가 없습니다 (track=${track})`);

  await fetchJson(`${TELEGRAM_API_BASE}/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
}

async function main() {
  const env = process.env;
  const workflowFile = env.FAILED_WORKFLOW_FILE || "job-publish-prepare.yml";
  const workflowName = env.GITHUB_WORKFLOW || workflowFile;
  const server = env.GITHUB_SERVER_URL || "https://github.com";
  const runUrl =
    env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
      ? `${server}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
      : "(run 주소를 알 수 없습니다)";

  let jobs = [];
  let unidentifiedReason;
  try {
    jobs = await loadPendingJobs(env);
    if (jobs.length === 0) unidentifiedReason = "준비 대기 중인 원고가 없습니다(이미 처리됐거나 큐가 비었습니다)";
  } catch (error) {
    // job을 못 읽어도 알림은 보낸다 - 조용한 실패가 가장 나쁘다.
    unidentifiedReason = `대기열 조회 실패: ${error instanceof Error ? error.message : String(error)}`;
  }

  // job을 못 읽었으면 기본 봇(엔터) 한 통. 읽었으면 그 job들의 트랙 봇으로 나눠 보낸다.
  const groups = jobs.length > 0 ? groupJobsByTrack(jobs) : new Map([[DEFAULT_TRACK, []]]);

  let sent = 0;
  const failures = [];
  for (const [track, trackJobs] of groups) {
    const message = buildFailureMessage({ workflowFile, workflowName, runUrl, jobs: trackJobs, unidentifiedReason });
    try {
      await sendTelegram(track, message, env);
      sent += 1;
      console.log(`ℹ️ 실패 알림 발송 - ${TRACK_LABEL[track]} 봇 (원고 ${trackJobs.length}건)`);
    } catch (error) {
      failures.push(`${TRACK_LABEL[track]}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (failures.length > 0) {
    console.error(`⚠️ 실패 알림을 보내지 못했습니다 - ${failures.join(" / ")}`);
    if (sent === 0) process.exitCode = 1;
  }
}

// 직접 실행했을 때만 보낸다. import만으로 발송이 일어나면(운영 .env가 로드된 셸에서) 실제 메시지가 나간다.
const isEntryPoint = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (isEntryPoint) {
  if (process.argv.includes("--print-tracks")) {
    // 테스트가 TS 쪽 표(telegramTracks.ts)와 대조하는 용도. 토큰 값은 담지 않는다(키 이름만).
    console.log(JSON.stringify({ DEFAULT_TRACK, TRACK_ENV_KEYS, TRACK_LABEL }));
  } else {
    await main();
  }
}
