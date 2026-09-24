// 검증자가 다시 쓴 캡션이 **끝까지 전달되는지** 고정한다(2026-09-24).
//
// 왜 별도 테스트인가: 같은 모양의 결함을 하루에 세 번 반복했다 - 값을 만들어 놓고 읽는 쪽을
// 배선하지 않는 것. 이 캡션도 chooseImage가 돌려주게 해 놓고 collectWebImagesForJob이
// `record.alt`(마커 설명)만 쓰고 있어서, 재수집을 돌려도 캡션이 그대로였다.
//
// 그래서 **manifest까지 도달하는지**를 본다. 중간 함수 하나만 테스트하면 또 놓친다.
import { collectWebImagesForJob } from "./collectWebImagesForJob.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const BODY = [
  "**소제목**",
  "문단입니다.",
  "",
  "[IMAGE: 예고편 명대사 장면 — 웹 검색]",
  "[IMAGE PROMPT: 연애박사 예고편]",
].join("\n");

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

async function main(): Promise<void> {
  console.log("▶ 캡션 배선 테스트 시작\n");

  const result = await collectWebImagesForJob(
    { jobId: "test-job", keyword: "연애박사", category: "ott", body: BODY, imagePrompts: ["연애박사 예고편"] },
    {
      searchImages: false,
      searchKinolights: false,
      cropTall: false,
      deduper: undefined,
      runCodex: async () => ({
        ok: true as const,
        durationMs: 0,
        data: {
          slots: [
            {
              index: 1,
              imageUrl: "https://example.com/a.png",
              sourcePage: "https://example.com",
              alt: "수집기가 URL만 보고 쓴 추측",
              caption: "수집기 캡션",
              license: "테스트",
              reusePermission: "official_company",
              rationale: "",
              skipped: false,
              skipReason: "",
              alternates: [],
            },
          ],
        },
      }),
      fetchImage: async () => ({ ok: true, buffer: PNG, contentType: "image/png" }),
      readSize: () => ({ width: 1600, height: 900 }),
      // 검증자가 **사진을 보고** 캡션을 다시 쓴다.
      chooseImage: async () => ({ picked: 1, reason: "맞다", caption: "버스정류장에 나란히 앉은 추영우와 김소현" }),
      upload: async ({ fileName }) => ({ ok: true as const, url: `https://storage/${fileName}` }),
    }
  );

  assert(result.images.length === 1, `이미지 1장이 나와야 한다 (${result.images.length}장)`);
  const image = result.images[0];
  assert(
    image.description === "버스정류장에 나란히 앉은 추영우와 김소현",
    `검증자 캡션이 manifest까지 와야 한다 (받은 값: "${image.description}")`
  );
  assert(!image.description.includes("명대사"), "마커 설명이 그대로 남으면 안 된다");
  console.log("✅ 검증자가 다시 쓴 캡션이 manifest까지 전달된다");

  // 캡션을 안 주면 마커 설명으로 떨어진다(예전 동작 유지).
  const fallback = await collectWebImagesForJob(
    { jobId: "test-job", keyword: "연애박사", category: "ott", body: BODY, imagePrompts: ["연애박사 예고편"] },
    {
      searchImages: false,
      searchKinolights: false,
      cropTall: false,
      runCodex: async () => ({
        ok: true as const,
        durationMs: 0,
        data: {
          slots: [
            {
              index: 1,
              imageUrl: "https://example.com/a.png",
              sourcePage: "https://example.com",
              alt: "추측",
              caption: "",
              license: "테스트",
              reusePermission: "official_company",
              rationale: "",
              skipped: false,
              skipReason: "",
              alternates: [],
            },
          ],
        },
      }),
      fetchImage: async () => ({ ok: true, buffer: PNG, contentType: "image/png" }),
      readSize: () => ({ width: 1600, height: 900 }),
      chooseImage: async () => ({ picked: 1, reason: "맞다" }), // caption 없음
      upload: async ({ fileName }) => ({ ok: true as const, url: `https://storage/${fileName}` }),
    }
  );
  assert(
    fallback.images[0]?.description.includes("명대사"),
    `캡션이 없으면 마커 설명으로 떨어져야 한다 (받은 값: "${fallback.images[0]?.description}")`
  );
  console.log("✅ 캡션이 없으면 마커 설명으로 폴백");

  // 3) 주소를 직접 찍어 준 자리는 요구사항이 캡션이 되면 안 된다(2026-09-24 실측).
  //    "이미지 교체 https://www.sentv.co.kr/..."가 그대로 캡션으로 나갔다.
  {
    const direct = await collectWebImagesForJob(
      {
        jobId: "test-job",
        keyword: "오상욱",
        category: "living",
        body: "문단\n\n[IMAGE: 중계 안내 페이지 — 페이지 캡처]\n[IMAGE PROMPT: https://example.com]",
        imagePrompts: ["https://example.com"],
        requirements: { "1": "이미지 교체 https://cdn.example.com/a.jpg" },
        directUrls: { "1": "https://cdn.example.com/a.jpg" },
      },
      {
        searchImages: false,
        searchKinolights: false,
        cropTall: false,
        fetchImage: async () => ({ ok: true, buffer: PNG, contentType: "image/png" }),
        readSize: () => ({ width: 800, height: 800 }),
        upload: async ({ fileName }) => ({ ok: true as const, url: `https://storage/${fileName}` }),
      }
    );

    assert(direct.images.length === 1, `직접 지정 자리가 채워져야 한다 (${direct.images.length})`);
    const caption = direct.images[0].description;
    assert(!caption.includes("http"), `캡션에 URL이 들어가면 안 된다: "${caption}"`);
    assert(!caption.includes("이미지 교체"), `요구사항 문구가 캡션이 되면 안 된다: "${caption}"`);
    assert(caption.includes("중계 안내"), `마커 설명이 남아야 한다: "${caption}"`);
    console.log("✅ 직접 지정 자리는 요구사항이 아니라 마커 설명을 캡션으로 쓴다");
  }

  console.log("\n🎉 캡션 배선 테스트 통과");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
