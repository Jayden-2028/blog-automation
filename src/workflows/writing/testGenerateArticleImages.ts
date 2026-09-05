// generateArticleImages 테스트. 실제 LLM/이미지 생성/업로드 API를 호출하지 않는다 -
// planBrief/generate/upload 주입 지점으로 대체한다(generateImage.ts/uploadArticleImage.ts
// 자체는 실제 API를 직접 감싸는 얇은 래퍼라 telegraphClient.ts와 같은 이유로 단위 테스트를
// 따로 두지 않고 라이브 검증으로 대신한다).

import { generateArticleImages, pickInsertionPoints } from "./generateArticleImages.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const SAMPLE_BODY = [
  "도입부 문단입니다. 이 글에서 다룰 내용을 짧게 소개합니다.",
  "**첫 번째 섹션**\n첫 번째 섹션의 본문입니다.",
  "**두 번째 섹션**\n두 번째 섹션의 본문입니다.",
  "**세 번째 섹션**\n세 번째 섹션의 본문입니다.",
  "**참고 자료**\n- [출처](https://example.com)",
].join("\n\n");

function makeInput(overrides: Partial<Parameters<typeof generateArticleImages>[0]> = {}) {
  return {
    jobId: "job-1",
    title: "테스트 원고",
    keyword: "테스트 키워드",
    category: "living",
    body: SAMPLE_BODY,
    ...overrides,
  };
}

const okBrief = (label: string) =>
  Promise.resolve({
    ok: true as const,
    brief: { scene: `${label} 장면`, prompt: `${label} prompt`, altText: `${label} alt`, prohibited: "실존 인물" },
    durationMs: 10,
  });

const okImage = () =>
  Promise.resolve({ ok: true as const, imageBuffer: Buffer.from("fake"), mimeType: "image/png", provider: "openai" as const });

const okUpload = (index: number) =>
  Promise.resolve({ ok: true as const, url: `https://storage.example.com/job-1/${index}.png`, path: `job-1/${index}.png` });

