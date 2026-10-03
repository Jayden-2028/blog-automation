// 원고 뷰어 "수정본 반영" Pages Function 테스트. 실행: npm run test:viewer-edit-api
// 네트워크를 쓰지 않는다 - Access 공개키와 GitHub API는 가짜 fetch가 답한다. 토큰은 이 테스트가
// 만든 RSA 키로 **실제로 서명**한다(검증 코드가 진짜 WebCrypto 경로를 탄다).
//
// 지켜야 할 것: ① 설정이 없으면 닫힌다(503) ② 다른 출처는 거부 ③ 토큰 없음·위조·만료·다른 계정·다른 AUD는
// 거부 ④ 정상 요청만 repository_dispatch(manuscript_edit)로 넘어가고 payload는 jobId·edits뿐이다
// ⑤ 형식이 틀린 edits는 거부.
import { handleEditRequest, resetCertCache } from "./editApi.js";
import type { EditApiEnv } from "./editApi.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const TEAM = "myteam.cloudflareaccess.com";
const AUD = "aud-tag-123";
const OWNER = "owner@example.com";
const PAGE = "https://blog-automation-manuscripts.pages.dev";
const JOB = "054bfe0b-1234-4abc-8def-0123456789ab";

const ENV: EditApiEnv = { GH_DISPATCH_TOKEN: "gh-token", ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, OWNER_EMAIL: OWNER };

function b64url(bytes: Uint8Array | string): string {
  const buf = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : Buffer.from(bytes);
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function makeKey(): Promise<{ privateKey: CryptoKey; jwk: JsonWebKey }> {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return { privateKey: pair.privateKey, jwk: { ...jwk, kid: "k1" } as JsonWebKey };
}

async function sign(privateKey: CryptoKey, payload: Record<string, unknown>, kid = "k1"): Promise<string> {
  const head = b64url(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
}

const NOW_MS = Date.UTC(2026, 9, 3, 10, 0, 0);
const NOW = Math.floor(NOW_MS / 1000);

function claims(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { iss: `https://${TEAM}`, aud: [AUD], email: OWNER, exp: NOW + 600, iat: NOW - 10, ...over };
}

const BODY = { jobId: JOB, edits: { "0": { from: "원문", to: "고친 문장" }, "cap:1": { from: "옛 캡션", to: "새 캡션" } } };

function request(opts: { token?: string | null; origin?: string | null; body?: unknown; cookie?: boolean } = {}): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.origin !== null) headers.origin = opts.origin ?? PAGE;
  if (opts.token) {
    if (opts.cookie) headers.cookie = `other=1; CF_Authorization=${opts.token}`;
    else headers["cf-access-jwt-assertion"] = opts.token;
  }
  return new Request(`${PAGE}/api/manuscript-edit`, {
    method: "POST",
    headers,
    body: JSON.stringify(opts.body ?? BODY),
  });
}

