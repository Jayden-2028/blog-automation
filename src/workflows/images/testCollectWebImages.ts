// collectWebImages 테스트. Codex 실행과 다운로드를 전부 주입해 슬롯 추출·프롬프트·검증만 본다.
// 외부 호출 없음(Codex도 네트워크도 부르지 않는다).

import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { buildPrompt, buildWebImageSlots, collectWebImages } from "./collectWebImages.js";
import type { VerifyImageInput } from "./collectWebImages.js";
import { extractTrailingJson } from "../../services/llm/runHeadlessCodex.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const BODY = [
  "카페 픽업대 앞에 줄이 늘어섰습니다. 사장은 음료 제공을 거부했습니다.",
  "[IMAGE: 카페 픽업대에 놓인 테이크아웃 음료 사진 — 웹 검색]",
  "**법은 무엇을 정하고 있나**\n산업안전보건법 제41조는 고객응대근로자 보호 조치를 사업주 의무로 정합니다.",
  "[IMAGE: 국가법령정보센터 산업안전보건법 제41조 화면 — 웹 검색]",
  "[IMAGE: 종이컵에서 김이 나는 커피 일러스트 — AI 생성]",
  "마무리 문단입니다.",
].join("\n\n");

const PROMPTS = [
  "카페 테이크아웃 음료 픽업대",
  "국가법령정보센터 산업안전보건법 41조",
  "A warm flat illustration of a paper coffee cup, no text. 16:9.",
];

const PNG_1200 = (() => {
  // 1200×100 PNG 헤더만 흉내 낸다(readImageSize는 IHDR만 읽는다).
  const buffer = Buffer.alloc(24);
  buffer.write("\x89PNG\r\n\x1a\n", 0, "binary");
  buffer.writeUInt32BE(1200, 16);
  buffer.writeUInt32BE(100, 20);
  return buffer;
})();

const PNG_300 = (() => {
  const buffer = Buffer.from(PNG_1200);
  buffer.writeUInt32BE(300, 16);
  return buffer;
})();

const codexReply = (slots: unknown[]) => async () => ({ ok: true as const, data: { slots }, durationMs: 1 });

const slotReply = (over: Record<string, unknown> = {}) => ({
  index: 1,
  imageUrl: "https://example.com/a.png",
  sourcePage: "https://example.com/article",
  alt: "카페 픽업대 사진",
  caption: "픽업대에 놓인 음료",
  license: "공공저작물",
  reusePermission: "public_nuri",
  rationale: "문단이 말하는 픽업대 상황을 보여준다",
  skipped: false,
  skipReason: "",
  ...over,
});

const okFetch = async () => ({ ok: true as const, buffer: PNG_1200, contentType: "image/png" });

/** 비전 검증 기본 스텁. 실제 Claude를 부르지 않는다 - 검증 자체를 보는 케이스만 따로 주입한다. */
const okVerify = async () => ({ ok: true, reason: "" });

