// 한국관광공사 관광사진 1순위 출처·톤 보정·AI 설명 그림(2026-11-25) 테스트.
//
// 기본은 **오프라인**이다 - API·내려받기·판정·업로드를 전부 주입한다. 톤 보정 한 블록만 실제 Chromium canvas를 쓴다(로컬 브라우저,
// 네트워크 없음 - testOptimizeImage.ts와 같다).
// 라이브 호출은 `KTO_SERVICE_KEY`가 환경에 있을 때만 최대 5회 하고, 호출 사실을 출력한다(없으면 생략).

import { chromium } from "playwright";

import { KOREAPLAIN_TRACK } from "../../config/koreaplainTrack.js";
import {
  buildGallerySearchUrl,
  createKtoSearch,
  normalizeServiceKey,
  parseGallerySearchResponse,
  KTO_DATASET_PAGE,
} from "../../services/images/ktoPhotoGallery.js";
import type { KtoPhoto, KtoSearch, KtoSearchResult } from "../../services/images/ktoPhotoGallery.js";
import { optimizeImage } from "../../services/images/optimizeImage.js";
import { KOREAPLAIN_PHOTO_GRADE, photoGradeLib } from "../../services/images/photoGrade.js";
import { readImageSize } from "../../services/images/imageDimensions.js";
import { collectKtoPhotos, KTO_MAX_CALLS_PER_MANUSCRIPT, assignKtoCandidates, rankKtoPhotos, scoreKtoPhoto } from "./collectKtoPhotos.js";
import { collectWebImagesForJob } from "./collectWebImagesForJob.js";
import { collectWebImages } from "./collectWebImages.js";
import type { ChooseImageInput, WebImageSlot } from "./collectWebImages.js";
import { generateManuscriptImages } from "./generateManuscriptImages.js";
import {
  KOREAPLAIN_AI_PHOTO_STYLE,
  isAllowedKoreaplainImageSource,
  isNoDerivativesLicense,
  ktoPhotoCredit,
  romanizePhotographer,
  toKoreaplainAiPrompt,
  toKtoPhotoCaption,
} from "./koreaplainImageSources.js";
import { buildKoreaplainKtoHints, buildKtoSlotHints, hangulDishesIn, koreanSlotTexts, romanizedDishesIn } from "./koreanFoodNames.js";
import { validateAiPrompt } from "./refixImageMarkers.js";
import type { ManuscriptImageConfig } from "../../config/manuscriptImages.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const PNG_1200 = (() => {
  const buffer = Buffer.alloc(24);
  buffer.write("\x89PNG\r\n\x1a\n", 0, "binary");
  buffer.writeUInt32BE(1200, 16);
  buffer.writeUInt32BE(800, 20);
  return buffer;
})();

function photo(id: string, title: string, extra: Partial<KtoPhoto> = {}): KtoPhoto {
  return {
    contentId: id,
    title,
    imageUrl: `http://tong.visitkorea.or.kr/cms2/website/${id}.jpg`,
    location: "",
    photographer: "한국관광공사 김지호",
    searchKeywords: "",
    photographyMonth: "202305",
    ...extra,
  };
}

