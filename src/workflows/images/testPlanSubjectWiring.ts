// 기획이 정한 **대상**이 판정 단계까지 가는지 고정한다(2026-10-02). 실행: npm run test:plan-subject
//
// 실측 사고(오세훈 2심): 기획은 1번 자리를 "청사 외관 → 오세훈 서울시장 단독 사진"으로 바꿨다.
// 검색어는 넘어갔지만 대상은 넘어가지 않아, 판정자가 마커 원문("청사 외관")을 기준으로 오세훈
// 사진 4장을 전부 버렸다. 검색은 A, 판정은 B - 같은 모양의 결함이 세 번째다.
// 그래서 **판정 함수가 실제로 받은 값**을 본다.
import { collectWebImagesForJob } from "./collectWebImagesForJob.js";
import type { ChooseImageInput } from "./collectWebImages.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const BODY = [
  "특검은 오세훈 서울시장에게 징역 1년 6개월을 구형했습니다.",
  "",
  "[IMAGE: 항소심이 열린 서울고등법원 청사 외관 — 웹 검색]",
  "[IMAGE PROMPT: 서울고등법원 청사]",
].join("\n");

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

async function run(
  extra: Record<string, unknown>,
  caption = "",
  search?: { searchImages: (q: string) => Promise<never[] | { title: string; link: string; thumbnail: string; width: number; height: number }[]>; searchRecentImages: (q: string) => Promise<{ title: string; link: string; thumbnail: string; width: number; height: number }[]> }
) {
  let seen: ChooseImageInput | null = null;
  let agentPrompt = "";
  const result = await collectWebImagesForJob(
    { jobId: "test-job", keyword: "오세훈 2심 구형", category: "incident", body: BODY, imagePrompts: [], ...extra },
    {
      searchImages: search ? search.searchImages : false,
      searchRecentImages: search ? search.searchRecentImages : false,
      searchKinolights: false,
      cropTall: false,
      deduper: undefined,
      runCodex: async (input) => {
        agentPrompt = input.prompt;
        return {
          ok: true as const,
          durationMs: 0,
          data: {
            slots: [
              {
                index: 1,
                imageUrl: "https://example.com/a.png",
                sourcePage: "https://example.com",
                alt: "발언하는 오세훈 시장",
                caption: "",
                license: "테스트",
                reusePermission: "news_photo",
                rationale: "",
                skipped: false,
                skipReason: "",
                alternates: [],
              },
            ],
          },
        };
      },
      fetchImage: async () => ({ ok: true, buffer: PNG, contentType: "image/png" }),
      readSize: () => ({ width: 1600, height: 900 }),
      chooseImage: async (input) => {
        seen = input;
        return { picked: 1, reason: "맞다", caption };
      },
      upload: async ({ fileName }) => ({ ok: true as const, url: `https://storage/${fileName}` }),
    }
  );
  return { result, seen: seen as ChooseImageInput | null, agentPrompt };
}

