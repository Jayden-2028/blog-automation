// 기획 → 경로 배정 테스트(2026-10-02). 실행: npm run test:route-plan
//
// 지켜야 할 것: 자리 하나는 정확히 한 경로로 간다. 특히 예전에 빠졌던 두 갈래 -
//   ① 기획이 ai·infographic으로 정한 자리 → 생성 목록에 들어간다(전에는 아무 데도 안 갔다)
//   ② 기획에 없는 자리 → 집필자 마커대로 간다(전에는 아무 데도 안 갔다)
import { routeImagePlan, validateInfographicPrompt } from "./routeImagePlan.js";
import type { ImagePlan } from "./planImageSlots.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const BODY = [
  "특검은 오세훈 서울시장에게 징역 1년 6개월을 구형했습니다.",
  "[IMAGE: 서울고등법원 청사 외관 — 웹 검색]\n[IMAGE PROMPT: 서울고등법원 청사]",
  "여론조사 10건 비용을 김한정 씨가 대신 냈다는 혐의입니다.",
  "[IMAGE: 전화 여론조사 콜센터 — 웹 검색]\n[IMAGE PROMPT: 여론조사 콜센터]",
  "벌금 100만 원 이상이 확정되면 시장직을 잃습니다.",
  "[IMAGE: 시장직 상실 기준 기사 화면 — 페이지 캡처]\n[IMAGE PROMPT: https://view.asiae.co.kr/article/1]",
  "1심은 벌금 1000만 원이었습니다.",
  "[IMAGE: 1심 선고 — 웹 검색]\n[IMAGE PROMPT: 오세훈 1심]",
  "신청은 정부24에서 합니다.",
  "[IMAGE: 신청 안내 페이지 — 페이지 캡처]\n[IMAGE PROMPT: https://www.gov.kr/portal/1]",
  "현장 분위기입니다.",
  "[IMAGE: 법원 앞 취재진 — AI 생성]\n[IMAGE PROMPT: photorealistic photograph of reporters in Korea, no text, no letters, 16:9]",
].join("\n\n");

const INFOGRAPHIC =
  '"정치자금법 위반" 처벌 흐름 인포그래픽. 아이콘 3개와 화살표: "벌금 100만 원 이상 확정" → "피선거권 상실" → "시장직 상실". 위에 적은 글자 외에는 넣지 마. 16:9';

const PLAN: ImagePlan = {
  summary: "오세훈 2심 징역 1년 6개월 구형",
  protagonist: "오세훈 서울시장",
  slots: [
    { index: 1, subject: "오세훈 서울시장", queries: ["오세훈 서울시장"], acquisition: "search", changed: true, reason: "R9", caution: "", recency: "today" },
    { index: 2, subject: "명태균 오세훈 김한정", queries: ["명태균 오세훈 김한정", "김한정"], acquisition: "search", changed: true, reason: "R11", caution: "" },
    { index: 3, subject: "정치자금법 위반 처벌 흐름", queries: [INFOGRAPHIC], acquisition: "infographic", changed: true, reason: "법률 기준", caution: "" },
    { index: 4, subject: "AI 장면", queries: ["오세훈 1심 사진"], acquisition: "ai", changed: true, reason: "검증 실패 예", caution: "" },
    // 5·6번은 기획에 없다 → 집필자 마커대로.
  ],
};

