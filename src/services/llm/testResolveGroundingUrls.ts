// resolveGroundingUrls 테스트. fetch를 주입하므로 네트워크를 쓰지 않는다.
//
// 2026-10-30 회귀의 본체: grounding URL은 `vertexaisearch.cloud.google.com/grounding-api-redirect/...`
// 리디렉션이고 조사 파일 본문의 `· 출처:`는 실제 주소다. 리디렉션을 풀지 않으면 둘이 영영 일치하지
// 않아 grounding된 공식 출처까지 전부 강등된다.

import { hostOf, isGroundingRedirect, normalizeUrl, resolveGroundingUrls } from "./resolveGroundingUrls.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const REDIRECT_A = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQF6Tgv";
const REDIRECT_B = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQF7Hwy";
const FINAL_A = "https://www.korea.kr/news/policyNewsView.do?newsId=148914101";

// 1) 리디렉션 판별
assert(isGroundingRedirect(REDIRECT_A), "vertexaisearch 리디렉션을 인식해야 한다");
assert(!isGroundingRedirect(FINAL_A), "실제 주소를 리디렉션으로 보면 안 된다");

// 2) 정규화: www·트레일링 슬래시·해시·추적 파라미터
assert(
  normalizeUrl("https://www.korea.kr/news/a/?utm_source=x#frag") === "https://korea.kr/news/a",
  `정규화 실패: ${normalizeUrl("https://www.korea.kr/news/a/?utm_source=x#frag")}`
);
assert(normalizeUrl("https://korea.kr/news/a.") === "https://korea.kr/news/a", "문장 끝 마침표를 떼야 한다");
assert(hostOf("https://WWW.Korea.KR/news/a") === "korea.kr", "호스트는 소문자·www 제거다");

// 3) 리디렉션을 풀어 최종 주소를 넣는다
{
  const fetchImpl = (async (url: string | URL) => {
    assert(String(url) === REDIRECT_A, "리디렉션 주소로 요청해야 한다");
    return { url: FINAL_A } as Response;
  }) as unknown as typeof fetch;

  const resolved = await resolveGroundingUrls([{ title: "korea.kr", url: REDIRECT_A }], { fetchImpl });
  assert(resolved.urls.has(normalizeUrl(FINAL_A)), "최종 주소가 허용 목록에 있어야 한다");
  assert(!resolved.urls.has(REDIRECT_A), "리디렉션 주소는 남기지 않는다");
  assert(resolved.domains.has("korea.kr"), "최종 주소의 도메인도 담는다");
  assert(resolved.resolvedCount === 1 && resolved.unresolvedCount === 0, "해결 1건이어야 한다");
}

// 4) 못 풀면 web.title의 도메인만 남긴다
{
  const fetchImpl = (async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;

  const resolved = await resolveGroundingUrls([{ title: "nongsaro.go.kr", url: REDIRECT_B }], { fetchImpl });
  assert(resolved.urls.size === 0, "못 푼 출처의 URL은 인정하지 않는다");
  assert(resolved.domains.has("nongsaro.go.kr"), "title의 도메인은 남긴다");
  assert(resolved.unresolvedCount === 1, "미해결 1건이어야 한다");
}

// 5) 리디렉션이 아닌 baseline 주소는 그대로 통과
{
  let called = 0;
  const fetchImpl = (async () => {
    called++;
    return { url: FINAL_A } as Response;
  }) as unknown as typeof fetch;

  const resolved = await resolveGroundingUrls([{ title: null, url: "https://example.com/a" }], { fetchImpl });
  assert(called === 0, "리디렉션이 아니면 네트워크를 쓰지 않는다");
  assert(resolved.urls.has("https://example.com/a"), "원래 주소를 그대로 인정한다");
}

// 6) HEAD가 막히면 GET으로 한 번 더 시도한다
{
  const methods: string[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    methods.push(String(init?.method));
    if (init?.method === "HEAD") throw new Error("405");
    return { url: FINAL_A } as Response;
  }) as unknown as typeof fetch;

  const resolved = await resolveGroundingUrls([{ title: null, url: REDIRECT_A }], { fetchImpl });
  assert(methods.join(",") === "HEAD,GET", `HEAD 후 GET이어야 한다: ${methods.join(",")}`);
  assert(resolved.urls.has(normalizeUrl(FINAL_A)), "GET 결과로 최종 주소를 얻어야 한다");
}

console.log("✅ resolveGroundingUrls: 리디렉션 해제·도메인 폴백·정규화 통과");
