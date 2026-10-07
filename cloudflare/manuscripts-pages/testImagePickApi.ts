// /api/image-pick 테스트. 인증 경로는 editApi와 같으므로(verifyAccessToken 공유) 요청 모양·거절 코드만 본다.
// 실행: npm run test:viewer-image-pick-api
import { handleImagePickRequest, validateImagePickBody } from "./imagePickApi.js";
import type { EditApiEnv } from "./editApi.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const JOB = "054bfe0b-1234-4abc-8def-0123456789ab";
const ENV: EditApiEnv = { GH_DISPATCH_TOKEN: "gh", ACCESS_TEAM_DOMAIN: "team", OWNER_EMAIL: "o@x.y" };
const GOOD = { jobId: JOB, index: 2, candidateNumber: 3, fromUrl: "https://x.supabase.co/a.webp?v=1" };

async function main(): Promise<void> {
  assert(validateImagePickBody(GOOD).ok, "정상 본문");
  assert(validateImagePickBody({ ...GOOD, fromUrl: undefined }).ok, "fromUrl 생략 허용(빈 자리)");
  assert(!validateImagePickBody({ ...GOOD, jobId: "nope" }).ok, "jobId 검사");
  assert(!validateImagePickBody({ ...GOOD, index: 0 }).ok, "index 0 거절");
  assert(!validateImagePickBody({ ...GOOD, index: "2" }).ok, "index 문자열 거절");
  assert(!validateImagePickBody({ ...GOOD, candidateNumber: 100 }).ok, "후보 번호 범위");
  assert(!validateImagePickBody({ ...GOOD, fromUrl: "x".repeat(2001) }).ok, "fromUrl 길이");
  // 클라이언트가 보낸 다른 필드(예: url)는 결과에 실리지 않는다 - 신뢰하지 않는다.
  const withUrl = validateImagePickBody({ ...GOOD, url: "https://evil.example/x.png" });
  assert(withUrl.ok && !("url" in withUrl), "클라이언트 url은 버린다");
  console.log("✅ 본문 검사");

  const req = (over: Partial<{ method: string; origin: string; cookie: string; body: string }> = {}) =>
    new Request("https://pages.example/api/image-pick", {
      method: over.method ?? "POST",
      headers: { origin: over.origin ?? "https://pages.example", cookie: over.cookie ?? "", "content-type": "application/json" },
      body: over.method === "GET" ? undefined : (over.body ?? JSON.stringify(GOOD)),
    });

  assert((await handleImagePickRequest(req(), {})).status === 503, "미설정 503");
  assert((await handleImagePickRequest(req({ method: "GET" }), ENV)).status === 405, "GET 405");
  assert((await handleImagePickRequest(req({ origin: "https://evil.example" }), ENV)).status === 403, "다른 출처 403");
  assert((await handleImagePickRequest(req(), ENV)).status === 401, "토큰 없음 401");
  const bad = await handleImagePickRequest(req({ cookie: "CF_Authorization=not.a.jwt" }), ENV, async () => new Response("[]"));
  assert(bad.status === 403, `깨진 토큰은 403 (${bad.status})`);
  console.log("✅ 거절 코드 - 503/405/403/401");

  console.log("\n✅ testImagePickApi 전체 통과");
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
