// /api/publish-request 테스트. 인증 경로는 editApi와 같으므로(verifyAccessToken 공유) 여기서는 요청 모양·dispatch payload·
// 거절 코드만 본다. 실행: npm run test:viewer-publish-api
import { handlePublishRequest, validatePublishBody } from "./publishApi.js";
import type { EditApiEnv } from "./editApi.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const JOB = "054bfe0b-1234-4abc-8def-0123456789ab";
const ENV: EditApiEnv = { GH_DISPATCH_TOKEN: "gh", ACCESS_TEAM_DOMAIN: "team", OWNER_EMAIL: "o@x.y" };

async function main(): Promise<void> {
  // 1) 본문 검사
  assert(validatePublishBody({ jobId: JOB, channel: "tistory" }).ok, "정상 본문");
  assert(!validatePublishBody({ jobId: "nope", channel: "tistory" }).ok, "jobId 검사");
  assert(!validatePublishBody({ jobId: JOB, channel: "naver" }).ok, "지원하지 않는 채널 거절");
  console.log("✅ 본문 검사");

  const req = (over: Partial<{ method: string; origin: string; cookie: string; body: string }> = {}) =>
    new Request("https://pages.example/api/publish-request", {
      method: over.method ?? "POST",
      headers: { origin: over.origin ?? "https://pages.example", cookie: over.cookie ?? "", "content-type": "application/json" },
      body: over.method === "GET" ? undefined : (over.body ?? JSON.stringify({ jobId: JOB, channel: "tistory" })),
    });

  // 2) 설정 없음 503 / 메서드 405 / 출처 403 / 토큰 없음 401
  assert((await handlePublishRequest(req(), {})).status === 503, "미설정 503");
  assert((await handlePublishRequest(req({ method: "GET" }), ENV)).status === 405, "GET 405");
  assert((await handlePublishRequest(req({ origin: "https://evil.example" }), ENV)).status === 403, "다른 출처 403");
  assert((await handlePublishRequest(req(), ENV)).status === 401, "토큰 없음 401");
  console.log("✅ 거절 코드 - 503/405/403/401");

  // 3) 인증을 통과했다고 치고 dispatch payload 모양만 본다(verifyAccessToken은 editApi 테스트가 검증) - 잘못된 토큰은 403
  const bad = await handlePublishRequest(req({ cookie: "CF_Authorization=not.a.jwt" }), ENV, async () => new Response("[]"));
  assert(bad.status === 403, `깨진 토큰은 403 (${bad.status})`);
  console.log("✅ 깨진 토큰 403");

  console.log("\n✅ testPublishApi 전체 통과");
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
