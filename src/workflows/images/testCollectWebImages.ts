// collectWebImages 테스트. Codex 실행과 다운로드를 전부 주입해 슬롯 추출·프롬프트·검증만 본다.
// 외부 호출 없음(Codex도 네트워크도 부르지 않는다).

import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { buildPrompt, buildWebImageSlots, collectWebImages } from "./collectWebImages.js";
import type { ChooseImageInput } from "./collectWebImages.js";
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
  alternates: [] as { imageUrl: string; sourcePage: string; license: string }[],
  ...over,
});

const okFetch = async () => ({ ok: true as const, buffer: PNG_1200, contentType: "image/png" });

/** 비전 검증 기본 스텁. 실제 Claude를 부르지 않는다 - 검증 자체를 보는 케이스만 따로 주입한다. */
/** 첫 후보를 고르는 기본 판정자. 후보 비교 로직 자체는 별도 블록에서 본다. */
const okVerify = async (i: ChooseImageInput) => ({ picked: i.candidates[0]?.number ?? null, reason: "" });

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
      { searchImages: false, chooseImage: okVerify, runCodex: codexReply([slotReply()]), fetchImage: okFetch }
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
        searchImages: false,
        chooseImage: okVerify,
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
      { searchImages: false, chooseImage: okVerify, runCodex: codexReply([slotReply()]), fetchImage: async () => ({ ok: true as const, buffer: PNG_300, contentType: "image/png" }) }
    );
    assert(small.found.length === 0 && small.failures[0].includes("너무 작습니다"), `300px는 거부해야 한다 (${JSON.stringify(small.failures)})`);
    console.log("✅ 최소 해상도 미달 거부");

    // 5-1) 출처 분류 게이트(2026-09-17 저녁, 사용자 결정 C안): 유료 스톡·ND만 거부한다. 그 전 기준
    //      (공공누리·CC BY·공식 배포물만)은 실측 9자리 중 8자리를 "찾았는데 버렸다".
    let fetched = 0;
    const countingFetch = async () => {
      fetched += 1;
      return { ok: true as const, buffer: PNG_1200, contentType: "image/png" };
    };
    for (const bad of ["cc_nd", "paid_stock"]) {
      const rejected = await collectWebImages(
        { keyword: "k", dir, slots: [slots[0]] },
        { searchImages: false, chooseImage: okVerify, runCodex: codexReply([slotReply({ reusePermission: bad, license: "게티이미지 워터마크" })]), fetchImage: countingFetch }
      );
      assert(rejected.found.length === 0, `"${bad}"는 거부해야 한다`);
      assert(rejected.failures[0].includes("쓸 수 없는 자료"), `사유가 분류 거부여야 한다 (${rejected.failures[0]})`);
    }
    assert(fetched === 0, "분류에서 걸리면 내려받지도 말아야 한다");

    for (const allowed of ["broadcaster_promo", "news_photo", "personal_sns", "unclear", "official_company"]) {
      const ok2 = await collectWebImages(
        { keyword: "k", dir, slots: [slots[0]] },
        { searchImages: false, chooseImage: okVerify, runCodex: codexReply([slotReply({ reusePermission: allowed, license: "출처: 뉴시스" })]), fetchImage: okFetch }
      );
      assert(ok2.found.length === 1, `"${allowed}"는 통과해야 한다 (${JSON.stringify(ok2.failures)})`);
      assert(ok2.found[0].license === "출처: 뉴시스", "캡션 출처 표기가 보존돼야 한다");
    }
    console.log("✅ 출처 분류 - 유료 스톡·ND만 거부, 보도사진·SNS·불명확도 출처 표기와 함께 저장(C안)");

    // 5-2) 세로·정사각은 자리 1이라도 저장한다(2026-09-17 저녁 완화 - 포스터·프로필은 원래 세로다.
    //      옛 기준이 실제 포스터 1200×837과 감독 프로필 1600×2400을 버렸다). 경고만 남긴다.
    const portraitFirst = await collectWebImages(
      { keyword: "k", dir, slots: [slots[0]] },
      { searchImages: false, chooseImage: okVerify, runCodex: codexReply([slotReply()]), fetchImage: okFetch, readSize: () => ({ width: 1600, height: 2400 }) }
    );
    assert(portraitFirst.found.length === 1, `자리 1도 세로를 저장해야 한다 (${JSON.stringify(portraitFirst.failures)})`);
    assert(portraitFirst.failures.some((f) => f.includes("정사각·세로")), "경고는 남겨야 한다");

    // 긴 변 기준: 450×700(세로, 긴 변 700)은 통과, 500×400(긴 변 500)은 거부.
    const tallSmall = await collectWebImages(
      { keyword: "k", dir, slots: [slots[0]] },
      { searchImages: false, chooseImage: okVerify, runCodex: codexReply([slotReply()]), fetchImage: okFetch, readSize: () => ({ width: 450, height: 700 }) }
    );
    assert(tallSmall.found.length === 1, "긴 변이 600 이상이면 너비가 작아도 저장한다");
    const tiny = await collectWebImages(
      { keyword: "k", dir, slots: [slots[0]] },
      { searchImages: false, chooseImage: okVerify, runCodex: codexReply([slotReply()]), fetchImage: okFetch, readSize: () => ({ width: 500, height: 400 }) }
    );
    assert(tiny.found.length === 0 && tiny.failures[0].includes("너무 작습니다"), "긴 변 600 미만은 거부한다");
    console.log("✅ 크기 검증 - 긴 변 600px 기준, 세로·정사각은 자리 1도 저장");

    // 5-2-1) 이미지 검색 후보(2026-09-17 저녁): 후보가 프롬프트에 실리고, 후보에서 고르면 sourcePage가
    //        비어 있어도 이미지 도메인을 출처로 채운다.
    let seenPrompt = "";
    const fromCandidate = await collectWebImages(
      { keyword: "k", dir, slots: [slots[0]] },
      {
        searchImages: async (q) => [{ title: `${q} 공식 포스터`, link: "https://img.example.net/p.png", thumbnail: "", width: 1000, height: 1400 }],
        chooseImage: okVerify,
        runCodex: async (input) => {
          seenPrompt = input.prompt;
          return { ok: true as const, data: { slots: [slotReply({ imageUrl: "https://img.example.net/p.png", sourcePage: "" })] }, durationMs: 1 };
        },
        fetchImage: okFetch,
      }
    );
    assert(seenPrompt.includes("네이버 이미지 검색 후보") && seenPrompt.includes("https://img.example.net/p.png"), "후보가 프롬프트에 실려야 한다");
    assert(fromCandidate.found.length === 1 && fromCandidate.found[0].sourcePage === "https://img.example.net", `출처 도메인 폴백이 필요하다 (${JSON.stringify(fromCandidate.failures)})`);
    console.log("✅ 이미지 검색 후보 - 프롬프트에 실리고, 출처 없는 후보는 도메인으로 폴백");

    // 5-2-2) 너무 긴 세로 이미지(2026-09-18): 거부하지 않고 주요 부분만 잘라 저장한다. 비율을 늘려
    //        맞추면 글자가 뭉개지므로 왜곡 없이 잘라내는 것이 사용자 지시다(실측 1080×13861).
    const croppedWith: { width: number; height: number; alt: string }[] = [];
    const tall = await collectWebImages(
      { keyword: "k", dir, slots: [slots[0]] },
      {
        searchImages: false,
        chooseImage: okVerify,
        runCodex: codexReply([slotReply()]),
        fetchImage: okFetch,
        readSize: () => ({ width: 1080, height: 13861 }),
        cropTall: async (input) => {
          croppedWith.push({ width: input.width, height: input.height, alt: input.alt });
          return { ok: true as const, buffer: PNG_1200, mimeType: "image/png", width: 1080, height: 1440, focus: 0 };
        },
      }
    );
    assert(tall.found.length === 1, `자른 뒤 저장돼야 한다 (${JSON.stringify(tall.failures)})`);
    assert(croppedWith.length === 1 && croppedWith[0].height === 13861, "원본 크기가 크로퍼에 전달돼야 한다");
    assert(tall.failures.some((f) => f.includes("주요 부분만 잘랐습니다") && f.includes("1080×1440")), `자른 사실이 기록돼야 한다 (${JSON.stringify(tall.failures)})`);

    // 자르기가 실패해도 원본으로 계속 간다 - 빈 자리보다 긴 이미지가 낫다.
    const cropFailed = await collectWebImages(
      { keyword: "k", dir, slots: [slots[0]] },
      {
        searchImages: false,
        chooseImage: okVerify,
        runCodex: codexReply([slotReply()]),
        fetchImage: okFetch,
        readSize: () => ({ width: 1080, height: 13861 }),
        cropTall: async () => ({ ok: false as const, error: "canvas 실패" }),
      }
    );
    assert(cropFailed.found.length === 1, "자르기 실패해도 원본을 저장한다");
    assert(cropFailed.failures.some((f) => f.includes("자르지 못해 원본")), "실패 사유가 남아야 한다");

    // 포스터·프로필(1:1.5)은 자르지 않는다.
    let cropCalled = false;
    await collectWebImages(
      { keyword: "k", dir, slots: [slots[0]] },
      {
        searchImages: false,
        chooseImage: okVerify,
        runCodex: codexReply([slotReply()]),
        fetchImage: okFetch,
        readSize: () => ({ width: 1600, height: 2400 }),
        cropTall: async () => {
          cropCalled = true;
          return { ok: false as const, error: "불러선 안 된다" };
        },
      }
    );
    assert(!cropCalled, "1:1.5 포스터는 자르지 않아야 한다");
    console.log("✅ 긴 세로 이미지 - 왜곡 없이 크롭, 실패 시 원본 유지, 포스터는 그대로");

    // 5-3) 비전 검증(2026-09-17): Codex는 URL만 고르고 이미지를 보지 않아, 대만 OTT 건처럼
    //      alt는 "공식 포스터"인데 실제 파일은 스틸컷인 불일치가 나왔다. 불합격이면 파일까지 지운다.
    // 앞 블록들이 같은 dir에 성공 파일을 남기므로 이 검사만 빈 디렉터리에서 한다.
    const rejectDir = await mkdtemp(resolve(tmpdir(), "collect-reject-"));
    const rejected = await collectWebImages(
      { keyword: "k", dir: rejectDir, slots: [slots[0]] },
      {
        searchImages: false,
        cropTall: false,
        runCodex: codexReply([slotReply()]),
        fetchImage: okFetch,
        chooseImage: async () => ({ picked: null, reason: "설명은 포스터인데 실제는 스틸컷입니다" }),
      }
    );
    assert(rejected.found.length === 0, "검증 불합격이면 채택하면 안 된다");
    assert(
      rejected.failures.some((f) => f.includes("스틸컷")),
      `검증 사유가 그대로 전달돼야 한다 (${JSON.stringify(rejected.failures)})`
    );
    const leftovers = (await readdir(rejectDir)).filter((f) => f !== "web-images.json");
    assert(leftovers.length === 0, `불합격 파일은 지워야 한다 (남은 것: ${JSON.stringify(leftovers)})`);
    await rm(rejectDir, { recursive: true, force: true });

    // 검증자에게 파일 경로·설명·문단이 전달된다(무엇을 보고 판정할지의 근거).
    const seenInputs: ChooseImageInput[] = [];
    await collectWebImages(
      { keyword: "남양주 카페 갑질", dir, slots: [slots[0]] },
      {
        searchImages: false,
        runCodex: codexReply([slotReply()]),
        fetchImage: okFetch,
        chooseImage: async (i) => {
          seenInputs.push(i);
          return { picked: i.candidates[0].number, reason: "" };
        },
      }
    );
    assert(seenInputs.length === 1, "검증자가 호출돼야 한다");
    const seen = seenInputs[0];
    assert(seen.candidates[0].filePath.includes(dir) && seen.candidates[0].filePath.includes("01-"), "저장된 파일 경로를 넘겨야 한다");
    assert(seen.candidates[0].alt === "카페 픽업대 사진" && seen.context.includes("픽업대 앞에 줄이"), "설명과 문단을 넘겨야 한다");
    assert(seen.keyword === "남양주 카페 갑질", "원고 주제도 넘겨야 한다");

    // verify: false면 검증을 건너뛴다(시간·호출 절약).
    let verifyCalls = 0;
    const skippedVerify = await collectWebImages(
      { keyword: "k", dir, slots: [slots[0]] },
      {
        searchImages: false,
        runCodex: codexReply([slotReply()]),
        fetchImage: okFetch,
        verify: false,
        chooseImage: async () => {
          verifyCalls += 1;
          return { picked: null, reason: "불려선 안 된다" };
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
        searchImages: false,
        chooseImage: okVerify,
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
        searchImages: false,
        chooseImage: okVerify,
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

    // 5-5) 빈 자리만 채우는 재실행에서 지난 결과가 사라지면 안 된다(사이드카 병합).
    const mergeDir = await mkdtemp(resolve(tmpdir(), "collect-merge-"));
    try {
      await collectWebImages(
        { keyword: "k", dir: mergeDir, slots: [slots[0]] },
        { searchImages: false, chooseImage: okVerify, runCodex: codexReply([slotReply({ index: 1 })]), fetchImage: okFetch }
      );
      await collectWebImages(
        { keyword: "k", dir: mergeDir, slots: [slots[1]] },
        { searchImages: false, chooseImage: okVerify, runCodex: codexReply([slotReply({ index: slots[1].index })]), fetchImage: okFetch }
      );
      const merged = JSON.parse(await readFile(resolve(mergeDir, "web-images.json"), "utf-8")) as {
        images: { index: number }[];
      };
      assert(merged.images.length === 2, `두 번에 나눠 채워도 둘 다 남아야 한다 (${JSON.stringify(merged.images)})`);
      assert(
        merged.images[0].index === 1 && merged.images[1].index === slots[1].index,
        "자리 번호 순으로 정렬돼야 한다"
      );
      console.log("✅ 재실행 시 사이드카 병합 - 지난 실행에서 채운 자리가 살아남음");
    } finally {
      await rm(mergeDir, { recursive: true, force: true });
    }

    // 6) Codex가 못 찾았다고(skipped) 하면 빈 자리로 남기고 사유를 전한다 - 억지로 채우지 않는다.
    const skipped = await collectWebImages(
      { keyword: "k", dir, slots: [slots[0]] },
      { searchImages: false, chooseImage: okVerify, runCodex: codexReply([slotReply({ skipped: true, skipReason: "공식 배포 이미지를 못 찾음", imageUrl: "" })]), fetchImage: okFetch }
    );
    assert(skipped.found.length === 0 && skipped.failures[0].includes("공식 배포 이미지를 못 찾음"), "skip 사유가 전달돼야 한다");
    console.log("✅ Codex가 못 찾은 자리는 빈 자리로 유지");

    // 7) URL이 아닌 값, Codex 실행 실패는 예외 없이 사유로 돌아온다.
    const badUrl = await collectWebImages(
      { keyword: "k", dir, slots: [slots[0]] },
      { searchImages: false, chooseImage: okVerify, runCodex: codexReply([slotReply({ imageUrl: "그냥 텍스트" })]), fetchImage: okFetch }
    );
    assert(badUrl.found.length === 0 && badUrl.failures[0].includes("URL 형식"), "URL 검증이 있어야 한다");

    const codexDown = await collectWebImages(
      { keyword: "k", dir, slots: [slots[0]] },
      { searchImages: false, chooseImage: okVerify, runCodex: async () => ({ ok: false as const, error: "codex 없음", durationMs: 1 }), fetchImage: okFetch }
    );
    assert(codexDown.found.length === 0 && codexDown.failures[0].includes("codex 없음"), "실행 실패가 사유로 와야 한다");
    console.log("✅ 잘못된 URL / Codex 실행 실패 - 예외 없이 사유 반환");

    // 8) 웹 검색 자리가 없으면 Codex를 아예 부르지 않는다(불필요한 유료 호출 방지).
    let called = 0;
    const none = await collectWebImages(
      { keyword: "k", dir, slots: [] },
      {
        searchImages: false,
        chooseImage: okVerify,
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

// --- 비전 검증 판정 기준(2026-09-18) - alt가 아니라 마커 설명으로 본다 --------------------------
{
  const dir2 = await mkdtemp(resolve(tmpdir(), "collect-verify-"));
  try {
    let seen: { markerDescription: string; alt: string } | null = null;
    await collectWebImages(
      { keyword: "k", dir: dir2, slots: [{ index: 1, description: "배우 이청아의 최근 공식 프로필 사진", query: null, context: "문단" }] },
      {
        searchImages: false,
        cropTall: false,
        runCodex: codexReply([slotReply({ alt: "선글라스를 쓰고 거리에서 찍힌 모습" })]),
        fetchImage: okFetch,
        chooseImage: async (input) => {
          seen = { markerDescription: input.markerDescription, alt: input.candidates[0].alt };
          return { picked: input.candidates[0].number, reason: "" };
        },
      }
    );
    if (!seen) throw new Error("❌ 검증이 호출되지 않았다");
    const got = seen as { markerDescription: string; alt: string };
    if (got.markerDescription !== "배우 이청아의 최근 공식 프로필 사진") {
      throw new Error(`❌ 판정 기준은 마커 설명이어야 한다 (${got.markerDescription})`);
    }
    if (got.alt !== "선글라스를 쓰고 거리에서 찍힌 모습") throw new Error("❌ 수집기 추측(alt)도 참고로 전달돼야 한다");
    console.log("✅ 비전 검증 - 마커 설명이 판정 기준, 수집기 alt는 참고");
  } finally {
    await rm(dir2, { recursive: true, force: true });
  }
}

// --- 후보 비교 선택(2026-09-18 B안) - 여러 장을 한 번에 열어 고른다 ----------------------------
{
  const dir3 = await mkdtemp(resolve(tmpdir(), "collect-choose-"));
  try {
    const slot = { index: 1, description: "배우 이청아의 최근 공식 프로필 사진", query: null, context: "문단" };
    const reply = codexReply([
      slotReply({
        imageUrl: "https://example.com/1.png",
        alternates: [
          { imageUrl: "https://example.com/2.png", sourcePage: "https://a.example.com/p", license: "출처: 뉴시스" },
          { imageUrl: "https://example.com/3.png", sourcePage: "", license: "" },
        ],
      }),
    ]);

    // 1) 후보 3장이 모두 판정자에게 전달되고, 고른 것이 채택된다.
    let got: ChooseImageInput | null = null;
    const picked = await collectWebImages(
      { keyword: "이청아", dir: dir3, slots: [slot] },
      {
        searchImages: false, cropTall: false, runCodex: reply, fetchImage: okFetch,
        chooseImage: async (i) => { got = i; return { picked: 2, reason: "2번이 실제 프로필 사진" }; },
      }
    );
    if (!got) throw new Error("❌ 판정자가 호출되지 않았다");
    const seenInput = got as ChooseImageInput;
    assert(seenInput.candidates.length === 3, `후보 3장이 전달돼야 한다 (${seenInput.candidates.length})`);
    assert(seenInput.candidates.map((c) => c.number).join() === "1,2,3", "후보 번호는 1부터 차례로여야 한다");
    assert(seenInput.markerDescription === slot.description, "판정 기준은 마커 설명이다");
    assert(picked.found.length === 1, `채택돼야 한다 (${JSON.stringify(picked.failures)})`);
    assert(picked.found[0].imageUrl === "https://example.com/2.png", `고른 후보가 채택돼야 한다 (${picked.found[0].imageUrl})`);
    assert(picked.found[0].sourcePage === "https://a.example.com/p", "고른 후보의 출처가 기록돼야 한다");
    assert(picked.found[0].license === "출처: 뉴시스", "고른 후보의 출처 표기가 기록돼야 한다");

    // 2) 고르지 않은 후보 파일은 남지 않는다.
    const files = (await readdir(dir3)).filter((f) => f !== "web-images.json");
    assert(files.length === 1 && !files[0].includes("cand"), `채택본 1개만 남아야 한다 (${JSON.stringify(files)})`);

    // 3) 전부 부적합하면 자리를 비우고 사유를 남긴다.
    const dir4 = await mkdtemp(resolve(tmpdir(), "collect-none-"));
    const none = await collectWebImages(
      { keyword: "이청아", dir: dir4, slots: [slot] },
      {
        searchImages: false, cropTall: false, runCodex: reply, fetchImage: okFetch,
        chooseImage: async () => ({ picked: null, reason: "전부 다른 인물" }),
      }
    );
    assert(none.found.length === 0, "전부 부적합이면 채택하지 않는다");
    assert(none.failures.some((f) => f.includes("전부 다른 인물")), "사유가 전달돼야 한다");
    assert((await readdir(dir4)).length === 0, "후보 파일이 전부 지워져야 한다");
    await rm(dir4, { recursive: true, force: true });

    console.log("✅ 후보 비교 선택 - 여러 장 전달·채택본만 남김·전부 부적합이면 비움");
  } finally {
    await rm(dir3, { recursive: true, force: true });
  }
}

