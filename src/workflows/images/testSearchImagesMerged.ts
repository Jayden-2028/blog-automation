// 두 색인 합치기 테스트. 실행: npm run test:merged-search
//
// 지켜야 할 것: ① 한쪽이 죽어도 수집이 멈추지 않는다 ② 한 색인이 앞쪽을 독점하지 않는다
// (에이전트는 프롬프트 앞쪽부터 보므로, 몰아 넣으면 두 번째 색인을 붙인 의미가 사라진다).
import { interleave } from "./searchImagesMerged.js";
import { searchSerperImages } from "./searchSerperImages.js";
import type { ImageCandidate } from "./searchNaverImages.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const c = (link: string, sourcePage: string | null = null): ImageCandidate => ({
  title: link, link, thumbnail: "", width: 800, height: 600, sourcePage,
});

// --- 1. 번갈아 끼운다 - 한 색인이 앞쪽을 독점하지 않는다 ---------------------------------------
{
  const merged = interleave([c("n1"), c("n2"), c("n3")], [c("g1"), c("g2")]);
  assert(JSON.stringify(merged.map((x) => x.link)) === JSON.stringify(["n1", "g1", "n2", "g2", "n3"]), JSON.stringify(merged.map((x) => x.link)));
  // 상위 4장 안에 두 색인이 모두 들어간다(프롬프트에 잘려 실려도 양쪽이 보인다).
  const top4 = merged.slice(0, 4).map((x) => x.link);
  assert(top4.some((l) => l.startsWith("n")) && top4.some((l) => l.startsWith("g")), "상위권에 두 색인이 다 있어야 한다");
  console.log("✅ 번갈아 끼우기 - 상위권을 한 색인이 독점하지 않는다");
}

// --- 2. 한쪽이 비어도 나머지를 그대로 쓴다 -----------------------------------------------------
{
  assert(interleave([c("n1"), c("n2")], []).map((x) => x.link).join() === "n1,n2", "구글이 비면 네이버만");
  assert(interleave([], [c("g1")]).map((x) => x.link).join() === "g1", "네이버가 비면 구글만");
  assert(interleave([], []).length === 0, "둘 다 비면 빈 배열");
  console.log("✅ 한쪽이 비어도 나머지로 간다");
}

// --- 3. 같은 이미지는 한 번만 --------------------------------------------------------------------
{
  const merged = interleave([c("https://x/a.jpg")], [c("https://x/a.jpg?w=100")]);
  assert(merged.length === 1, `중복이 남았다 (${merged.length})`);
  console.log("✅ 쿼리스트링만 다른 같은 이미지는 한 번만");
}

// --- 4. 출처 페이지가 보존된다(인물 확인의 근거라 잃으면 안 된다) -------------------------------
{
  const merged = interleave([c("n1")], [c("g1", "https://news.example.com/article/1")]);
  assert(merged.find((x) => x.link === "g1")?.sourcePage === "https://news.example.com/article/1", "구글의 출처가 살아야 한다");
  console.log("✅ 출처 페이지 보존");
}

// --- 5. 키가 없으면 조용히 빈 배열 - 호출도 하지 않는다 ------------------------------------------
{
  const savedKey = process.env.SERPER_API_KEY;
  delete process.env.SERPER_API_KEY;
  let called = false;
  const out = await searchSerperImages("테스트", { fetchImpl: (async () => { called = true; return new Response("{}"); }) as typeof fetch });
  assert(out.length === 0 && !called, "키가 없으면 호출 없이 빈 배열");
  if (savedKey) process.env.SERPER_API_KEY = savedKey;
  console.log("✅ 키 미설정 - 호출 없이 빈 배열(네이버만으로 계속 돈다)");
}

// --- 6. 한도 초과(429)도 수집을 멈추지 않는다 ---------------------------------------------------
{
  process.env.SERPER_API_KEY = "test-key";
  const out = await searchSerperImages("테스트", {
    fetchImpl: (async () => new Response("{}", { status: 429 })) as typeof fetch,
  });
  assert(out.length === 0, "429면 빈 배열 - 예외를 던지지 않는다");
  delete process.env.SERPER_API_KEY;
  console.log("✅ 한도 초과(429) - 예외 없이 빈 배열");
}

// --- 7. 응답 필드 매핑 --------------------------------------------------------------------------
// Serper는 사진 자체를 `imageUrl`, 그 사진이 실린 페이지를 `link`로 준다. 둘을 바꿔 읽으면
// 기사 페이지를 이미지로 내려받으려다 자리가 통째로 빈다 - 갈아끼울 때 가장 틀리기 쉬운 곳이다.
{
  process.env.SERPER_API_KEY = "test-key";
  const body = JSON.stringify({
    images: [
      {
        title: "사진 제목",
        imageUrl: "https://img.example.com/photo.jpg",
        imageWidth: 1200,
        imageHeight: 800,
        thumbnailUrl: "https://img.example.com/thumb.jpg",
        link: "https://news.example.com/article/1",
      },
      { title: "주소 없는 항목" },
    ],
  });
  const out = await searchSerperImages("테스트", {
    fetchImpl: (async () => new Response(body)) as typeof fetch,
  });
  assert(out.length === 1, `imageUrl 없는 항목은 버려야 한다 (${out.length})`);
  assert(out[0].link === "https://img.example.com/photo.jpg", `사진 주소가 틀렸다: ${out[0].link}`);
  assert(out[0].sourcePage === "https://news.example.com/article/1", `출처 페이지가 틀렸다: ${out[0].sourcePage}`);
  assert(out[0].width === 1200 && out[0].height === 800, "크기가 보존돼야 한다(최소 크기 검증이 쓴다)");
  delete process.env.SERPER_API_KEY;
  console.log("✅ 응답 매핑 - 사진은 imageUrl, 출처는 link");
}

console.log("\n🎉 두 색인 합치기 테스트 통과");
