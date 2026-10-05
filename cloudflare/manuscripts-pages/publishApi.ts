// Cloudflare Pages Function 로직 - POST /api/publish-request (원고 뷰어 "🟠 티스토리 발행", 2026-10-06).
// 라우트 파일은 functions/api/publish-request.ts - 그쪽은 이 함수를 부르기만 한다(테스트: npm run test:viewer-publish-api).
//
// editApi.ts와 같은 세 가지만 한다: ① 요청자가 운영자 본인인지(Access JWT) ② 요청 모양 검사 ③ GitHub repository_dispatch.
// DB에는 손대지 않는다 - 큐 등록은 GitHub Actions(publish-request.yml -> src/jobs/publishRequestCli.ts)가 한다.
// 환경변수·인증 규칙은 editApi.ts 상단 설명과 같다(같은 Pages 프로젝트, 같은 변수).

import { verifyAccessToken } from "./editApi.js";
import type { EditApiEnv } from "./editApi.js";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** src/jobs/publishRequestCli.ts의 CHANNELS와 같아야 한다. */
const CHANNELS = ["tistory"] as const;

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function readAccessToken(request: Request): string | null {
  const header = request.headers.get("cf-access-jwt-assertion");
  if (header) return header;
  const cookie = request.headers.get("cookie") ?? "";
  const match = cookie.match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  return match ? match[1] : null;
}

export function validatePublishBody(body: unknown): { ok: true; jobId: string; channel: string } | { ok: false; reason: string } {
  if (!body || typeof body !== "object") return { ok: false, reason: "요청 형식이 아닙니다" };
  const { jobId, channel } = body as { jobId?: unknown; channel?: unknown };
  if (typeof jobId !== "string" || !UUID_RE.test(jobId)) return { ok: false, reason: "jobId가 올바르지 않습니다" };
  if (typeof channel !== "string" || !(CHANNELS as readonly string[]).includes(channel)) {
    return { ok: false, reason: `지원하지 않는 채널입니다: ${String(channel)}` };
  }
  return { ok: true, jobId, channel };
}

export async function handlePublishRequest(
  request: Request,
  env: EditApiEnv,
  fetchImpl: FetchLike = fetch,
  nowMs: number = Date.now()
): Promise<Response> {
  if (request.method !== "POST") return json(405, { ok: false, error: "POST만 받습니다" });
  if (!env.GH_DISPATCH_TOKEN || !env.ACCESS_TEAM_DOMAIN || !env.OWNER_EMAIL) {
    return json(503, { ok: false, code: "not_configured", error: "발행 요청이 아직 설정되지 않았습니다(Pages 환경변수)" });
  }

  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin) return json(403, { ok: false, error: "출처가 다릅니다" });

  const token = readAccessToken(request);
  if (!token) return json(401, { ok: false, error: "로그인 정보가 없습니다" });
  let auth: Awaited<ReturnType<typeof verifyAccessToken>>;
  try {
    auth = await verifyAccessToken(token, env, fetchImpl, nowMs);
  } catch (error) {
    return json(502, { ok: false, error: error instanceof Error ? error.message : "인증 확인 실패" });
  }
  if (!auth.ok) return json(403, { ok: false, error: `인증 실패: ${auth.reason}` });

  let body: unknown;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return json(400, { ok: false, error: "JSON이 아닙니다" });
  }
  const checked = validatePublishBody(body);
  if (!checked.ok) return json(400, { ok: false, error: checked.reason });

  const owner = env.GITHUB_OWNER || "Jayden-2028";
  const repo = env.GITHUB_REPO || "blog-automation";
  const res = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "blog-automation-manuscripts-pages",
    },
    body: JSON.stringify({ event_type: "publish_request", client_payload: { jobId: checked.jobId, channel: checked.channel } }),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    return json(502, { ok: false, error: `GitHub 요청 실패(${res.status}) ${detail}`.trim() });
  }
  return json(202, { ok: true, channel: checked.channel });
}