async function main(): Promise<void> {
  console.log("▶ generateArticleImages 테스트 시작\n");

  // 1) 삽입 지점 선택: 첫 지점은 항상 도입부, 나머지는 "## " 소제목(참고 자료 제외)에서 앞쪽부터.
  const points3 = pickInsertionPoints(SAMPLE_BODY, 3);
  assert(points3.length === 3, `3장 요청 시 3개 지점이어야 한다 (실제: ${points3.length})`);
  assert(points3[0].insertAfterHeading === null, "첫 지점은 도입부(null)여야 한다");
  assert(points3[1].insertAfterHeading === "**첫 번째 섹션**", `둘째 지점 실패 (실제: ${points3[1].insertAfterHeading})`);
  assert(points3[2].insertAfterHeading === "**두 번째 섹션**", `셋째 지점 실패 (실제: ${points3[2].insertAfterHeading})`);
  assert(
    points3.every((p) => p.insertAfterHeading !== "**참고 자료**"),
    "참고 자료 섹션은 삽입 지점에서 제외돼야 한다"
  );
  console.log("✅ 삽입 지점: 도입부 + 앞쪽 소제목 순, 참고 자료 제외");

  // 2) maxImages=1이면 도입부 하나만.
  const points1 = pickInsertionPoints(SAMPLE_BODY, 1);
  assert(points1.length === 1 && points1[0].insertAfterHeading === null, "1장 요청 시 도입부만 있어야 한다");
  console.log("✅ maxImages=1 -> 도입부만");

  // 3) 소제목보다 많이 요청해도 있는 만큼만 돌려준다(실패가 아니다).
  const points10 = pickInsertionPoints(SAMPLE_BODY, 10);
  assert(points10.length === 4, `실제 소제목 수(3, 참고자료 제외)+도입부만큼만이어야 한다 (실제: ${points10.length})`);
  console.log("✅ 요청 개수가 실제 소제목보다 많아도 있는 만큼만 반환(실패 아님)");

  // 4) 전체 흐름: 성공한 이미지는 본문에 마크다운으로 삽입되고 images 배열에 담긴다.
  const result = await generateArticleImages(makeInput(), {
    planBrief: (input) => okBrief(input.sectionHint ?? "?"),
    generate: () => okImage(),
    upload: (input) => okUpload(input.index),
  });
  assert(result.images.length === 3, `이미지 3장이 생성돼야 한다 (실제: ${result.images.length})`);
  assert(result.failures.length === 0, `실패가 없어야 한다 (실제: ${JSON.stringify(result.failures)})`);
  assert(result.body.includes("![도입부(대표 이미지) alt](https://storage.example.com/job-1/1.png)"), "도입부 이미지가 본문에 삽입돼야 한다");
  assert(result.body.includes("job-1/2.png"), "둘째 이미지가 본문에 삽입돼야 한다");
  assert(result.body.includes("job-1/3.png"), "셋째 이미지가 본문에 삽입돼야 한다");
  console.log("✅ 성공한 이미지 3장이 본문에 마크다운으로 삽입됨");

  // 5) 삽입 위치 검증: 도입부 이미지는 첫 문단 바로 뒤, 섹션 이미지는 해당 소제목 블록 바로 뒤에 와야 한다.
  const blocks = result.body.split(/\n{2,}/);
  assert(blocks[0] === "도입부 문단입니다. 이 글에서 다룰 내용을 짧게 소개합니다.", "0번째 블록은 원래 도입부여야 한다");
  assert(blocks[1].startsWith("!["), "1번째 블록(도입부 뒤)이 이미지여야 한다");
  const firstHeadingIdx = blocks.findIndex((b) => b.startsWith("**첫 번째 섹션**"));
  assert(firstHeadingIdx !== -1, "'**첫 번째 섹션**' 블록을 찾아야 한다");
  assert(blocks[firstHeadingIdx + 1].startsWith("!["), "'**첫 번째 섹션**' 바로 뒤가 이미지여야 한다");
  console.log("✅ 이미지가 정확한 위치(도입부 뒤 / 각 소제목 뒤)에 삽입됨");

  // 6) copyright_status는 provider를 반영한 "ai-generated:<provider>" 형식이어야 한다.
  assert(
    result.images.every((img) => img.copyrightStatus === "ai-generated:openai"),
    `copyright_status가 provider를 반영해야 한다 (실제: ${JSON.stringify(result.images.map((i) => i.copyrightStatus))})`
  );
  console.log("✅ copyright_status가 'ai-generated:<provider>' 형식으로 기록됨");

  // 7) best-effort: 일부 지점이 실패해도 나머지는 계속 생성되고, 실패 사유가 남는다.
  let call = 0;
  const partial = await generateArticleImages(makeInput(), {
    planBrief: (input) => {
      call += 1;
      if (call === 2) return Promise.resolve({ ok: false as const, error: "브리프 생성 실패(테스트)", durationMs: 5 });
      return okBrief(input.sectionHint ?? "?");
    },
    generate: () => okImage(),
    upload: (input) => okUpload(input.index),
  });
  assert(partial.images.length === 2, `실패 1건을 빼고 2장은 성공해야 한다 (실제: ${partial.images.length})`);
  assert(partial.failures.length === 1, `실패 1건이 기록돼야 한다 (실제: ${partial.failures.length})`);
  assert(partial.failures[0].includes("브리프 생성 실패"), "실패 사유가 그대로 남아야 한다");
  console.log("✅ 일부 실패해도 나머지는 계속 생성됨(best-effort)");

  // 8) 이미지 생성/업로드 실패도 같은 방식으로 처리된다.
  const genFailed = await generateArticleImages(makeInput({ maxImages: 1 }), {
    planBrief: (input) => okBrief(input.sectionHint ?? "?"),
    generate: () => Promise.resolve({ ok: false as const, error: "이미지 생성 실패(테스트)" }),
    upload: (input) => okUpload(input.index),
  });
  assert(genFailed.images.length === 0 && genFailed.failures.length === 1, "이미지 생성 실패도 failures에 기록돼야 한다");
  assert(genFailed.body === SAMPLE_BODY, "실패하면 본문이 원본 그대로 유지돼야 한다");
  console.log("✅ 이미지 생성 실패 시 본문 원본 유지 + failures 기록");

  // 9) maxImages=0이면 아무것도 생성하지 않는다(호출 없이 즉시 반환).
  let called = false;
  const zero = await generateArticleImages(makeInput({ maxImages: 0 }), {
    planBrief: () => {
      called = true;
      return okBrief("x");
    },
  });
  assert(!called, "maxImages=0이면 브리프 생성을 호출하면 안 된다");
  assert(zero.images.length === 0 && zero.body === SAMPLE_BODY, "maxImages=0이면 원본 그대로여야 한다");
  console.log("✅ maxImages=0 -> 호출 없이 원본 유지");

  console.log("\n✅ generateArticleImages 테스트 완료");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
