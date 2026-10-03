// 원고 뷰어 "📤 수정본 반영" 버튼의 서버 쪽(Cloudflare Pages Function, 2026-10-03).
// 라우트 파일은 functions/api/manuscript-edit.ts - 그쪽은 이 함수를 부르기만 한다(테스트를 여기서 한다).
//
// 하는 일은 셋뿐이다: ① 요청자가 운영자 본인인지 확인 ② 요청 모양 검사 ③ GitHub repository_dispatch.
// DB에는 손대지 않는다 - 실제 반영은 GitHub Actions(manuscript-edit.yml)가 Node 코드로 한다.
// 텔레그램 릴레이(cloudflare/telegram-relay)와 같은 분업이다: 여기 비즈니스 로직을 두면 두 벌이 된다.
//
// ## 왜 Access 헤더를 믿지 않고 JWT를 직접 검증하는가
// Access 애플리케이션은 `blog-automation-manuscripts.pages.dev`에만 걸려 있다(2026-09-14). Pages는
// 배포마다 `<해시>.blog-automation-manuscripts.pages.dev` 주소를 따로 만들고, 그 주소는 그 Access
// 앱의 보호를 받지 않는다. 그 주소로 이 API를 직접 부르면 Access를 거치지 않는다 - 그래서 Access가
// 서명한 토큰(`Cf-Access-Jwt-Assertion` 헤더 또는 `CF_Authorization` 쿠키)을 팀 공개키로 검증하고,
// 그 토큰의 이메일이 OWNER_EMAIL과 같을 때만 통과시킨다. 설정값이 하나라도 없으면 **닫힌다**(503).
//
// 필요한 Pages 환경변수(Cloudflare 대시보드 → Pages → 프로젝트 → 설정 → 변수 및 시크릿, Production):
//   GH_DISPATCH_TOKEN   (시크릿) repository_dispatch 권한 토큰 - 텔레그램 릴레이의 것과 같은 PAT면 된다
//   ACCESS_TEAM_DOMAIN  예: myteam.cloudflareaccess.com (Zero Trust → 설정 → 사용자 지정 페이지의 팀 도메인)
//   OWNER_EMAIL         Access 정책 owner-email의 그 이메일
//   ACCESS_AUD          (권장) Access 애플리케이션의 "애플리케이션 대상(AUD) 태그"
//   GITHUB_OWNER/GITHUB_REPO  생략하면 Jayden-2028/blog-automation

export interface EditApiEnv {
  GH_DISPATCH_TOKEN?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  OWNER_EMAIL?: string;
  GITHUB_OWNER?: string;
  GITHUB_REPO?: string;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** src/workflows/manuscripts/applyViewerEdits.ts의 VIEWER_EDIT_KEY_RE와 같아야 한다. */
const KEY_RE = /^(?:\d{1,4}(?::[hb])?|cap:\d{1,3})$/;
const MAX_EDITS = 300;
const MAX_VALUE_LENGTH = 20000;
/** repository_dispatch client_payload 상한(GitHub 문서상 64KB 안팎)보다 넉넉히 작게. */
const MAX_PAYLOAD_BYTES = 60000;

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

// ---------- Access JWT ----------

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(b64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeJsonPart(part: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(part))) as Record<string, unknown>;
}

