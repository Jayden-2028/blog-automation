// BingWebmasterClient 테스트 - fetch 주입, 네트워크 호출 없음.
import { BingWebmasterClient, resolveBingSiteUrl } from "./BingWebmasterClient.js";
import type { BingFetch } from "./BingWebmasterClient.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const reply = (status: number, body: string): BingFetch => async () => ({ ok: status >= 200 && status < 300, status, text: async () => body });
const quiet = () => {};

async function main(): Promise<void> {
  const site = "https://tkm.example.com/";

  // 키 없음 -> skipped, fetch 호출 없음
  let called = 0;
  const noKey = new BingWebmasterClient({ apiKey: "", fetchImpl: async () => { called += 1; return reply(200, "{}")("x"); }, log: quiet });
  assert(JSON.stringify(await noKey.submitUrls(site, ["https://tkm.example.com/a"])) === '{"skipped":"no-key"}', "키 없음 -> skipped:no-key");
  assert(JSON.stringify(await noKey.getQuota(site)) === '{"skipped":"no-key"}', "키 없음 할당량 -> skipped");
  assert(called === 0, "키 없으면 fetch를 부르지 않는다");
  console.log("✅ 키 없음 -> 조용히 건너뜀");

  // 200 -> ok, 요청 모양
  let seen: { url: string; body: string; method?: string } | null = null;
  const ok = new BingWebmasterClient({
    apiKey: "k3y",
    log: quiet,
    fetchImpl: async (url, init) => { seen = { url, body: init?.body ?? "", method: init?.method }; return reply(200, '{"d":null}')(url); },
  });
  const sent = await ok.submitUrls(site, ["https://tkm.example.com/a", "https://tkm.example.com/a", "https://tkm.example.com/p/all-guides.html"]);
  assert("ok" in sent && sent.ok && sent.submitted === 2, `200 -> ok, 중복 제거 (${JSON.stringify(sent)})`);
  assert(seen !== null && (seen as { url: string }).url.includes("/SubmitUrlBatch?apikey=k3y") && (seen as { method: string }).method === "POST", "SubmitUrlBatch POST");
  assert(JSON.parse((seen as unknown as { body: string }).body).siteUrl === site, "body.siteUrl");
  console.log("✅ 200 -> ok");

  // 4xx / 5xx / 네트워크 오류 -> ok:false, 예외 없음, 오류 문구에 키 없음
  for (const [label, client] of [
    ["400", new BingWebmasterClient({ apiKey: "k3y", log: quiet, fetchImpl: reply(400, '{"ErrorCode":3,"Message":"ERROR!!! Quota exceeded"}') })],
    ["500", new BingWebmasterClient({ apiKey: "k3y", log: quiet, fetchImpl: reply(500, "boom") })],
    ["network", new BingWebmasterClient({ apiKey: "k3y", log: quiet, fetchImpl: async () => { throw new Error("ECONNRESET k3y"); } })],
  ] as const) {
    const result = await client.submitUrls(site, ["https://tkm.example.com/a"]);
    assert("ok" in result && result.ok === false && result.error.length > 0, `${label} -> ok:false (${JSON.stringify(result)})`);
  }
  const bad = await new BingWebmasterClient({ apiKey: "k3y", log: quiet, fetchImpl: reply(400, '{"Message":"Quota exceeded"}') }).submitUrls(site, ["https://tkm.example.com/a"]);
  assert("error" in bad && bad.error.includes("Quota exceeded") && "status" in bad && bad.status === 400, "400 메시지·상태 보존");
  console.log("✅ 4xx/5xx/네트워크 오류 -> ok:false, 예외 없음");

  // 할당량
  const quota = await new BingWebmasterClient({ apiKey: "k3y", log: quiet, fetchImpl: reply(200, '{"d":{"DailyQuota":60,"MonthlyQuota":460}}') }).getQuota(site);
  assert("ok" in quota && quota.ok && quota.dailyQuota === 60 && quota.monthlyQuota === 460, "할당량 파싱");
  const badQuota = await new BingWebmasterClient({ apiKey: "k3y", log: quiet, fetchImpl: reply(200, "{}") }).getQuota(site);
  assert("ok" in badQuota && badQuota.ok === false, "형식 불일치 -> ok:false");
  console.log("✅ 할당량 조회");

  // siteUrl 해석
  assert(resolveBingSiteUrl("https://a.blogspot.com/2026/10/x.html", undefined) === "https://a.blogspot.com/", "글 URL origin");
  assert(resolveBingSiteUrl("https://a.blogspot.com/x.html", "https://custom.example.com") === "https://custom.example.com/", "BING_SITE_URL 우선");
  assert(resolveBingSiteUrl("https://a.blogspot.com/x.html", "not a url") === "https://a.blogspot.com/", "잘못된 env는 무시");
  assert(resolveBingSiteUrl("https://thekoreamanual.blogspot.com/2026/10/x.html", undefined) === "https://www.koreaplain.com/", "TKM 옛 주소는 공개 주소로(2026-10-28)");
  assert(resolveBingSiteUrl("http://www.koreaplain.com/2026/10/x.html", undefined) === "https://www.koreaplain.com/", "http 새 주소도 https 사이트로");
  assert(resolveBingSiteUrl(null, undefined) === null, "후보 없음 -> null");
  console.log("✅ siteUrl 해석");

  console.log("\n✅ 전체 테스트 통과");
}

main().catch((e) => { console.error(e); process.exit(1); });