async function main(): Promise<void> {
  console.log("▶ collectWebImages 테스트 시작\n");

  // 1) 웹 검색 자리만 뽑고, index는 전체 마커 기준이며, 바로 위 문단이 맥락으로 붙는다.
  const slots = buildWebImageSlots(BODY, PROMPTS);
  assert(slots.length === 2, `웹 검색 자리 2개여야 한다 (${slots.length})`);
  assert(slots[0].index === 1 && slots[1].index === 2, "index는 전체 마커 순서여야 한다");
  assert(slots[0].context.includes("픽업대 앞에 줄이"), "바로 위 문단이 맥락으로 붙어야 한다");
  assert(slots[1].context.includes("제41조는 고객응대근로자"), "소제목 블록도 맥락이 돼야 한다");
  assert(slots[1].query === PROMPTS[1], "원고가 제안한 검색어가 넘어가야 한다");
  assert(!slots.some((s) => s.description.includes("AI 생성")), "AI 생성 자리는 빠져야 한다");
  console.log("✅ 웹 검색 자리만 추출 + 전체 마커 기준 index + 바로 위 문단 맥락");

  // 2) 프롬프트에 판단 기준과 자리별 맥락이 실린다.
  const prompt = buildPrompt("남양주 카페 갑질", slots);
  assert(prompt.includes("바로 위 문단을 한 장으로 요약"), "§8-1 판단 기준이 실려야 한다");
  assert(prompt.includes("이미지를 만들지 않는다"), "생성이 아니라 검색이라는 점을 못박아야 한다");
  assert(prompt.includes("픽업대 앞에 줄이"), "자리별 문단 원문이 실려야 한다");
  assert(prompt.includes("자리 1") && prompt.includes("자리 2"), "자리 번호가 실려야 한다");
  console.log("✅ 프롬프트 - 검색 기준 + 저작권 우선순위 + 자리별 문단");

  const dir = await mkdtemp(resolve(tmpdir(), "collect-web-images-"));
  try {
    // 3) 정상 경로: 파일과 사이드카(web-images.json)가 쓰인다.
    const ok = await collectWebImages(
      { keyword: "남양주 카페 갑질", dir, slots: [slots[0]] },
      { verifyImage: okVerify, runCodex: codexReply([slotReply()]), fetchImage: okFetch }
    );
    assert(ok.found.length === 1 && ok.failures.length === 0, `1장 찾아야 한다 (${JSON.stringify(ok.failures)})`);
    assert(ok.found[0].fileName.startsWith("01-"), `파일명이 자리 번호로 시작해야 한다 (${ok.found[0].fileName})`);
    assert(ok.found[0].fileName.endsWith(".png"), "content-type에서 확장자를 정해야 한다");
    assert(ok.found[0].sourcePage === "https://example.com/article", "출처 페이지가 기록돼야 한다");

    const sidecar = JSON.parse(await readFile(resolve(dir, "web-images.json"), "utf-8"));
    assert(sidecar.images.length === 1 && sidecar.images[0].license === "공공저작물", "사이드카에 출처/라이선스가 남아야 한다");
    await readFile(resolve(dir, ok.found[0].fileName));
    console.log("✅ 정상 경로 - 파일 저장 + web-images.json 사이드카");

    // 4) 이미지가 아닌 것(검색 결과 페이지 HTML 등)은 저장하지 않는다.
    const html = await collectWebImages(
      { keyword: "k", dir, slots: [slots[0]] },
      {
        verifyImage: okVerify,
        runCodex: codexReply([slotReply({ imageUrl: "https://example.com/page" })]),
        fetchImage: async () => ({ ok: true as const, buffer: Buffer.from("<html>"), contentType: "text/html" }),
      }
    );
    assert(html.found.length === 0, "HTML을 이미지로 저장하면 안 된다");
    assert(html.failures[0].includes("이미지가 아닙니다"), `사유가 분명해야 한다 (${html.failures[0]})`);
    console.log("✅ content-type이 이미지가 아니면 거부");

    // 5) 너무 작은 이미지는 거부하고, 애매한 크기는 경고하되 저장한다.
    const small = await collectWebImages(
      { keyword: "k", dir, slots: [slots[0]] },
      { verifyImage: okVerify, runCodex: codexReply([slotReply()]), fetchImage: async () => ({ ok: true as const, buffer: PNG_300, contentType: "image/png" }) }
    );
    assert(small.found.length === 0 && small.failures[0].includes("너무 작습니다"), `300px는 거부해야 한다 (${JSON.stringify(small.failures)})`);
    console.log("✅ 최소 해상도 미달 거부");

    // 5-1) 라이선스가 맞지 않으면 내려받기 전에 거부한다(2026-09-17 실측: CC BY-NC-ND 청사 사진이
    //      그대로 저장됐다 - NC는 광고 블로그에서 위반, ND는 크롭조차 막는다).
    let fetched = 0;
    const countingFetch = async () => {
      fetched += 1;
      return { ok: true as const, buffer: PNG_1200, contentType: "image/png" };
    };
    for (const bad of ["cc_nc_or_nd", "third_party_photo", "marketplace_repost", "unclear", "made_up_value"]) {
      const rejected = await collectWebImages(
        { keyword: "k", dir, slots: [slots[0]] },
        { verifyImage: okVerify, runCodex: codexReply([slotReply({ reusePermission: bad, license: "그럴듯하게 적힌 출처 문장" })]), fetchImage: countingFetch }
      );
      assert(rejected.found.length === 0, `"${bad}"는 거부해야 한다`);
      assert(rejected.failures[0].includes("재사용 권한"), `사유가 재사용 권한이어야 한다 (${rejected.failures[0]})`);
    }
    assert(fetched === 0, "권한에서 걸리면 내려받지도 말아야 한다");

    // 방송사 공식 포스터·스틸은 허용한다(사용자 결정, 2026-09-17).
    const broadcaster = await collectWebImages(
      { keyword: "k", dir, slots: [slots[0]] },
      { verifyImage: okVerify, runCodex: codexReply([slotReply({ reusePermission: "broadcaster_promo", license: "JTBC 배포 공식 포스터" })]), fetchImage: okFetch }
    );
    assert(broadcaster.found.length === 1, `방송사 공식 포스터는 통과해야 한다 (${JSON.stringify(broadcaster.failures)})`);

    console.log("✅ 재사용 권한 분류로 거부/허용(자유 문장이 아니라 enum) + 방송사 공식 포스터 허용");

    // 5-2) 자리 1은 대표 이미지라 가로가 아니면 거부, 나머지 자리는 경고만 하고 저장한다.
    const squareFirst = await collectWebImages(
      { keyword: "k", dir, slots: [slots[0]] },
      { verifyImage: okVerify, runCodex: codexReply([slotReply()]), fetchImage: okFetch, readSize: () => ({ width: 1200, height: 1200 }) }
    );
    assert(squareFirst.found.length === 0, "자리 1이 정사각이면 거부해야 한다");
    assert(squareFirst.failures[0].includes("대표 이미지"), `대표 이미지 사유여야 한다 (${squareFirst.failures[0]})`);

    const squareOther = await collectWebImages(
      { keyword: "k", dir, slots: [slots[1]] },
      { verifyImage: okVerify, runCodex: codexReply([slotReply({ index: slots[1].index })]), fetchImage: okFetch, readSize: () => ({ width: 1200, height: 1200 }) }
    );
    assert(squareOther.found.length === 1, "자리 1이 아니면 정사각이어도 저장한다");
    assert(squareOther.failures.some((f) => f.includes("정사각·세로")), `경고는 남겨야 한다 (${JSON.stringify(squareOther.failures)})`);
    console.log("✅ 비율 검증 - 자리 1은 가로 필수, 나머지는 경고 후 저장");

    // 5-3) 비전 검증(2026-09-17): Codex는 URL만 고르고 이미지를 보지 않아, 대만 OTT 건처럼
    //      alt는 "공식 포스터"인데 실제 파일은 스틸컷인 불일치가 나왔다. 불합격이면 파일까지 지운다.
    const rejected = await collectWebImages(
      { keyword: "k", dir, slots: [slots[0]] },
      {
        runCodex: codexReply([slotReply()]),
        fetchImage: okFetch,
        verifyImage: async () => ({ ok: false, reason: "설명은 포스터인데 실제는 스틸컷입니다" }),
      }
    );
    assert(rejected.found.length === 0, "검증 불합격이면 채택하면 안 된다");
    assert(rejected.failures[0].includes("스틸컷"), `검증 사유가 그대로 전달돼야 한다 (${rejected.failures[0]})`);
    const leftovers = (await readdir(dir)).filter((f) => f.startsWith("01-") && f !== "web-images.json");
    assert(leftovers.length === 0, `불합격 파일은 지워야 한다 (남은 것: ${JSON.stringify(leftovers)})`);

    // 검증자에게 파일 경로·설명·문단이 전달된다(무엇을 보고 판정할지의 근거).
    const seenInputs: VerifyImageInput[] = [];
    await collectWebImages(
      { keyword: "남양주 카페 갑질", dir, slots: [slots[0]] },
      {
        runCodex: codexReply([slotReply()]),
        fetchImage: okFetch,
        verifyImage: async (i) => {
          seenInputs.push(i);
          return { ok: true, reason: "" };
        },
      }
    );
    assert(seenInputs.length === 1, "검증자가 호출돼야 한다");
    const seen = seenInputs[0];
    assert(seen.filePath.includes(dir) && seen.filePath.includes("01-"), "저장된 파일 경로를 넘겨야 한다");
    assert(seen.alt === "카페 픽업대 사진" && seen.context.includes("픽업대 앞에 줄이"), "설명과 문단을 넘겨야 한다");
    assert(seen.keyword === "남양주 카페 갑질", "원고 주제도 넘겨야 한다");

    // verify: false면 검증을 건너뛴다(시간·호출 절약).
    let verifyCalls = 0;
    const skippedVerify = await collectWebImages(
      { keyword: "k", dir, slots: [slots[0]] },
      {
        runCodex: codexReply([slotReply()]),
        fetchImage: okFetch,
        verify: false,
        verifyImage: async () => {
          verifyCalls += 1;
          return { ok: false, reason: "불려선 안 된다" };
        },
      }
    );
    assert(verifyCalls === 0 && skippedVerify.found.length === 1, "verify:false면 검증을 부르지 않고 그대로 채택한다");
    console.log("✅ 비전 검증 - 불합격 시 파일까지 삭제, 근거 전달, --no-verify로 생략");

    // 5-4) 핫링크 차단(2026-09-17 실측: 경복궁 3자리 전부 HTTP 403) 대응. 이미지가 실린 페이지를
    //      Referer로 넘겨야 통과하는 서버가 많다. 실패하면 사람이 직접 받을 수 있게 URL을 남긴다.
    const fetchArgs: { url: string; referer: string }[] = [];
    await collectWebImages(
      { keyword: "k", dir, slots: [slots[0]] },
      {
        verifyImage: okVerify,
        runCodex: codexReply([slotReply()]),
        fetchImage: async (i) => {
          fetchArgs.push(i);
          return { ok: true as const, buffer: PNG_1200, contentType: "image/png" };
        },
      }
    );
    assert(fetchArgs.length === 1, "다운로더가 호출돼야 한다");
    assert(fetchArgs[0].url === "https://example.com/a.png", "이미지 URL을 넘겨야 한다");
    assert(fetchArgs[0].referer === "https://example.com/article", "출처 페이지를 Referer로 넘겨야 한다");

    const blocked = await collectWebImages(
      { keyword: "k", dir, slots: [slots[0]] },
      {
        verifyImage: okVerify,
        runCodex: codexReply([slotReply()]),
        fetchImage: async () => ({ ok: false as const, error: "HTTP 403" }),
      }
    );
    assert(blocked.found.length === 0, "403이면 채택하지 않는다");
    assert(
      blocked.failures[0].includes("https://example.com/a.png") && blocked.failures[0].includes("https://example.com/article"),
      `실패 사유에 이미지·출처 URL이 있어야 사람이 직접 받는다 (${blocked.failures[0]})`
    );
    console.log("✅ 핫링크 차단 대응 - 출처를 Referer로 전달, 실패 시 URL 안내");

    // 6) Codex가 못 찾았다고(skipped) 하면 빈 자리로 남기고 사유를 전한다 - 억지로 채우지 않는다.
    const skipped = await collectWebImages(
      { keyword: "k", dir, slots: [slots[0]] },
      { verifyImage: okVerify, runCodex: codexReply([slotReply({ skipped: true, skipReason: "공식 배포 이미지를 못 찾음", imageUrl: "" })]), fetchImage: okFetch }
    );
    assert(skipped.found.length === 0 && skipped.failures[0].includes("공식 배포 이미지를 못 찾음"), "skip 사유가 전달돼야 한다");
    console.log("✅ Codex가 못 찾은 자리는 빈 자리로 유지");

    // 7) URL이 아닌 값, Codex 실행 실패는 예외 없이 사유로 돌아온다.
    const badUrl = await collectWebImages(
      { keyword: "k", dir, slots: [slots[0]] },
      { verifyImage: okVerify, runCodex: codexReply([slotReply({ imageUrl: "그냥 텍스트" })]), fetchImage: okFetch }
    );
    assert(badUrl.found.length === 0 && badUrl.failures[0].includes("URL 형식"), "URL 검증이 있어야 한다");

    const codexDown = await collectWebImages(
      { keyword: "k", dir, slots: [slots[0]] },
      { verifyImage: okVerify, runCodex: async () => ({ ok: false as const, error: "codex 없음", durationMs: 1 }), fetchImage: okFetch }
    );
    assert(codexDown.found.length === 0 && codexDown.failures[0].includes("codex 없음"), "실행 실패가 사유로 와야 한다");
    console.log("✅ 잘못된 URL / Codex 실행 실패 - 예외 없이 사유 반환");

    // 8) 웹 검색 자리가 없으면 Codex를 아예 부르지 않는다(불필요한 유료 호출 방지).
    let called = 0;
    const none = await collectWebImages(
      { keyword: "k", dir, slots: [] },
      {
        verifyImage: okVerify,
        runCodex: async () => {
          called += 1;
          return { ok: true as const, data: { slots: [] }, durationMs: 1 };
        },
      }
    );
    assert(called === 0 && none.found.length === 0, "자리가 없으면 Codex를 부르면 안 된다");
    console.log("✅ 웹 검색 자리 없음 -> Codex 미호출");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  // 9) codex exec 출력에서 마지막 JSON만 골라낸다(세션 헤더·경고·"tokens used" 잡음 섞임).
  const noisy = [
    "OpenAI Codex v0.149.1",
    "--------",
    "workdir: /repo",
    "ERROR codex_core: failed to load skill ...",
    "codex",
    '{"slots":[{"index":1}]}',
    "tokens used",
    "21,944",
    '{"slots":[{"index":1}]}',
  ].join("\n");
  const parsed = extractTrailingJson(noisy) as { slots: { index: number }[] };
  assert(parsed?.slots?.[0]?.index === 1, `잡음 속에서 JSON을 찾아야 한다 (${JSON.stringify(parsed)})`);
  assert(extractTrailingJson("아무 JSON도 없음") === null, "JSON이 없으면 null이어야 한다");
  console.log("✅ codex 출력 잡음 속 JSON 추출");

  console.log("\n✅ collectWebImages 테스트 전체 통과");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