async function main(): Promise<void> {
  console.log("▶ 수정본 반영 API 테스트 시작\n");
  const { privateKey, jwk } = await makeKey();
  const other = await makeKey();

  const dispatched: { url: string; init?: RequestInit }[] = [];
  const fakeFetch = async (url: string, init?: RequestInit): Promise<Response> => {
    if (url === `https://${TEAM}/cdn-cgi/access/certs`) return new Response(JSON.stringify({ keys: [jwk] }));
    if (url.endsWith("/dispatches")) {
      dispatched.push({ url, init });
      return new Response(null, { status: 204 });
    }
    return new Response("unexpected", { status: 500 });
  };
  const call = (req: Request, env: EditApiEnv = ENV) => handleEditRequest(req, env, fakeFetch, NOW_MS);
  const good = await sign(privateKey, claims());

  // ① 설정 없음
  {
    const res = await call(request({ token: good }), { ...ENV, ACCESS_TEAM_DOMAIN: undefined });
    assert(res.status === 503, `팀 도메인이 없으면 503 (${res.status})`);
    const res2 = await call(request({ token: good }), { ...ENV, GH_DISPATCH_TOKEN: undefined });
    assert(res2.status === 503, `토큰이 없으면 503 (${res2.status})`);
    const res3 = await call(request({ token: good }), { ...ENV, OWNER_EMAIL: undefined });
    assert(res3.status === 503, `소유자 이메일이 없으면 503 (${res3.status})`);
  }
  console.log("✅ 설정이 하나라도 없으면 닫힌다(503)");

  // ② 출처
  {
    assert((await call(request({ token: good, origin: "https://evil.example" }))).status === 403, "다른 출처는 403");
    assert((await call(request({ token: good, origin: null }))).status === 403, "Origin 없음은 403");
  }
  console.log("✅ 다른 출처·Origin 없는 요청은 거부");

  // ③ 인증
  {
    assert((await call(request({ token: null }))).status === 401, "토큰 없음 401");
    const forged = await sign(other.privateKey, claims());
    assert((await call(request({ token: forged }))).status === 403, "다른 키로 서명한 토큰은 403");
    const tampered = good.split(".");
    tampered[1] = b64url(JSON.stringify(claims({ email: "attacker@example.com" })));
    assert((await call(request({ token: tampered.join(".") }))).status === 403, "내용을 바꾼 토큰은 403");
    assert((await call(request({ token: await sign(privateKey, claims({ exp: NOW - 1 })) }))).status === 403, "만료 403");
    assert((await call(request({ token: await sign(privateKey, claims({ email: "someone@example.com" })) }))).status === 403, "다른 계정 403");
    assert((await call(request({ token: await sign(privateKey, claims({ aud: ["other-app"] })) }))).status === 403, "다른 AUD 403");
    assert((await call(request({ token: await sign(privateKey, claims({ iss: "https://evil.cloudflareaccess.com" })) }))).status === 403, "다른 발급자 403");
    assert((await call(request({ token: await sign(privateKey, claims(), "unknown-kid") }))).status === 403, "모르는 키 ID 403");
    assert(dispatched.length === 0, "거부된 요청은 GitHub로 넘어가면 안 된다");
  }
  console.log("✅ 토큰 없음·위조·변조·만료·다른 계정·다른 AUD·다른 발급자는 거부");

  // ④ 정상
  {
    resetCertCache();
    const res = await call(request({ token: good }));
    assert(res.status === 202, `정상 요청은 202 (${res.status} ${await res.clone().text()})`);
    assert(dispatched.length === 1, "repository_dispatch 1회");
    const sent = JSON.parse(String(dispatched[0].init?.body));
    assert(dispatched[0].url === "https://api.github.com/repos/Jayden-2028/blog-automation/dispatches", `저장소 (${dispatched[0].url})`);
    assert(sent.event_type === "manuscript_edit", "event_type");
    assert(sent.client_payload.jobId === JOB && sent.client_payload.edits["cap:1"].to === "새 캡션", "payload");
    assert(Object.keys(sent.client_payload).length === 2, "payload에는 jobId·edits만");
    assert((dispatched[0].init?.headers as Record<string, string>).Authorization === "Bearer gh-token", "토큰 헤더");
    // 쿠키로 온 토큰도 받는다(헤더가 없는 경로).
    const viaCookie = await call(request({ token: good, cookie: true }));
    assert(viaCookie.status === 202, `쿠키 토큰도 202 (${viaCookie.status})`);
    // AUD를 설정하지 않으면 AUD 검사는 건너뛴다(권장은 설정).
    const noAud = await call(request({ token: await sign(privateKey, claims({ aud: ["x"] })) }), { ...ENV, ACCESS_AUD: undefined });
    assert(noAud.status === 202, `AUD 미설정이면 검사 생략 (${noAud.status})`);
  }
  console.log("✅ 정상 요청만 manuscript_edit dispatch로 넘어간다(payload = jobId·edits)");

  // ⑤ 형식
  {
    const before = dispatched.length;
    assert((await call(request({ token: good, body: { jobId: "x", edits: BODY.edits } }))).status === 400, "jobId 형식 400");
    assert((await call(request({ token: good, body: { jobId: JOB, edits: {} } }))).status === 400, "빈 edits 400");
    assert((await call(request({ token: good, body: { jobId: JOB, edits: { "__proto__x": { from: "a", to: "b" } } } }))).status === 400, "모르는 키 400");
    assert((await call(request({ token: good, body: { jobId: JOB, edits: { "0": { from: 1, to: "b" } } } }))).status === 400, "문자열 아님 400");
    const huge = "가".repeat(19000);
    const big = { jobId: JOB, edits: { "0": { from: huge, to: huge }, "1": { from: huge, to: huge } } };
    assert((await call(request({ token: good, body: big }))).status === 413, "너무 큰 요청 413");
    assert(dispatched.length === before, "거부된 요청은 넘어가면 안 된다");
  }
  console.log("✅ 형식이 틀리거나 너무 큰 요청은 거부");

  // GitHub 실패는 502로 알린다.
  {
    const failing = async (url: string): Promise<Response> =>
      url.endsWith("/certs") ? new Response(JSON.stringify({ keys: [jwk] })) : new Response("Bad credentials", { status: 401 });
    const res = await handleEditRequest(request({ token: good }), ENV, failing, NOW_MS);
    assert(res.status === 502, `GitHub 실패는 502 (${res.status})`);
  }
  console.log("✅ GitHub 요청 실패는 502로 알린다");

  console.log("\n✅ 수정본 반영 API 테스트 전부 통과");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