function teamOrigin(domain: string): string {
  return `https://${domain.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;
}

function readAccessToken(request: Request): string | null {
  const header = request.headers.get("cf-access-jwt-assertion");
  if (header) return header;
  const cookie = request.headers.get("cookie") ?? "";
  const match = cookie.match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  return match ? match[1] : null;
}

type CertCache = { origin: string; at: number; keys: JsonWebKey[] };
let certCache: CertCache | null = null;
const CERT_TTL_MS = 10 * 60 * 1000;

/** 테스트용 - 모듈 수준 캐시를 비운다. */
export function resetCertCache(): void {
  certCache = null;
}

async function loadCerts(origin: string, fetchImpl: FetchLike, nowMs: number): Promise<JsonWebKey[]> {
  if (certCache && certCache.origin === origin && nowMs - certCache.at < CERT_TTL_MS) return certCache.keys;
  const res = await fetchImpl(`${origin}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access 공개키를 받지 못했습니다(${res.status})`);
  const body = (await res.json()) as { keys?: JsonWebKey[] };
  const keys = Array.isArray(body.keys) ? body.keys : [];
  certCache = { origin, at: nowMs, keys };
  return keys;
}

export async function verifyAccessToken(
  token: string,
  env: EditApiEnv,
  fetchImpl: FetchLike,
  nowMs: number
): Promise<{ ok: true; email: string } | { ok: false; reason: string }> {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "토큰 형식 아님" };
  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = decodeJsonPart(parts[0]);
    payload = decodeJsonPart(parts[1]);
  } catch {
    return { ok: false, reason: "토큰 해독 실패" };
  }
  if (header.alg !== "RS256" || typeof header.kid !== "string") return { ok: false, reason: "지원하지 않는 서명" };

  const origin = teamOrigin(env.ACCESS_TEAM_DOMAIN ?? "");
  const keys = await loadCerts(origin, fetchImpl, nowMs);
  const jwk = keys.find((k) => (k as { kid?: string }).kid === header.kid);
  if (!jwk) return { ok: false, reason: "서명 키를 찾지 못함" };

  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    base64UrlToBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  );
  if (!valid) return { ok: false, reason: "서명 불일치" };

  const nowSec = Math.floor(nowMs / 1000);
  if (typeof payload.exp !== "number" || payload.exp <= nowSec) return { ok: false, reason: "토큰 만료" };
  if (typeof payload.nbf === "number" && payload.nbf > nowSec + 60) return { ok: false, reason: "토큰 사용 전" };
  if (payload.iss !== origin) return { ok: false, reason: "발급자 불일치" };
  if (env.ACCESS_AUD) {
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(env.ACCESS_AUD)) return { ok: false, reason: "대상(AUD) 불일치" };
  }
  const email = typeof payload.email === "string" ? payload.email.toLowerCase() : "";
  if (!email || email !== (env.OWNER_EMAIL ?? "").trim().toLowerCase()) return { ok: false, reason: "허용된 계정 아님" };
  return { ok: true, email };
}

// ---------- 요청 검사 ----------

type Edits = Record<string, { from: string; to: string }>;

function validateBody(body: unknown): { ok: true; jobId: string; edits: Edits } | { ok: false; reason: string } {
  if (!body || typeof body !== "object") return { ok: false, reason: "요청 형식이 아닙니다" };
  const { jobId, edits } = body as { jobId?: unknown; edits?: unknown };
  if (typeof jobId !== "string" || !UUID_RE.test(jobId)) return { ok: false, reason: "jobId가 올바르지 않습니다" };
  if (!edits || typeof edits !== "object" || Array.isArray(edits)) return { ok: false, reason: "edits가 없습니다" };
  const entries = Object.entries(edits as Record<string, unknown>);
  if (entries.length === 0) return { ok: false, reason: "고친 항목이 없습니다" };
  if (entries.length > MAX_EDITS) return { ok: false, reason: "고친 항목이 너무 많습니다" };
  const clean: Edits = {};
  for (const [key, value] of entries) {
    const { from, to } = (value ?? {}) as { from?: unknown; to?: unknown };
    if (!KEY_RE.test(key) || typeof from !== "string" || typeof to !== "string") {
      return { ok: false, reason: `항목 형식이 올바르지 않습니다: ${key}` };
    }
    if (from.length > MAX_VALUE_LENGTH || to.length > MAX_VALUE_LENGTH) return { ok: false, reason: `값이 너무 깁니다: ${key}` };
    clean[key] = { from, to };
  }
  return { ok: true, jobId, edits: clean };
}

// ---------- 핸들러 ----------

export async function handleEditRequest(
  request: Request,
  env: EditApiEnv,
  fetchImpl: FetchLike = fetch,
  nowMs: number = Date.now()
): Promise<Response> {
  if (request.method !== "POST") return json(405, { ok: false, error: "POST만 받습니다" });

  if (!env.GH_DISPATCH_TOKEN || !env.ACCESS_TEAM_DOMAIN || !env.OWNER_EMAIL) {
    return json(503, { ok: false, code: "not_configured", error: "서버 반영이 아직 설정되지 않았습니다(Pages 환경변수)" });
  }

  // 다른 사이트에서 폼/스크립트로 찌르는 것을 막는다. 같은 출처의 fetch는 항상 Origin을 싣는다.
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
  if (new TextEncoder().encode(text).length > MAX_PAYLOAD_BYTES) {
    return json(413, { ok: false, error: "수정이 너무 큽니다 - 나눠서 반영하세요" });
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return json(400, { ok: false, error: "JSON이 아닙니다" });
  }
  const checked = validateBody(body);
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
      event_type: "manuscript_edit",
      client_payload: { jobId: checked.jobId, edits: checked.edits },
    }),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    return json(502, { ok: false, error: `GitHub 요청 실패(${res.status}) ${detail}`.trim() });
  }
  return json(202, { ok: true, count: Object.keys(checked.edits).length });
}