async function main(): Promise<void> {
  console.log("▶ 한국관광공사 관광사진·톤 보정 테스트 시작\n");

  // --- 1. API 응답 파싱 ---------------------------------------------------------------------
  {
    const many = parseGallerySearchResponse({
      response: {
        header: { resultCode: "0000", resultMsg: "OK" },
        body: {
          totalCount: 2,
          items: {
            item: [
              { galContentId: "1", galTitle: "춘천 닭갈비", galWebImageUrl: "http://tong.visitkorea.or.kr/a.jpg", galPhotographyLocation: "강원도 춘천시", galPhotographer: "한국관광공사 김지호", galSearchKeyword: "닭갈비, 춘천", galPhotographyMonth: 202105 },
              { galContentId: "2", galTitle: "주소 없음" },
            ],
          },
        },
      },
    });
    assert(many.ok && many.photos.length === 1 && many.photos[0].location === "강원도 춘천시" && many.photos[0].photographyMonth === "202105", `여러 건 파싱 (${JSON.stringify(many)})`);
    const one = parseGallerySearchResponse({ response: { header: { resultCode: "0000" }, body: { totalCount: 1, items: { item: { galContentId: "9", galTitle: "나주곰탕", galWebImageUrl: "https://tong.visitkorea.or.kr/b.jpg" } } } } });
    assert(one.ok && one.photos.length === 1 && one.photos[0].contentId === "9", "1건이면 item이 객체로 온다 - 배열로 받는다");
    const none = parseGallerySearchResponse({ response: { header: { resultCode: "0000" }, body: { totalCount: 0, items: "" } } });
    assert(none.ok && none.photos.length === 0, "0건이면 items가 빈 문자열 - 오류가 아니다");
    const err = parseGallerySearchResponse({ response: { header: { resultCode: "30", resultMsg: "SERVICE KEY IS NOT REGISTERED ERROR." } } });
    assert(!err.ok && err.error.includes("30"), "오류 코드는 실패로");
    assert(!parseGallerySearchResponse({ nope: 1 }).ok, "형식이 아니면 실패");
    console.log("✅ 응답 파싱: 여러 건·1건(객체)·0건(빈 문자열)·오류 코드");
  }

  // --- 2. 키 처리·URL·키 없음 -----------------------------------------------------------------
  {
    const raw = "abc+def/ghi==";
    const encoded = encodeURIComponent(raw);
    assert(normalizeServiceKey(encoded) === raw, "Encoding 키는 한 번 풀어 원문으로");
    assert(normalizeServiceKey(raw) === raw, "원문 키는 그대로");
    assert(normalizeServiceKey("  ") === null && normalizeServiceKey(undefined) === null, "빈 키는 null");
    const url = buildGallerySearchUrl(raw, "닭갈비");
    assert(url.includes(`serviceKey=${encodeURIComponent(raw).replace(/%20/g, "+")}`) || url.includes("serviceKey=abc%2Bdef%2Fghi%3D%3D"), `키는 한 번만 인코딩 (${url.replace(/serviceKey=[^&]+/, "serviceKey=***")})`);
    assert(!url.includes("%25"), "두 번 인코딩(%25)되면 안 된다");
    const params = new URL(url).searchParams;
    assert(params.get("keyword") === "닭갈비" && params.get("MobileOS") === "ETC" && params.get("MobileApp") === "KoreaPlain" && params.get("_type") === "json", "공통 파라미터");
    assert(createKtoSearch({ serviceKey: "" }) === null, "키가 없으면 검색 함수가 없다(건너뛴다)");

    // 오류 문구에 키·URL이 새지 않는다.
    const secret = "SECRET-KEY-123";
    const throwing = createKtoSearch({ serviceKey: secret, fetchFn: (async (u: string) => { throw new Error(`connect failed ${u}`); }) as unknown as typeof fetch })!;
    const failed = await throwing("닭갈비");
    assert(!failed.ok && !failed.error.includes(secret) && !failed.error.includes("apis.data.go.kr"), `오류 문구에 키·URL 금지 (${!failed.ok ? failed.error : ""})`);
    const xml = createKtoSearch({
      serviceKey: secret,
      fetchFn: (async () => new Response("<OpenAPI_ServiceResponse><cmmMsgHeader><returnAuthMsg>SERVICE_KEY_IS_NOT_REGISTERED_ERROR</returnAuthMsg></cmmMsgHeader></OpenAPI_ServiceResponse>", { status: 200 })) as unknown as typeof fetch,
    })!;
    const xmlResult = await xml("닭갈비");
    assert(!xmlResult.ok && xmlResult.error.includes("SERVICE_KEY_IS_NOT_REGISTERED_ERROR") && !xmlResult.error.includes(secret), "XML 인증 오류는 사유 코드만");
    console.log("✅ 키: Encoding/Decoding 키 모두, 한 번만 인코딩, 키 없으면 null, 오류 문구에 키·URL 없음");
  }

  // --- 3. 한글 음식명 뽑기 ----------------------------------------------------------------------
  {
    assert(romanizedDishesIn("chuncheon dakgalbi").map((e) => e.hangul).join() === "닭갈비", "로마자 키워드 → 닭갈비");
    assert(romanizedDishesIn("naju gomtang")[0]?.hangul === "나주곰탕", "지역 고유 이름이 먼저");
    assert(romanizedDishesIn("what is naengmyeon")[0]?.hangul === "냉면", "what is 형");
    assert(hangulDishesIn("춘천 닭갈비를 철판에").map((e) => e.hangul).join() === "닭갈비", "한글 글에서 닭갈비");
    assert(hangulDishesIn("떡갈비 정식").map((e) => e.hangul).join() === "떡갈비", "떡갈비 안의 '갈비'를 따로 세지 않는다");
    assert(hangulDishesIn("떡을 썰어").length === 0, "한 글자 이름(떡)은 한글 본문 스캔에서 빠진다");

    const hints = buildKtoSlotHints({
      keyword: "chuncheon dakgalbi",
      koreanTitle: "춘천 닭갈비, 철판에서 먹는 법",
      slots: [
        { index: 1, planQueries: ["닭갈비", "춘천 닭갈비 철판"], koreanText: "" },
        { index: 2, planQueries: [], koreanText: "철판 위 막국수 한 그릇 — 웹 검색 춘천 막국수" },
        { index: 3, planQueries: ["올챙이국수"], koreanText: "" },
        { index: 4, planQueries: ["춘천 명동 거리 풍경"], koreanText: "골목 풍경" },
      ],
    });
    assert(hints[1]?.source === "plan" && hints[1].dishes.join() === "닭갈비" && hints[1].regions.includes("춘천"), `자리 1: 기획 검색어 (${JSON.stringify(hints[1])})`);
    assert(hints[2]?.source === "korean-draft" && hints[2].dishes[0] === "춘천막국수" && hints[2].dishes[1] === "막국수", `자리 2: 한글 초안 마커 (${JSON.stringify(hints[2])})`);
    assert(hints[3]?.source === "plan-literal" && hints[3].dishes.join() === "올챙이국수", `자리 3: 사전에 없는 음식은 기획 검색어 그대로 (${JSON.stringify(hints[3])})`);
    assert(hints[4]?.source === "job" && hints[4].dishes.join() === "닭갈비", `자리 4: 음식명이 없으면 원고 단위(제목·키워드) (${JSON.stringify(hints[4])})`);
    assert(Object.values(hints).every((h) => h.dishes.length <= 2), "자리당 키워드 2개 이하");

    const none = buildKtoSlotHints({ keyword: "korea subway fare", slots: [{ index: 1, planQueries: ["지하철 개찰구"] }] });
    assert(Object.keys(none).length === 0, "음식명을 못 구하면 힌트가 없다(관광사진을 건너뛴다)");

    const ko = "도입\n\n[IMAGE: 나주곰탕 한 그릇 — 웹 검색]\n[IMAGE PROMPT: 나주곰탕]\n\n본문\n\n[IMAGE: 상차림 — AI 생성]\n[IMAGE PROMPT: table setting]";
    const texts = koreanSlotTexts(ko, ["나주곰탕", "table setting"]);
    assert(texts[1]?.includes("나주곰탕") && texts[2]?.includes("상차림"), `한글 초안 자리 텍스트 (${JSON.stringify(texts)})`);
    const viaEntry = buildKoreaplainKtoHints({ keyword: "naju gomtang", koreanTitle: "나주곰탕", koreanBody: ko, imagePrompts: ["나주곰탕", "table setting"], slotCount: 2 });
    assert(viaEntry[1]?.dishes.join() === "나주곰탕,곰탕" && viaEntry[1].regions.includes("나주"), `진입점 (${JSON.stringify(viaEntry)})`);
    console.log("✅ 한글 음식명: 기획 → 한글 초안 → 기획 그대로 → 원고 단위, 자리당 2개, 음식 아니면 건너뜀");
  }

  // --- 4. 후보 고르기(메타데이터) ----------------------------------------------------------------
  {
    const hint = { dishes: ["닭갈비"], regions: ["춘천"] };
    const best = scoreKtoPhoto(photo("a", "닭갈비", { location: "강원특별자치도 춘천시" }), hint)!;
    const people = scoreKtoPhoto(photo("b", "닭갈비 먹는 관광객", { location: "강원특별자치도 춘천시" }), hint)!;
    const sign = scoreKtoPhoto(photo("c", "닭갈비 골목 간판"), hint)!;
    const elsewhere = scoreKtoPhoto(photo("d", "닭갈비", { location: "서울특별시 중구" }), hint)!;
    assert(scoreKtoPhoto(photo("e", "춘천 소양강 스카이워크"), hint) === null, "음식명이 제목·키워드에 없으면 후보가 아니다");
    assert(scoreKtoPhoto(photo("f", "춘천 명소", { searchKeywords: "닭갈비, 춘천" }), hint) !== null, "검색키워드 일치도 후보");
    assert(best.score > elsewhere.score, "지역 일치 가점");
    assert(best.score > people.score && best.score > sign.score, "사람·글자 위주는 감점");
    const ranked = rankKtoPhotos(
      [photo("p", "닭갈비 먹는 관광객"), photo("a", "닭갈비", { location: "춘천시" }), photo("a", "닭갈비"), { ...photo("x", "닭갈비"), imageUrl: "https://evil.example.com/a.jpg" }],
      hint
    );
    assert(ranked.length === 2 && ranked[0].photo.contentId === "a", `점수순·같은 사진 1번·허용 호스트 밖 제외 (${ranked.map((r) => r.photo.contentId).join(",")})`);
    const assigned = assignKtoCandidates(
      new Map([
        [1, rankKtoPhotos([photo("a", "닭갈비"), photo("b", "닭갈비 한상")], hint)],
        [2, rankKtoPhotos([photo("a", "닭갈비"), photo("b", "닭갈비 한상")], hint)],
      ])
    );
    assert(assigned.get(1)?.[0].photo.contentId === "a" && assigned.get(2)?.[0].photo.contentId === "b", "앞 자리가 쓴 1순위는 뒤 자리 후보에서 빠진다(한 원고 안 중복 회피)");
    assert(isAllowedKoreaplainImageSource("http://tong.visitkorea.or.kr/cms2/website/a.jpg"), "tong.visitkorea.or.kr은 기존 화이트리스트 안");
    console.log("✅ 선택: 음식명 일치 필수, 지역 가점, 사람·글자 감점, 원고 안 중복 회피, 허용 호스트만");
  }

  // --- 5. 출처 표기 ------------------------------------------------------------------------------
  {
    assert(romanizePhotographer("한국관광공사 김지호") === "Kim Jiho", romanizePhotographer("한국관광공사 김지호"));
    assert(romanizePhotographer("IR 스튜디오 이창용") === "Lee Changyong", romanizePhotographer("IR 스튜디오 이창용"));
    assert(romanizePhotographer("라이브스튜디오") === "", "한글 단체명은 옮기지 않는다");
    assert(romanizePhotographer("John Doe") === "John Doe", "로마자 이름은 그대로");
    assert(ktoPhotoCredit("한국관광공사 김지호") === "Photo: Korea Tourism Organization (Kim Jiho), KOGL Type 1", ktoPhotoCredit("한국관광공사 김지호"));
    assert(ktoPhotoCredit("") === "Photo: Korea Tourism Organization, KOGL Type 1", "촬영자 없으면 괄호 없음");
    assert(
      toKtoPhotoCaption("Dakgalbi on a hot plate in Chuncheon. Photo: Korea Tourism Organization", "한국관광공사 김지호") ===
        "Dakgalbi on a hot plate in Chuncheon. Photo: Korea Tourism Organization (Kim Jiho), KOGL Type 1",
      "판정자가 붙인 출처는 떼고 정식 표기로"
    );
    assert(toKtoPhotoCaption("닭갈비 — 웹 검색", "") === "Photo: Korea Tourism Organization, KOGL Type 1", "한글 소개는 영문 캡션에 쓰지 않는다");
    console.log("✅ 출처 표기: Photo: Korea Tourism Organization (촬영자), KOGL Type 1");
  }

  // --- 6. collectKtoPhotos: 호출 상한·키워드 캐시·판정·캡션 ------------------------------------
  const slotsOf = (n: number): WebImageSlot[] =>
    Array.from({ length: n }, (_, i) => ({ index: i + 1, description: `Dish photo ${i + 1} — 웹 검색`, query: null, context: "Paragraph about the dish." }));
  {
    const calls: string[] = [];
    const search: KtoSearch = async (keyword) => {
      calls.push(keyword);
      // 키워드마다 1장만 준다 → 자리마다 둘째 키워드까지 부르게 만든다.
      return { ok: true, photos: [photo(`id-${keyword}`, keyword)], totalCount: 1 } satisfies KtoSearchResult;
    };
    const hints = Object.fromEntries(
      Array.from({ length: 6 }, (_, i) => [i + 1, { dishes: [`음식${i}가`, `음식${i}나`], regions: [], source: "plan" as const }])
    );
    const result = await collectKtoPhotos(
      { keyword: "kw", dir: "/tmp", slots: slotsOf(6), hints },
      { search, verify: false, fetchImage: async () => ({ ok: false, error: "skip" }) }
    );
    assert(calls.length === KTO_MAX_CALLS_PER_MANUSCRIPT && result.calls === 8, `원고당 8호출 상한 (${calls.length})`);
    assert(result.failures.some((f) => f.includes("상한에 닿아")), "상한에 닿은 사실을 기록");

    const cached: string[] = [];
    await collectKtoPhotos(
      { keyword: "kw", dir: "/tmp", slots: slotsOf(4), hints: Object.fromEntries([1, 2, 3, 4].map((i) => [i, { dishes: ["닭갈비"], regions: [], source: "plan" as const }])) },
      { search: async (k) => (cached.push(k), { ok: true, photos: [photo("a", "닭갈비"), photo("b", "닭갈비"), photo("c", "닭갈비")], totalCount: 3 }), verify: false, fetchImage: async () => ({ ok: false, error: "skip" }) }
    );
    assert(cached.length === 1, `같은 키워드는 원고 안에서 한 번만 부른다 (${cached.length})`);
  }

  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { resolve } = await import("node:path");
  const dir = await mkdtemp(resolve(tmpdir(), "kto-test-"));
  try {
    const uploads: { index: number; mimeType: string }[] = [];
    const chooserSeen: ChooseImageInput[] = [];
    const result = await collectKtoPhotos(
      { keyword: "chuncheon dakgalbi", dir, slots: slotsOf(2), hints: { 1: { dishes: ["닭갈비"], regions: ["춘천"], source: "plan" }, 2: { dishes: ["막국수"], regions: [], source: "plan" } } },
      {
        search: async (k) =>
          k === "닭갈비"
            ? { ok: true, photos: [photo("a", "닭갈비", { location: "강원특별자치도 춘천시", photographer: "한국관광공사 김지호" }), photo("b", "닭갈비 먹는 관광객")], totalCount: 2 }
            : { ok: true, photos: [photo("m", "막국수")], totalCount: 1 },
        fetchImage: async ({ url }) => ({ ok: true, buffer: Buffer.concat([PNG_1200, Buffer.from(url)]), contentType: "image/jpeg" }),
        readSize: () => ({ width: 1200, height: 800 }),
        chooseImage: async (input) => {
          chooserSeen.push(input);
          // 자리 2(막국수)는 "맞지 않는다"고 한다 → 다음 단계로.
          if (/막국수/.test(input.candidates[0]?.alt ?? "")) return { picked: null, reason: "not matching" };
          return { picked: input.candidates[0].number, reason: "ok", caption: "Dakgalbi cooking on a hot plate. Photo: KTO" };
        },
        upload: async (i) => (uploads.push({ index: i.index, mimeType: i.mimeType }), { ok: true as const, url: `https://storage/${i.index}.webp`, extension: "webp", width: 1600, height: 900 }),
        captionLanguage: "en",
      }
    );
    assert(result.found.length === 1 && result.found[0].index === 1, `자리 1만 채운다 (${JSON.stringify(result.found.map((f) => f.index))})`);
    const record = result.found[0];
    assert(record.caption === "Dakgalbi cooking on a hot plate. Photo: Korea Tourism Organization (Kim Jiho), KOGL Type 1", `캡션 (${record.caption})`);
    assert(record.sourcePage === KTO_DATASET_PAGE && /공공누리 제1유형/.test(record.license) && /galContentId a/.test(record.license), `출처·라이선스 기록 (${record.sourcePage} / ${record.license})`);
    assert(record.storageUrl === "https://storage/1.webp" && record.storedSize?.width === 1600, "업로드 결과가 기록된다");
    assert(result.candidates[1]?.length === 2 && result.candidates[1].some((c) => c.picked), "뷰어 후보 기록");
    assert(!result.candidates[2], "판정이 비운 자리는 후보 기록을 남기지 않는다");
    assert(result.failures.some((f) => f.startsWith("[자리 2]") && f.includes("다음 단계로")), "자리 2는 다음 단계로 넘긴다는 기록");
    assert(chooserSeen.every((c) => /음식이 주인공/.test(c.caution ?? "")), "판정자에게 사람·글자 회피를 알린다");
    console.log("✅ collectKtoPhotos: 원고당 8호출 상한·키워드 캐시·판정·KOGL 캡션·후보 기록·실패 시 다음 단계");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  // --- 7. collectWebImagesForJob 배선: koreaplain ① 관광사진 → ② 웹, 키 없음 폴백, 타 트랙 무영향 -------------
  {
    const BODY = [
      "Intro.",
      "[IMAGE: Dakgalbi on a hot plate — 웹 검색]\n[IMAGE PROMPT: 닭갈비]",
      "Where to eat.",
      "[IMAGE: Chuncheon city hall — 웹 검색]\n[IMAGE PROMPT: 춘천시청]",
    ].join("\n\n");
    const PROMPTS = ["닭갈비", "춘천시청"];
    const run = async (category: string, ktoSearch: false | KtoSearch | undefined) => {
      const ktoCalls: string[] = [];
      const agentSlots: number[][] = [];
      const wrapped = ktoSearch ? (async (k: string) => (ktoCalls.push(k), ktoSearch(k))) as KtoSearch : ktoSearch;
      const result = await collectWebImagesForJob(
        {
          jobId: "job",
          keyword: "chuncheon dakgalbi",
          category,
          body: BODY,
          imagePrompts: PROMPTS,
          captionLanguage: "en",
          ktoHints: { 1: { dishes: ["닭갈비"], regions: ["춘천"], source: "plan" } },
        },
        {
          ...(wrapped === undefined ? {} : { ktoSearch: wrapped }),
          searchImages: false,
          searchRecentImages: false as never,
          searchKinolights: false,
          cropTall: false,
          upload: async ({ index }) => ({ ok: true as const, url: `https://storage/${index}.webp`, extension: "webp", width: 1600, height: 900 }),
          runCodex: async (input) => {
            agentSlots.push([...String(input.prompt).matchAll(/### 자리 (\d+)/g)].map((m) => Number(m[1])));
            return { ok: true as const, durationMs: 1, data: { slots: [] } };
          },
          fetchImage: async ({ url }) => ({ ok: true as const, buffer: Buffer.concat([PNG_1200, Buffer.from(url)]), contentType: "image/jpeg" }),
          readSize: () => ({ width: 1200, height: 800 }),
          chooseImage: async (i: ChooseImageInput) => ({ picked: i.candidates[0]?.number ?? null, reason: "", caption: "Dakgalbi. Photo: x" }),
        }
      );
      return { result, ktoCalls, agentSlots };
    };
    const ktoOk: KtoSearch = async () => ({ ok: true, photos: [photo("a", "닭갈비", { location: "춘천시" })], totalCount: 1 });

    const kp = await run(KOREAPLAIN_TRACK, ktoOk);
    assert(kp.ktoCalls.join() === "닭갈비", `koreaplain은 관광사진을 먼저 부른다 (${kp.ktoCalls.join()})`);
    assert(kp.result.images.some((i) => i.index === 1 && i.sourcePage === KTO_DATASET_PAGE && /KOGL Type 1$/.test(i.description)), `자리 1은 관광사진 (${JSON.stringify(kp.result.images)})`);
    assert(kp.agentSlots.length === 1 && kp.agentSlots[0].join() === "2", `웹 검색은 남은 자리(2)만 (${JSON.stringify(kp.agentSlots)})`);

    // 키 없음: ktoSearch 미지정 + 환경변수 없음 → 조용히 건너뛰고 웹 검색이 두 자리를 다 받는다.
    const savedKey = process.env.KTO_SERVICE_KEY;
    delete process.env.KTO_SERVICE_KEY;
    try {
      const noKey = await run(KOREAPLAIN_TRACK, undefined);
      assert(noKey.agentSlots[0]?.join() === "1,2", `키가 없으면 기존 경로로 (${JSON.stringify(noKey.agentSlots)})`);
      assert(!noKey.result.failures.some((f) => /관광사진/.test(f)), "키 없음은 수집 기록에 남기지 않는다(조용히)");
    } finally {
      if (savedKey !== undefined) process.env.KTO_SERVICE_KEY = savedKey;
    }

    // 다른 트랙: 힌트를 넘겨도 관광사진을 부르지 않는다.
    const ent = await run("entertainment", ktoOk);
    assert(ent.ktoCalls.length === 0, "다른 트랙은 관광사진을 부르지 않는다");
    assert(ent.agentSlots[0]?.join() === "1,2", "다른 트랙은 예전처럼 전 자리를 웹 검색");
    console.log("✅ 배선: koreaplain ① 관광사진 → ② 남은 자리 웹 검색, 키 없음 → 조용히 기존 경로, 다른 트랙 무영향");
  }

  // --- 8. 변경 금지(ND) 제외 - koreaplain만 ----------------------------------------------------------
  {
    const runNd = async (category: string) => {
      const fetched: string[] = [];
      const result = await collectWebImages(
        { keyword: "kw", dir: "/tmp", slots: [{ index: 1, description: "Gyeongbokgung", query: null, context: "ctx" }] },
        {
          category,
          searchImages: false,
          searchRecentImages: false as never,
          searchKinolights: false,
          cropTall: false,
          verify: false,
          runCodex: async () => ({
            ok: true as const,
            durationMs: 1,
            data: { slots: [{ index: 1, imageUrl: "https://upload.wikimedia.org/a.jpg", sourcePage: "https://commons.wikimedia.org/wiki/File:A.jpg", alt: "a", caption: "a", license: "CC BY-ND 4.0", reusePermission: "cc_nd", rationale: "", skipped: false, skipReason: "", alternates: [] }] },
          }),
          fetchImage: async ({ url }) => (fetched.push(url), { ok: false, error: "stop" }),
        }
      );
      return { fetched, result };
    };
    const kp = await runNd(KOREAPLAIN_TRACK);
    assert(kp.fetched.length === 0 && kp.result.failures.some((f) => f.includes("변경 금지(ND)")), "koreaplain: ND 후보는 내려받지 않고 제외");
    const other = await runNd("living");
    assert(other.fetched.length === 1, "다른 트랙은 ND도 예전처럼 시도한다(2026-10-01 정책 그대로)");
    assert(isNoDerivativesLicense("공공누리 제4유형") && isNoDerivativesLicense("KOGL Type 3") && !isNoDerivativesLicense("공공누리 제1유형") && !isNoDerivativesLicense("CC BY 4.0"), "라이선스 문구 판정");
    console.log("✅ ND: koreaplain은 변경 금지 후보를 보정 대신 제외, 다른 트랙은 그대로");
  }

  // --- 9. AI 생성 = 실사 사진 스타일 고정(2026-11-25 실사 전환) -----------------------------------------------------------
  {
    const p = toKoreaplainAiPrompt("A photorealistic photograph of a Korean table with dakgalbi, natural light, no text, no letters. 16:9");
    assert(p.startsWith(`${KOREAPLAIN_AI_PHOTO_STYLE}. `) && !/photorealistic photograph/i.test(p), `스타일 고정·실사 지시어 제거 (${p})`);
    assert(validateAiPrompt(p) === null, `validateAiPrompt 통과 (${validateAiPrompt(p)})`);
    assert(toKoreaplainAiPrompt(p) === p, "두 번 붙이지 않는다");
    assert(/^Photorealistic/.test(KOREAPLAIN_AI_PHOTO_STYLE) && /not an illustration/.test(KOREAPLAIN_AI_PHOTO_STYLE), "스타일은 실사 사진이고 일러스트를 막는다");
    const fromFlat = toKoreaplainAiPrompt("A warm flat illustration of a Korean table with naengmyeon, soft beige palette, no text, no letters. 16:9");
    assert(!/illustration of/i.test(fromFlat.slice(KOREAPLAIN_AI_PHOTO_STYLE.length)) && /Korean table with naengmyeon/.test(fromFlat), `옛 일러스트 프롬프트도 실사로 바뀐다 (${fromFlat})`);
    assert(validateAiPrompt(toKoreaplainAiPrompt("Map of Chuncheon")) === null, "no text·비율이 없으면 붙인다");

    const body = "Intro.\n\n[IMAGE: Table setting — AI 생성]\n[IMAGE PROMPT: A photorealistic photograph of a dakgalbi table, no text, no letters. 16:9]";
    const cfg: ManuscriptImageConfig = { enabled: true, abCompare: false, maxPerArticle: 8, infographicQuality: "high" };
    const sent: string[] = [];
    const gen = async (input: { prompt: string }) => (
      sent.push(input.prompt),
      { ok: true as const, imageBuffer: Buffer.from("x"), mimeType: "image/png", provider: "openai" as const, model: "m", usage: { inputTokens: 1, imageInputTokens: 0, outputTokens: 1, totalTokens: 2 } }
    );
    const common = {
      config: cfg,
      generate: gen,
      upload: (async (i: { jobId: string; index: number }) => ({ ok: true as const, url: `https://s/${i.index}.png`, path: "x/1.png" })) as never,
      record: async () => {},
    };
    const kp = await generateManuscriptImages({ jobId: "j", keyword: "k", date: "2026-11-25", body, imagePrompts: ["A photorealistic photograph of a dakgalbi table, no text, no letters. 16:9"] }, { ...common, aiIllustrations: true });
    assert(sent[0].startsWith(KOREAPLAIN_AI_PHOTO_STYLE) && kp.images[0].prompt === sent[0], "koreaplain 생성 프롬프트에 스타일이 붙고 기록도 같다");
    await generateManuscriptImages({ jobId: "j", keyword: "k", date: "2026-11-25", body, imagePrompts: ["A photorealistic photograph of a dakgalbi table, no text, no letters. 16:9"] }, common);
    assert(sent[1] === "A photorealistic photograph of a dakgalbi table, no text, no letters. 16:9", "다른 트랙은 프롬프트를 바꾸지 않는다");
    console.log("✅ AI: koreaplain은 실사 사진 스타일 한 줄 고정(일러스트 지시어 제거), 다른 트랙 무영향");
  }

  // --- 10. 톤 보정(순수 계산 + 실제 Chromium) -------------------------------------------------------
  {
    const lib = photoGradeLib();
    const crop = lib.cropRect(3000, 2000, 16 / 9);
    assert(crop.sw === 3000 && crop.sh === 1688 && crop.sy === 156, `가로 사진 중앙 크롭 (${JSON.stringify(crop)})`);
    const tall = lib.cropRect(1000, 1500, 16 / 9);
    assert(tall.sw === 1000 && tall.sh === 563 && tall.sy === 468, `세로 사진 중앙 크롭 (${JSON.stringify(tall)})`);
    assert(JSON.stringify(lib.outputSize(3000, 1688, 1600, 900)) === JSON.stringify({ width: 1600, height: 900 }), "1600×900");
    assert(JSON.stringify(lib.outputSize(1000, 563, 1600, 900)) === JSON.stringify({ width: 1000, height: 563 }), "확대하지 않는다");
    const dark = lib.params({ mean: 0.3, std: 0.1 }, KOREAPLAIN_PHOTO_GRADE);
    assert(Math.abs(dark.gain - 1.12) < 1e-9 && Math.abs(dark.contrast - 1.12) < 1e-9 && dark.warmth === 0.035, `어두운 사진: 상한까지 (${JSON.stringify(dark)})`);
    const ok = lib.params({ mean: 0.5, std: 0.22 }, KOREAPLAIN_PHOTO_GRADE);
    assert(Math.abs(ok.gain - 1) < 1e-9 && Math.abs(ok.contrast - 1) < 1e-9, "이미 목표면 밝기·대비는 그대로");
    const off = lib.params({ mean: 0.3, std: 0.1 }, { ...KOREAPLAIN_PHOTO_GRADE, strength: 0 });
    assert(off.gain === 1 && off.contrast === 1 && off.warmth === 0, "strength 0이면 보정 없음(상수 한 곳)");
    const px = lib.apply([128, 128, 128, 255], { gain: 1, contrast: 1, pivot: 0.5, warmth: 0.035 });
    assert(px[0] > 128 && px[1] === 128 && px[2] < 128 && px[3] === 255, `따뜻함: R↑ B↓ 알파 그대로 (${px.join(",")})`);

    let browserOk = true;
    let source: Buffer | null = null;
    try {
      const browser = await chromium.launch({ args: ["--no-sandbox"], executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined });
      try {
        const page = await browser.newPage();
        await page.setContent("<!doctype html><canvas id=c></canvas>");
        const dataUrl = (await page.evaluate(`(() => { const c = document.getElementById("c"); c.width = 1200; c.height = 1200;
          const x = c.getContext("2d"); x.fillStyle = "#555"; x.fillRect(0, 0, 1200, 1200); x.fillStyle = "#777"; x.fillRect(300, 300, 600, 600);
          return c.toDataURL("image/jpeg", 0.9); })()`)) as string;
        source = Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
      } finally {
        await browser.close();
      }
    } catch (error) {
      browserOk = false;
      console.log(`⚠️ Chromium을 띄우지 못해 톤 보정 실제 변환 확인은 건너뜁니다: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    }
    if (browserOk && source) {
      const graded = await optimizeImage({ buffer: source, mimeType: "image/jpeg", grade: KOREAPLAIN_PHOTO_GRADE });
      assert(graded.optimized && graded.mimeType === "image/webp", `톤 보정은 작은 파일도 변환한다 (${graded.skippedReason ?? ""})`);
      const size = readImageSize(graded.buffer);
      assert(size?.width === 1200 && size.height === 675, `정사각 1200 → 16:9 중앙 크롭 1200×675, 확대 없음 (${JSON.stringify(size)})`);
      assert(graded.graded && graded.graded.gain > 1, `어두운 사진은 밝아진다 (${JSON.stringify(graded.graded)})`);
      const plain = await optimizeImage({ buffer: source, mimeType: "image/jpeg" });
      assert(!plain.optimized, "grade 없이는 예전 규칙 그대로(작은 파일은 건너뜀)");
      console.log("✅ 톤 보정: 16:9 중앙 크롭·1600×900 상한·확대 없음·밝기/대비/따뜻함, 강도 상수 한 곳");
    }
  }

  // --- 11. 라이브(선택) ---------------------------------------------------------------------------
  const liveSearch = createKtoSearch();
  if (!liveSearch) {
    console.log("ℹ️ KTO_SERVICE_KEY가 없어 라이브 호출은 생략했습니다(0회).");
  } else {
    const keywords = ["닭갈비", "나주곰탕", "충무김밥"];
    let liveCalls = 0;
    for (const keyword of keywords) {
      if (liveCalls >= 5) break;
      liveCalls += 1;
      const live = await liveSearch(keyword);
      if (!live.ok) {
        console.log(`⚠️ 라이브 "${keyword}": ${live.error}`);
        continue;
      }
      const top = rankKtoPhotos(live.photos, { dishes: [keyword], regions: [] })[0];
      console.log(`ℹ️ 라이브 "${keyword}": ${live.totalCount}건, 받은 ${live.photos.length}장, 1순위 ${top ? `"${top.photo.title}"(${top.photo.location || "-"})` : "없음"}`);
      assert(live.photos.every((p) => isAllowedKoreaplainImageSource(p.imageUrl)), "라이브 이미지 주소는 허용 호스트");
    }
    console.log(`ℹ️ 라이브 호출 ${liveCalls}회(상한 5).`);
  }

  console.log("\n🎉 한국관광공사 관광사진·톤 보정 테스트 통과");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
