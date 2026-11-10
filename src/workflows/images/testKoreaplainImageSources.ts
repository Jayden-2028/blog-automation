// koreaplain 이미지 출처 정책 테스트(2026-11-10). 라이브 API·DB·네트워크 호출 없음 - 검색·내려받기·판정·생성·업로드를 전부 주입한다.
//
// 가장 중요한 단정은 3번 블록이다: **다른 트랙에서는 아무것도 걸러지지 않는다.** 엔터·사회·인물은 지금 그대로
// 언론사 사진을 쓰고, 이 변경은 한 줄도 그쪽을 바꾸면 안 된다. 같은 입력을 category만 바꿔 두 번 돌려 비교한다.

import { KOREAPLAIN_TRACK } from "../../config/koreaplainTrack.js";
import { buildFallbackImagePrompts, buildFallbackPrompt } from "./buildFallbackImagePrompts.js";
import { collectWebImagesForJob } from "./collectWebImagesForJob.js";
import { generateManuscriptImages } from "./generateManuscriptImages.js";
import {
  AI_ILLUSTRATION_CREDIT,
  filterKoreaplainCandidates,
  isAllowedKoreaplainCandidate,
  isAllowedKoreaplainImageSource,
  toIllustrationCaption,
  usesKoreaplainImagePolicy,
} from "./koreaplainImageSources.js";
import { validateAiPrompt } from "./refixImageMarkers.js";
import { routeImagePlan } from "./routeImagePlan.js";
import type { ChooseImageInput } from "./collectWebImages.js";
import type { ImageCandidate } from "./searchNaverImages.js";
import type { ImagePlan } from "./planImageSlots.js";
import type { ManuscriptImageConfig } from "../../config/manuscriptImages.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

