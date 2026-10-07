// Cloudflare Pages Function 로직 - POST /api/image-pick (원고 뷰어 후보 이미지 클릭 교체, 2026-10-07).
// 라우트 파일은 functions/api/image-pick.ts - 그쪽은 이 함수를 부르기만 한다(테스트: npm run test:viewer-image-pick-api).
//
// editApi.ts와 같은 세 가지만 한다: ① 요청자가 운영자 본인인지(Access JWT) ② 요청 모양 검사 ③ GitHub repository_dispatch.
// DB·Storage에는 손대지 않는다 - 교체는 GitHub Actions(image-pick.yml -> applyImagePickCli.ts)가 한다.
// **클라이언트가 보낸 이미지 주소는 받지도 싣지도 않는다** - 후보는 DB의 imageCandidates에서 번호로 찾는다.
// fromUrl(뷰어가 본 현재 채택 이미지)은 경합 검사용으로만 넘긴다. 환경변수·인증 규칙은 editApi.ts와 같다.

import { verifyAccessToken } from "./editApi.js";
import type { EditApiEnv } from "./editApi.js";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** src/workflows/manuscripts/applyImagePick.ts의 MAX_FROM_URL_LENGTH와 같아야 한다. */
const MAX_FROM_URL_LENGTH = 2000;
const MAX_BODY_BYTES = 8000;

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

export function validateImagePickBody(
  body: unknown
): { ok: true; jobId: string; index: number; candidateNumber: number; fromUrl: string } | { ok: false; reason: string } {
  if (!body || typeof body !== "object") return { ok: false, reason: "요청 형식이 아닙니다" };
  const { jobId, index, candidateNumber, fromUrl } = body as Record<string, unknown>;
  if (typeof jobId !== "string" || !UUID_RE.test(jobId)) return { ok: false, reason: "jobId가 올바르지 않습니다" };
  if (!Number.isInteger(index) || (index as number) < 1 || (index as number) > 999) return { ok: false, reason: "index가 올바르지 않습니다" };
  if (!Number.isInteger(candidateNumber) || (candidateNumber as number) < 1 || (candidateNumber as number) > 99) {
    return { ok: false, reason: "candidateNumber가 올바르지 않습니다" };
  }
  if (fromUrl !== undefined && fromUrl !== null && typeof fromUrl !== "string") return { ok: false, reason: "fromUrl이 올바르지 않습니다" };
  const from = typeof fromUrl === "string" ? fromUrl : "";
  if (from.length > MAX_FROM_URL_LENGTH) return { ok: false, reason: "fromUrl이 너무 깁니다" };
  return { ok: true, jobId, index: index as number, candidateNumber: candidateNumber as number, fromUrl: from };
}

export async function handleImagePickRequest(
  request: Request,
  env: EditApiEnv,
  fetchImpl: FetchLike = fetch,
  nowMs: number = Date.now()
): Promise<Response> {
  if (request.method !== "POST") return json(405, { ok: false, error: "POST만 받습니다" });
  if (!env.GH_DISPATCH_TOKEN || !env.ACCESS_TEAM_DOMAIN || !env.OWNER_EMAIL) {
    return json(503, { ok: false, code: "not_configured", error: "이미지 교체가 아직 설정되지 않았습니다(Pages 환경변수)" });
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

  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return json(413, { ok: false, error: "요청이 너무 큽니다" });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return json(400, { ok: false, error: "JSON이 아닙니다" });
  }
  const checked = validateImagePickBody(body);
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
    body: JSON.stringify({
      event_type: "image_pick",
      client_payload: {
        jobId: checked.jobId,
        index: checked.index,
        candidateNumber: checked.candidateNumber,
        fromUrl: checked.fromUrl,
      },
    }),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    return json(502, { ok: false, error: `GitHub 요청 실패(${res.status}) ${detail}`.trim() });
  }
  return json(202, { ok: true, index: checked.index, candidateNumber: checked.candidateNumber });
}