async function main(): Promise<void> {
  console.log("▶ 기획 대상 배선 테스트 시작\n");

  const PLAN = {
    planQueries: { 1: ["오세훈 서울시장"] },
    planSubjects: { 1: { subject: "오세훈 서울시장 단독 사진", caution: "표정이 과하게 극적인 사진은 피한다" } },
  };

  // 1) 판정 기준이 기획의 대상이다.
  {
    const { seen, agentPrompt } = await run(PLAN);
    assert(seen, "판정 함수가 불려야 한다");
    assert(
      seen!.markerDescription === "오세훈 서울시장 단독 사진",
      `판정 기준이 기획 대상이어야 한다 (받은 값: "${seen!.markerDescription}")`
    );
    assert(!seen!.markerDescription.includes("청사"), "마커 원문이 판정 기준에 남으면 안 된다");
    assert(seen!.caution === "표정이 과하게 극적인 사진은 피한다", "기획의 주의사항이 판정에 전달돼야 한다");
    assert(agentPrompt.includes("필요한 이미지: 오세훈 서울시장 단독 사진"), "수집 에이전트도 기획 대상을 봐야 한다");
    assert(agentPrompt.includes("주의: 표정이"), "수집 에이전트도 주의사항을 봐야 한다");
    assert(agentPrompt.includes("검색어: 오세훈 서울시장"), "수집 에이전트에 기획 검색어가 보여야 한다");
    console.log("✅ 판정·수집 기준 = 기획 대상 + 주의사항");
  }

  // 2) 주의사항은 지시문이라 캡션으로 새면 안 된다(판정자가 캡션을 안 준 경우 = 설명 폴백).
  {
    const { result } = await run(PLAN, "");
    const caption = result.images[0]?.description ?? "";
    assert(!caption.includes("표정"), `주의사항이 캡션에 새면 안 된다 (${caption})`);
    console.log("✅ 주의사항은 캡션에 새지 않는다");
  }

  // 3) 사용자 요구가 기획보다 우선한다.
  {
    const { seen } = await run({ ...PLAN, requirements: { "1": "오세훈 1000만원 으로 검색해서 나오는 사진" } });
    assert(seen && !seen.markerDescription.includes("단독 사진"), `사용자 요구가 기획을 덮어야 한다 (${seen?.markerDescription})`);
    console.log("✅ 사용자 요구 > 기획");
  }

  // 4) 기획이 없으면 예전대로 마커 설명이 기준이다.
  {
    const { seen } = await run({});
    assert(seen && seen.markerDescription.includes("청사 외관"), "기획이 없으면 마커가 기준이어야 한다");
    assert(seen!.caution === undefined, "기획이 없으면 주의사항도 없어야 한다");
    console.log("✅ 기획 없음 - 마커 그대로");
  }

  // 5) 최신성 today - 최신순 결과가 후보 맨 앞에 오고, 판정에도 "오늘 사진"이 전달된다.
  {
    const hit = (link: string) => ({ title: link, link, thumbnail: link, width: 1600, height: 900 });
    let recentQuery = "";
    const { seen, agentPrompt } = await run(
      { ...PLAN, planSubjects: { 1: { ...PLAN.planSubjects[1], recency: "today" } } },
      "",
      {
        searchImages: async () => [hit("https://old.example.com/2023.jpg")],
        searchRecentImages: async (q) => { recentQuery = q; return [hit("https://new.example.com/today.jpg")]; },
      }
    );
    assert(recentQuery === "오세훈 서울시장", `최신순 검색은 기획 첫 검색어로 (${recentQuery})`);
    const iNew = agentPrompt.indexOf("new.example.com");
    const iOld = agentPrompt.indexOf("old.example.com");
    assert(iNew > 0 && iOld > 0 && iNew < iOld, "최신순 결과가 관련도순보다 앞에 와야 한다");
    assert(seen?.caution?.includes("오늘 찍힌 사진"), `판정에 최신성이 전달돼야 한다 (${seen?.caution})`);
    console.log("✅ today - 최신순 후보가 맨 앞, 판정에도 전달");
  }

  // 6) 최신성 any면 최신순 검색을 돌리지 않는다(호출 낭비).
  {
    let called = false;
    await run(PLAN, "", {
      searchImages: async () => [],
      searchRecentImages: async () => { called = true; return []; },
    });
    assert(!called, "any면 최신순 검색을 하지 않는다");
    console.log("✅ any - 최신순 검색 생략");
  }

  // 7) 이혼숙려캠프 실측(2026-10-02): 사용자 요구가 오면 기획의 주의사항·검색어를 버리고,
  //    검색어가 없으면 원고 키워드 핵심으로 찾고, "방송 화면 캡처"면 공식 스틸을 후보에서 뺀다.
  {
    const queriesSeen: string[] = [];
    let seen: ChooseImageInput | null = null;
    let agentPrompt = "";
    const hit = (link: string) => ({ title: link, link, thumbnail: link, width: 1600, height: 900 });
    const result = await collectWebImagesForJob(
      {
        jobId: "test-job",
        keyword: "이혼숙려캠프 자극부부 남편 성적 폭언",
        category: "entertainment",
        body: "남편의 성적 폭언이 방송됐다.\n\n[IMAGE: 이혼숙려캠프 공식 스틸 — 웹 검색]\n[IMAGE PROMPT: 이혼숙려캠프 스틸컷]",
        imagePrompts: [],
        planQueries: { 1: ["이혼숙려캠프 스틸컷", "이혼숙려캠프 키노라이츠"] },
        planSubjects: { 1: { subject: "이혼숙려캠프 공식 스틸", caution: "자극부부 당사자 얼굴이 크게 나온 사진은 쓰지 않는다." } },
        requirements: { "1": "해당 회차 방송 화면을 캡쳐한 이미지로 바꿔줘. 성적 폭언이 자막으로 나온 이미지." },
      },
      {
        searchImages: async (q) => { queriesSeen.push(q); return [hit("https://news.example.com/cap.jpg")]; },
        searchRecentImages: false,
        searchKinolights: async () => [{ imageUrl: "https://kinolights.example.com/still.jpg", sourcePage: "https://m.kinolights.com/title/1" }],
        cropTall: false,
        deduper: undefined,
        runCodex: async (input) => {
          agentPrompt = input.prompt;
          return {
            ok: true as const,
            durationMs: 0,
            data: { slots: [{ index: 1, imageUrl: "https://news.example.com/cap.jpg", sourcePage: "https://news.example.com", alt: "방송 캡처", caption: "", license: "보도", reusePermission: "news_photo", rationale: "", skipped: false, skipReason: "", alternates: [] }] },
          };
        },
        fetchImage: async () => ({ ok: true, buffer: PNG, contentType: "image/png" }),
        readSize: () => ({ width: 1600, height: 900 }),
        chooseImage: async (input) => { seen = input; return { picked: 1, reason: "맞다", caption: "방송 캡처" }; },
        upload: async ({ fileName }) => ({ ok: true as const, url: `https://storage/${fileName}` }),
      }
    );
    const s = seen as ChooseImageInput | null;
    assert(s, "판정이 불려야 한다");
    assert(!s!.caution, `사용자 요구가 오면 기획 주의사항을 버려야 한다 (${s!.caution})`);
    assert(s!.broadcastCapture === true, "방송 화면 캡처 요청을 알아야 한다");
    assert(!queriesSeen.some((q) => q.includes("스틸컷") || q.includes("키노라이츠")), `기획 검색어로 찾으면 안 된다 (${queriesSeen.join(" / ")})`);
    assert(queriesSeen[0] === "이혼숙려캠프 자극부부", `검색어가 없으면 키워드 핵심으로 (${queriesSeen.join(" / ")})`);
    assert(!agentPrompt.includes("kinolights.example.com"), "방송 캡처 자리에는 공식 스틸을 후보로 넣지 않는다");
    assert(agentPrompt.includes("그 회차 방송 화면 캡처"), "수집 에이전트에도 방송 캡처를 지시한다");
    const cands = result.candidates?.[1] ?? [];
    assert(cands.length >= 1 && cands[0].url === "https://news.example.com/cap.jpg" && cands[0].picked, `후보가 기록되고 채택 표시 (${JSON.stringify(cands)})`);
    console.log("✅ 사용자 요구 - 기획 주의사항·검색어 폐기, 키워드 핵심 검색, 방송 캡처면 공식 스틸 제외, 후보 기록");
  }

  console.log("\n✅ 기획 대상 배선 테스트 전부 통과");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