async function main(): Promise<void> {
  console.log("▶ koreaplain 이미지 출처 정책 테스트 시작\n");

  // --- 1. 화이트리스트 ----------------------------------------------------------------------
  {
    const allowed = [
      "https://www.seoul.go.kr/img/a.jpg",
      "https://seoul.go.kr/a.jpg",
      "https://english.visitkorea.or.kr/a.jpg",
      "https://korean.visitseoul.net/a.jpg",
      "https://www.airport.kr/a.jpg",
      "https://www.korea.kr/newsWeb/a.jpg",
      "https://commons.wikimedia.org/wiki/File:A.jpg",
      "https://upload.wikimedia.org/wikipedia/commons/a.jpg",
      "https://en.wikipedia.org/wiki/Seoul",
      "https://www.molit.go.kr/a.jpg",
    ];
    for (const url of allowed) assert(isAllowedKoreaplainImageSource(url), `허용돼야 한다: ${url}`);

    const rejected = [
      "https://news.naver.com/a",
      "https://imgnews.pstatic.net/image/a.jpg",
      "https://www.news1.kr/photos/a",
      "https://blog.naver.com/x/1",
      "https://ruliweb.com/a",
      "https://www.yna.co.kr/a",
      // `.or.kr`을 통째로 열지 않는다 - 허용 목록의 visitkorea.or.kr 외 사설 단체는 거부.
      "https://www.somefoundation.or.kr/a.jpg",
      // 접미사 위장.
      "https://seoul.go.kr.evil.com/a.jpg",
      "https://notkorea.kr/a.jpg",
      "https://evil.com/seoul.go.kr/a.jpg",
      "ftp://www.seoul.go.kr/a.jpg",
      "not a url",
      "",
    ];
    for (const url of rejected) assert(!isAllowedKoreaplainImageSource(url), `거부돼야 한다: ${url}`);
    console.log("✅ 화이트리스트: 공공·위키 통과, 언론·블로그·커뮤니티·사설 .or.kr·접미사 위장·주소 불량 거부(fail-closed)");

    // 후보는 이미지 주소와 출처 페이지 **둘 다** 허용이어야 한다. 출처 페이지를 모르면 이미지 주소만 본다.
    assert(isAllowedKoreaplainCandidate({ imageUrl: "https://www.seoul.go.kr/a.jpg", sourcePage: "https://www.seoul.go.kr/p" }), "둘 다 허용 -> 통과");
    assert(!isAllowedKoreaplainCandidate({ imageUrl: "https://www.seoul.go.kr/a.jpg", sourcePage: "https://news.naver.com/a" }), "출처 페이지가 언론사면 거부");
    assert(!isAllowedKoreaplainCandidate({ imageUrl: "https://imgnews.pstatic.net/a.jpg", sourcePage: "https://www.seoul.go.kr/p" }), "이미지 주소가 허용 밖이면 거부");
    assert(isAllowedKoreaplainCandidate({ imageUrl: "https://www.seoul.go.kr/a.jpg", sourcePage: "" }), "출처 페이지를 모르면 이미지 주소만 본다");
    assert(isAllowedKoreaplainCandidate({ imageUrl: "https://www.seoul.go.kr/a.jpg" }), "sourcePage 생략도 마찬가지");
    const split = filterKoreaplainCandidates([
      { imageUrl: "https://www.seoul.go.kr/1.jpg" },
      { imageUrl: "https://news.naver.com/2.jpg" },
      { imageUrl: "https://commons.wikimedia.org/3.jpg" },
    ]);
    assert(split.kept.length === 2 && split.dropped.length === 1, "필터는 순서를 유지하며 나눈다");
    assert(usesKoreaplainImagePolicy(KOREAPLAIN_TRACK) && !usesKoreaplainImagePolicy("entertainment") && !usesKoreaplainImagePolicy("incident") && !usesKoreaplainImagePolicy("person") && !usesKoreaplainImagePolicy(null), "정책은 koreaplain 트랙에만");
    console.log("✅ 후보 판정: 이미지 주소와 출처 페이지 둘 다 본다");
  }

  // --- 2. 일러스트 캡션 -------------------------------------------------------------------
  {
    assert(toIllustrationCaption("Two neighbors greeting in an elevator — AI 생성") === `Two neighbors greeting in an elevator. ${AI_ILLUSTRATION_CREDIT}`, "획득 방식 꼬리를 떼고 일러스트 표기를 붙인다");
    assert(toIllustrationCaption("Subway platform (웹 검색 실패 - AI 대체 장면)") === `Subway platform. ${AI_ILLUSTRATION_CREDIT}`, "폴백이 붙인 한글 꼬리를 뗀다");
    assert(toIllustrationCaption("Subway platform. Photo: Naver News") === `Subway platform. ${AI_ILLUSTRATION_CREDIT}`, "Photo: 크레디트를 남기지 않는다");
    assert(toIllustrationCaption("Subway platform.") === `Subway platform. ${AI_ILLUSTRATION_CREDIT}`, "끝 마침표를 겹치지 않는다");
    assert(!/Photo:/i.test(toIllustrationCaption("Photo: Yonhap")), "Photo: 표기는 결과에 없다");
    assert(toIllustrationCaption("") === AI_ILLUSTRATION_CREDIT, "빈 설명이면 표기만");
    assert(AI_ILLUSTRATION_CREDIT.startsWith("Illustration"), "표기는 Illustration 계열");
    console.log(`✅ 캡션: "…. ${AI_ILLUSTRATION_CREDIT}" - Photo: 없음, 한글 꼬리 없음`);
  }

  // --- 3. 수집 경로: koreaplain은 거르고 다른 트랙은 그대로 --------------------------------------
  const BODY = [
    "도입 문단입니다.",
    "[IMAGE: 서울시청 앞 광장 — 웹 검색]\n[IMAGE PROMPT: 서울시청 광장]",
    "지하철 이야기입니다.",
    "[IMAGE: 지하철 승객 — 웹 검색]\n[IMAGE PROMPT: 서울 지하철 승객]",
  ].join("\n\n");
  const PROMPTS = ["서울시청 광장", "서울 지하철 승객"];

  const PNG_1200 = (() => {
    const buffer = Buffer.alloc(24);
    buffer.write("\x89PNG\r\n\x1a\n", 0, "binary");
    buffer.writeUInt32BE(1200, 16);
    buffer.writeUInt32BE(700, 20);
    return buffer;
  })();

  const cand = (link: string, sourcePage: string): ImageCandidate => ({
    title: link,
    link,
    thumbnail: link,
    width: 1200,
    height: 700,
    sourcePage,
  });

  /** 같은 입력을 category만 바꿔 돌린다. 내려받기 시도 주소를 기록해 "언론사 주소를 건드렸는가"를 본다. */
  const run = async (category: string) => {
    const fetched: string[] = [];
    const result = await collectWebImagesForJob(
      { jobId: "test-job", keyword: "how to ride the subway in korea", category, body: BODY, imagePrompts: PROMPTS, captionLanguage: "en" },
      {
        // 검색 후보: 자리 구분 없이 같은 목록(언론 2 + 공공 1).
        searchImages: async () => [
          cand("https://imgnews.pstatic.net/image/001/a.jpg", "https://news.naver.com/article/1"),
          cand("https://www.seoul.go.kr/img/plaza.jpg", "https://www.seoul.go.kr/plaza"),
          cand("https://blog.naver.com/img/b.jpg", "https://blog.naver.com/x/1"),
        ],
        searchRecentImages: false as never,
        searchKinolights: false,
        cropTall: false,
        upload: async ({ index }) => ({ ok: true as const, url: `https://storage/${index}.png`, extension: "png", width: 1200, height: 700 }),
        runCodex: async () => ({
          ok: true as const,
          durationMs: 1,
          data: {
            slots: [
              {
                // 자리 1: 에이전트가 언론사 사진을 1순위로, 커뮤니티를 대체로 골랐다.
                index: 1, imageUrl: "https://www.news1.kr/photos/a.jpg", sourcePage: "https://www.news1.kr/articles/1",
                alt: "plaza", caption: "Plaza. Photo: News1", license: "Photo: News1", reusePermission: "news_photo",
                rationale: "", skipped: false, skipReason: "",
                alternates: [{ imageUrl: "https://ruliweb.com/img/r.jpg", sourcePage: "https://ruliweb.com/p", license: "" }],
              },
              {
                // 자리 2: 에이전트도 언론사 사진뿐이다.
                index: 2, imageUrl: "https://www.yna.co.kr/photos/b.jpg", sourcePage: "https://www.yna.co.kr/view/2",
                alt: "subway", caption: "Subway. Photo: Yonhap", license: "Photo: Yonhap", reusePermission: "news_photo",
                rationale: "", skipped: false, skipReason: "", alternates: [],
              },
            ],
          },
        }),
        fetchImage: async ({ url }) => {
          fetched.push(url);
          // 주소마다 다른 바이트 - 같은 바이트면 중복 검사기가 두 번째 자리를 같은 컷으로 보고 비운다.
          return { ok: true as const, buffer: Buffer.concat([PNG_1200, Buffer.from(url)]), contentType: "image/png" };
        },
        readSize: () => ({ width: 1200, height: 700 }),
        // 자리 2는 검색 후보에 공공 사진이 같이 오지만(위 목록은 자리 구분이 없다) 판정자가 **언론사 사진을 고르려** 한다.
        chooseImage: async (i: ChooseImageInput) => ({ picked: i.candidates[0]?.number ?? null, reason: "", caption: `Picked: ${i.candidates[0]?.sourcePage}` }),
      }
    );
    return { fetched, result };
  };

  const kp = await run(KOREAPLAIN_TRACK);
  {
    // 언론사·커뮤니티 주소는 내려받기조차 시도하지 않는다.
    const touched = kp.fetched.filter((u) => !/seoul\.go\.kr/.test(u));
    assert(touched.length === 0, `koreaplain: 허용 밖 주소를 내려받으면 안 된다 (${touched.join(", ")})`);
    assert(kp.fetched.length > 0, "공공 후보는 내려받아야 한다");
    // 허용된 공공 후보가 있으므로 자리는 공공 사진으로 채워진다(언론사 사진 대신).
    assert(kp.result.images.length > 0 && kp.result.images.every((i) => /seoul\.go\.kr/.test(i.sourcePage ?? "")), "채워진 자리의 출처는 전부 허용 목록 안");
    assert(!kp.result.images.some((i) => /news1|yna|naver|ruliweb/.test(`${i.sourcePage} ${i.license}`)), "언론사 출처 표기가 남으면 안 된다");
    const noteLines = kp.result.failures.filter((f) => f.startsWith("ℹ️ 허용 출처가 아닌 후보"));
    assert(noteLines.length === 1, `버린 건수는 수집 기록에 한 줄만 (${noteLines.length}줄)`);
    assert(/후보 \d+장을 버렸습니다\(언론사·상업 사이트\)\.$/.test(noteLines[0]), `기록 문구가 어긋났다: ${noteLines[0]}`);
    // 자리 1: 에이전트 선택 + 대체 + 검색 후보 중 언론 2 -> 버린 URL = news1, ruliweb, pstatic, blog.naver, yna = 5
    assert(noteLines[0].includes("5장"), `버린 후보는 URL 기준 5장이어야 한다: ${noteLines[0]}`);
    console.log(`✅ 수집(koreaplain): 언론·커뮤니티 후보는 내려받지도 않고 버린다 - "${noteLines[0]}"`);
  }

  // 공공 후보가 하나도 없으면 그 자리는 비고 unfilled로 돌아간다 -> prepareManuscript가 AI 폴백으로 넘기는 입구.
  {
    const result = await collectWebImagesForJob(
      { jobId: "test-job", keyword: "kw", category: KOREAPLAIN_TRACK, body: BODY, imagePrompts: PROMPTS, captionLanguage: "en" },
      {
        searchImages: async () => [cand("https://imgnews.pstatic.net/image/001/a.jpg", "https://news.naver.com/article/1")],
        searchKinolights: false,
        cropTall: false,
        upload: async ({ index }) => ({ ok: true as const, url: `https://storage/${index}.png`, extension: "png", width: 1200, height: 700 }),
        runCodex: async () => ({
          ok: true as const, durationMs: 1,
          data: {
            slots: [1, 2].map((index) => ({
              index, imageUrl: "https://www.news1.kr/photos/a.jpg", sourcePage: "https://www.news1.kr/articles/1",
              alt: "x", caption: "x", license: "Photo: News1", reusePermission: "news_photo",
              rationale: "", skipped: false, skipReason: "", alternates: [],
            })),
          },
        }),
        fetchImage: async () => { throw new Error("허용 밖 후보를 내려받으면 안 된다"); },
        readSize: () => ({ width: 1200, height: 700 }),
        chooseImage: async (i: ChooseImageInput) => ({ picked: i.candidates[0]?.number ?? null, reason: "" }),
      }
    );
    assert(result.images.length === 0, "허용 후보가 없으면 채우지 않는다");
    assert(result.unfilled.map((u) => u.index).join(",") === "1,2", `빈 자리가 unfilled로 돌아와야 AI 폴백이 받는다 (${JSON.stringify(result.unfilled)})`);
    assert(result.failures.some((f) => f.includes("[자리 1] 허용 출처의 후보가 없어")), "자리별 사유가 남아야 한다");
    assert(result.failures.some((f) => f.startsWith("ℹ️ 허용 출처가 아닌 후보")), "버린 건수 한 줄도 남아야 한다");
    console.log("✅ 수집(koreaplain): 허용 후보 0장 -> 자리가 비고 unfilled로 넘어간다(AI 폴백 입구)");

    // 이 unfilled를 기존 폴백 경로에 그대로 태운다(새 루프 없음): 프롬프트 -> 생성.
    const prompts = await buildFallbackImagePrompts(
      { keyword: "how to ride the subway in korea", unfilled: result.unfilled, category: KOREAPLAIN_TRACK },
      {
        generate: async () => ({
          ok: true as const, durationMs: 1,
          output: [
            "INDEX: 1",
            "PROMPT: A photorealistic photograph of Seoul City Hall plaza with Korean pedestrians walking, natural light, no text, no letters. 16:9",
            "",
            "INDEX: 2",
            "PROMPT: A photorealistic photograph of Korean commuters on a subway platform in Korea, natural light, no text, no letters. 16:9",
          ].join("\n"),
        }),
      }
    );
    assert(prompts.slots.length === 2, `빈 두 자리 모두 프롬프트가 나와야 한다 (${prompts.slots.length}, ${prompts.failures.join(" / ")})`);
    for (const slot of prompts.slots) assert(validateAiPrompt(slot.prompt) === null, `생성 프롬프트는 validateAiPrompt를 통과해야 한다: ${slot.prompt}`);
    // (이 테스트의 마커 설명은 한글이라 한글 유무로 단정할 수 없다 - 파이프라인이 붙이는 꼬리만 본다.)
    assert(prompts.slots.every((s) => !s.description.includes("AI 대체 장면") && !s.description.includes("웹 검색 실패")), "koreaplain 폴백 설명에 파이프라인 꼬리가 붙으면 안 된다(영문 캡션이 된다)");
    console.log("✅ 폴백: 빈 자리 -> 영어 프롬프트(validateAiPrompt 통과), 한글 꼬리 없음");

    // 생성 단계: quality low 고정 + 일러스트 캡션 + 인포그래픽 제외.
    const calls: { prompt: string; quality?: string }[] = [];
    const cfg: ManuscriptImageConfig = { enabled: true, abCompare: false, maxPerArticle: 8, infographicQuality: "high" };
    const made = await generateManuscriptImages(
      { jobId: "j", keyword: "kw", date: "2026-11-10", body: BODY, imagePrompts: PROMPTS },
      {
        config: cfg,
        aiIllustrations: true,
        fallbackSlots: [
          ...prompts.slots,
          // 기획이 인포그래픽으로 정한 자리가 흘러들어와도 만들지 않는다.
          { index: 3, description: "Fare table", prompt: "\"1,500 KRW\" infographic, 16:9", acquisition: "infographic" as const },
        ],
        generate: async (input: { prompt: string; quality?: string }) => {
          calls.push(input);
          return {
            ok: true as const, imageBuffer: Buffer.from("fake"), mimeType: "image/png", provider: "openai" as const, model: "gpt-image-2",
            usage: { inputTokens: 1, imageInputTokens: 0, outputTokens: 1, totalTokens: 2 },
          };
        },
        upload: async (i: { jobId: string; index: number }) => ({ ok: true as const, url: `https://storage/${i.jobId}/${i.index}.png`, path: "x/1.png" }) as never,
        record: async () => {},
      }
    );
    assert(calls.length === 2, `인포그래픽은 만들지 않아 2장만 생성해야 한다 (${calls.length})`);
    assert(calls.every((c) => c.quality === "low"), `화질은 low 고정이어야 한다 (${calls.map((c) => c.quality).join(",")})`);
    assert(made.images.length === 2 && made.images.every((i) => i.description.endsWith(`. ${AI_ILLUSTRATION_CREDIT}`)), `캡션이 일러스트 표기여야 한다: ${made.images.map((i) => i.description).join(" | ")}`);
    assert(!made.images.some((i) => /Photo:|사진=|웹 검색 실패/.test(i.description)), "생성 이미지 캡션에 Photo:·사진=·한글 꼬리가 없어야 한다");
    assert(made.failures.some((f) => f.includes("[이미지 3]") && f.includes("AI로 그리지 않아")), "인포그래픽 제외 사유가 기록돼야 한다");
    console.log("✅ 생성(koreaplain): quality=low 고정, 캡션 `Illustration: AI-generated`, 인포그래픽 제외");

    // 대조군: 옵션이 없으면(다른 트랙) 캡션을 건드리지 않고, 인포그래픽도 그대로 만든다.
    const plainCalls: { quality?: string }[] = [];
    const plain = await generateManuscriptImages(
      { jobId: "j", keyword: "kw", date: "2026-11-10", body: BODY, imagePrompts: PROMPTS },
      {
        config: cfg,
        fallbackSlots: [
          { index: 1, description: "Plaza (웹 검색 실패 - AI 대체 장면)", prompt: "A photorealistic photograph, no text, no letters. 16:9" },
          { index: 3, description: "Fare table", prompt: "\"1,500 KRW\" infographic, 16:9", acquisition: "infographic" as const },
        ],
        generate: async (input: { prompt: string; quality?: string }) => {
          plainCalls.push(input);
          return {
            ok: true as const, imageBuffer: Buffer.from("fake"), mimeType: "image/png", provider: "openai" as const, model: "gpt-image-2",
            usage: { inputTokens: 1, imageInputTokens: 0, outputTokens: 1, totalTokens: 2 },
          };
        },
        upload: async (i: { jobId: string; index: number }) => ({ ok: true as const, url: `https://storage/${i.jobId}/${i.index}.png`, path: "x/1.png" }) as never,
        record: async () => {},
      }
    );
    assert(plain.images.length === 2, "다른 트랙은 인포그래픽도 그대로 만든다");
    assert(plain.images[0].description === "Plaza (웹 검색 실패 - AI 대체 장면)", "다른 트랙의 캡션은 바뀌면 안 된다");
    assert(plainCalls.find((c) => c.quality === "high") && plainCalls.find((c) => c.quality === undefined), "다른 트랙의 화질 분기도 그대로(인포그래픽=설정값, 사진=기본)");
    console.log("✅ 생성(다른 트랙): 캡션·인포그래픽·화질 분기 그대로");
  }

  // --- 3-1. 회귀 방어선: 다른 트랙에서는 아무것도 걸러지지 않는다 --------------------------------
  for (const category of ["entertainment", "incident", "person", "ott", "living"]) {
    const other = await run(category);
    const pressTouched = other.fetched.filter((u) => /news1|yna|ruliweb|pstatic|blog\.naver/.test(u));
    assert(pressTouched.length > 0, `${category}: 언론·커뮤니티 후보를 예전처럼 내려받아야 한다 (${other.fetched.join(", ")})`);
    assert(!other.result.failures.some((f) => f.includes("허용 출처")), `${category}: 필터 기록이 생기면 안 된다`);
    assert(other.result.images.length === 2, `${category}: 두 자리 모두 예전처럼 채워진다 (${other.result.images.length})`);
    assert(other.result.unfilled.length === 0, `${category}: 비는 자리가 없다`);
  }
  console.log("✅ 회귀: 엔터·사회·인물·OTT·생활은 후보를 하나도 거르지 않고 예전처럼 언론사 사진을 쓴다");

  // --- 4. 폴백 프롬프트 지시: koreaplain 전용 블록은 그 트랙에만 -----------------------------------
  {
    const unfilled = [{ index: 1, description: "서울 지하철 승객", context: "지하철 문단", suggestion: "" }];
    const kpText = buildFallbackPrompt("서울 지하철", unfilled, KOREAPLAIN_TRACK);
    const otherText = buildFallbackPrompt("서울 지하철", unfilled, "entertainment");
    const noCategory = buildFallbackPrompt("서울 지하철", unfilled);
    assert(kpText.includes("특정 사진을 모사하지 않는다") && kpText.includes("글자·숫자가 정보인 자리는 `SKIP`"), "koreaplain 지시가 있어야 한다");
    assert(!otherText.includes("Korea Plain") && otherText === noCategory, "다른 트랙의 폴백 프롬프트는 예전과 같아야 한다");

    // 결정론적 방어선: 키워드 토큰("서울", "지하철")이 설명에 있다고 koreaplain 자리를 통째로 SKIP하지 않는다.
    let llmCalls = 0;
    const gen = async () => {
      llmCalls += 1;
      return { ok: true as const, durationMs: 1, output: "INDEX: 1\nPROMPT: A photorealistic photograph of Korean commuters in Korea, no text, no letters. 16:9" };
    };
    const kp = await buildFallbackImagePrompts({ keyword: "서울 지하철", unfilled, category: KOREAPLAIN_TRACK }, { generate: gen });
    assert(kp.slots.length === 1 && llmCalls === 1, "koreaplain은 키워드 겹침만으로 SKIP하지 않는다");
    const ent = await buildFallbackImagePrompts({ keyword: "서울 지하철", unfilled, category: "entertainment" }, { generate: gen });
    assert(ent.slots.length === 0 && llmCalls === 1, "다른 트랙은 기존 결정론적 SKIP 그대로(LLM을 부르지도 않는다)");
    console.log("✅ 폴백 지시: koreaplain 전용 블록·키워드 가드 해제는 그 트랙에만");
  }

  // --- 5. 기획 라우팅: 인포그래픽 차단 ------------------------------------------------------------
  {
    const body = ["문단.", "[IMAGE: Fare table — 웹 검색]\n[IMAGE PROMPT: 지하철 요금표]"].join("\n\n");
    const plan: ImagePlan = {
      summary: "s", protagonist: "p",
      slots: [{ index: 1, subject: "Fare table", queries: ["\"1,500 KRW\" infographic of subway fares, 16:9 no text"], acquisition: "infographic", recency: "any", changed: true, reason: "", caution: "" }],
    } as ImagePlan;
    const blocked = routeImagePlan(plan, body, ["지하철 요금표"], { blockInfographic: true });
    const open = routeImagePlan(plan, body, ["지하철 요금표"], {});
    assert(blocked.generate.length === 0 && blocked.notes.some((n) => n.includes("인포그래픽을 만들지 않습니다")), "koreaplain은 기획 인포그래픽을 만들지 않는다");
    assert(open.generate.length === 1 || open.notes.length > 0, "옵션이 없으면 예전 경로(생성 또는 프롬프트 규격 메모)");
    assert(!open.notes.some((n) => n.includes("인포그래픽을 만들지 않습니다")), "다른 트랙에는 차단 메모가 없다");
    console.log("✅ 기획 라우팅: koreaplain만 인포그래픽 차단");
  }

  console.log("\n✅ 전체 통과");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