async function main(): Promise<void> {
  console.log("▶ 기획 경로 배정 테스트 시작\n");
  const route = routeImagePlan(PLAN, BODY, []);

  // 1) 웹 검색: 기획 search 자리 + 기획에 없는 search 마커는 없음(5는 capture, 6은 ai).
  assert(JSON.stringify(route.searchIndexes) === "[1,2]", `웹 검색 자리 (${JSON.stringify(route.searchIndexes)})`);
  assert(route.queries[2][0] === "명태균 오세훈 김한정", "기획 검색어");
  assert(route.subjects[1].subject === "오세훈 서울시장" && route.subjects[1].recency === "today", "대상과 최신성");
  console.log("✅ 웹 검색 - 기획 자리 + 대상·최신성");

  // 2) 기획에 없는 캡처 마커는 마커대로 캡처한다(언론사 거르기는 캡처 단계가 한다).
  assert(route.captureUrls[5] === "https://www.gov.kr/portal/1", `기획 밖 캡처 마커가 실려야 한다 (${JSON.stringify(route.captureUrls)})`);
  console.log("✅ 기획에 없는 자리 - 집필자 마커대로");

  // 3) 기획 infographic → 생성 목록, 방식 유지(인포그래픽 화질로 뽑아야 한다).
  const info = route.generate.find((g) => g.index === 3);
  assert(info && info.acquisition === "infographic" && info.prompt === INFOGRAPHIC, `인포그래픽이 생성 목록에 (${JSON.stringify(route.generate)})`);
  console.log("✅ 기획 인포그래픽 → 생성 목록");

  // 4) 프롬프트가 규격 밖이면(검색어가 들어옴) 생성하지 않고 사유를 남긴다 - 유료 생성 낭비 방지.
  assert(!route.generate.some((g) => g.index === 4), "검증 실패한 AI 프롬프트는 생성하지 않는다");
  assert(route.notes.some((n) => n.includes("[자리 4]")), "사유가 남아야 한다");
  console.log("✅ 규격 밖 프롬프트 - 생성 안 함 + 기록");

  // 5) 집필자 마커가 이미 ai인 자리를 기획도 ai로 두면 두 번 만들지 않는다.
  const twice = routeImagePlan(
    { ...PLAN, slots: [{ index: 6, subject: "취재진", queries: ["photorealistic photograph, no text, 16:9"], acquisition: "ai", changed: false, reason: "", caution: "" }] },
    BODY,
    []
  );
  assert(twice.generate.length === 0, "마커가 이미 ai면 첫 생성 단계에 맡긴다");
  console.log("✅ 중복 생성 없음");

  // 7) 영어본(사용설명서): 한글 subject는 캡션으로 나가지 않는다(2026-10-08 실측 - 영어 글
  //    7자리 캡션이 전부 "…하는 장면"으로 발행됐다). 검색어·판정 기준은 그대로 살아 있어야 한다.
  const EN_BODY = [
    "Koreans use titles instead of first names.",
    "[IMAGE: Two friends greeting each other and talking in Korea — 웹 검색]\n[IMAGE PROMPT: 한국 친구 인사]",
    "At home, siblings speak differently.",
    // 기획이 `웹 검색` 자리를 AI 생성으로 바꾼 경우 - 이때만 route.generate가 캡션을 정한다
    // (마커와 기획이 같은 방식이면 첫 생성 단계가 마커 설명을 그대로 쓴다).
    "[IMAGE: Siblings talking together in a Korean home — 웹 검색]\n[IMAGE PROMPT: 한국 가정 남매]",
  ].join("\n\n");
  const EN_PLAN: ImagePlan = {
    summary: "한국어 호칭",
    protagonist: "호칭",
    slots: [
      { index: 1, subject: "한국에서 두 친구가 인사하며 대화하는 장면", queries: ["한국 친구 인사"], acquisition: "search", recency: "any", changed: true, reason: "", caution: "실내 사진은 피한다" },
      {
        index: 2,
        subject: "한국 가정에서 남매가 이야기하는 장면",
        queries: ["photorealistic photograph of siblings talking in a Korean home, no text, no letters, 16:9"],
        acquisition: "ai",
        changed: true,
        reason: "",
        caution: "",
      },
    ],
  };
  const en = routeImagePlan(EN_PLAN, EN_BODY, [], { captionLanguage: "en" });
  assert(en.subjects[1].subject === "", `영어본에서 한글 subject는 캡션으로 쓰지 않는다 (${JSON.stringify(en.subjects[1])})`);
  assert(
    en.subjects[1].caution?.includes("한국에서 두 친구가") && en.subjects[1].caution?.includes("실내 사진은 피한다"),
    `찾을 대상과 기존 주의사항이 판정 기준에 남아야 한다 (${en.subjects[1].caution})`
  );
  assert(en.queries[1][0] === "한국 친구 인사", "검색어는 한국어 그대로 간다");
  const enGen = en.generate.find((g) => g.index === 2);
  assert(
    enGen?.description === "Siblings talking together in a Korean home",
    `생성 자리 캡션은 영어 마커 설명을 쓴다 (${enGen?.description})`
  );
  // 같은 기획을 한글 원고로 돌리면 예전 그대로다(회귀 방지).
  const ko = routeImagePlan(EN_PLAN, EN_BODY, []);
  assert(ko.subjects[1].subject === "한국에서 두 친구가 인사하며 대화하는 장면", "한글 원고는 subject를 그대로 쓴다");
  assert(ko.generate.find((g) => g.index === 2)?.description === "한국 가정에서 남매가 이야기하는 장면", "한글 원고 생성 캡션은 subject");
  // 영어 subject는 영어본에서도 캡션으로 쓴다(기획이 지시대로 영어로 썼을 때).
  const enSubject = routeImagePlan(
    { ...EN_PLAN, slots: [{ ...EN_PLAN.slots[0], subject: "Two friends greeting on a Seoul street" }] },
    EN_BODY,
    [],
    { captionLanguage: "en" }
  );
  assert(enSubject.subjects[1].subject === "Two friends greeting on a Seoul street", "영어 subject는 그대로 쓴다");
  console.log("✅ 영어본 - 한글 대상은 판정 기준으로만, 캡션은 영어");

  // 6) 인포그래픽 검증.
  assert(validateInfographicPrompt(INFOGRAPHIC) === null, "정상 프롬프트는 통과");
  assert(validateInfographicPrompt("정치자금법 위반 처벌 기준") !== null, "검색어 한 줄은 거부");
  assert(validateInfographicPrompt(INFOGRAPHIC.replace("16:9", "")) !== null, "비율 없으면 거부");
  console.log("✅ 인포그래픽 프롬프트 검증");

  console.log("\n✅ 기획 경로 배정 테스트 전부 통과");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
