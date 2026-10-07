// 이미지 기획 단계 테스트. 실행: npm run test:image-plan
//
// 지켜야 할 것: ① 프롬프트에 판단에 필요한 입력이 전부 들어간다(날짜·문단·힌트·리서치)
// ② 모델 응답이 어긋나도 파이프라인을 깨뜨리지 않는다 ③ 실패하면 집필자 마커로 돈다(fail-open)
// ④ 바뀐 자리만 사람이 읽는 기록으로 남는다.
//
// 실제 모델은 부르지 않는다 - `run`을 주입해 입출력 계약만 본다.
import {
  buildPlanPrompt,
  collectPlanSlots,
  describePlan,
  parsePlan,
  planImageSlots,
} from "./planImageSlots.js";
import type { ImagePlan, PlanImageSlotsInput } from "./planImageSlots.js";
import { isPressUrl } from "./pressDomains.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const BODY = [
  "넷플릭스 대환장 기안장 시즌2에 덱스가 9~10회 알바생으로 합류합니다.",
  "[IMAGE: 대관령 민박집의 기안84와 직원들 — 웹 검색]\n[IMAGE PROMPT: 대환장 기안장2 스틸컷]",
  "**덱스 알바생 합류**\n덱스는 기안84의 절친입니다.",
  "[IMAGE: 기안84 옆에서 일손을 돕는 덱스 — 웹 검색]\n[IMAGE PROMPT: 덱스 기안84]",
].join("\n\n");

const INPUT: PlanImageSlotsInput = {
  keyword: "대환장 기안장2 덱스 알바생 합류",
  category: "entertainment",
  body: BODY,
  imagePrompts: [],
  today: "2026-10-02",
  researchText: "## 11. 캡처할 페이지\n- https://example.com/news/1",
};

const GOOD_PLAN = {
  summary: "덱스가 기안장2 9~10회 알바생으로 합류한다",
  protagonist: "덱스",
  slots: [
    { index: 1, subject: "기안장2 공식 스틸", queries: ["대환장 기안장2 스틸컷"], acquisition: "search", changed: false, reason: "그대로 둔다", caution: "" },
    {
      index: 2,
      subject: "덱스 단독 공개 사진",
      queries: ["덱스 프로필", "덱스 예능"],
      acquisition: "search",
      changed: true,
      reason: "9~10회가 아직 방영 전이라 그 장면 사진은 존재하지 않는다",
      caution: "주인공이라 반드시 한 장은 있어야 한다",
    },
  ],
};

async function main(): Promise<void> {
  console.log("▶ 이미지 기획 단계 테스트 시작\n");

  // 1) 자리 수집 - 꼬리를 뗀 힌트와 바로 위 문단이 붙는다.
  {
    const slots = collectPlanSlots(BODY, []);
    assert(slots.length === 2, `자리 2개여야 한다 (${slots.length})`);
    assert(!slots[0].hint.includes("웹 검색"), `힌트에서 꼬리를 떼야 한다 (${slots[0].hint})`);
    assert(slots[1].context.includes("절친"), "바로 위 문단이 붙어야 한다");
    assert(slots[1].hintQuery === "덱스 기안84", "집필자 검색어를 참고용으로 넘겨야 한다");
    console.log("✅ 자리 수집 - 꼬리 제거 + 문단 + 집필자 힌트");
  }

  // 2) 프롬프트에 판단 재료가 전부 들어간다. 하나라도 빠지면 기획이 추측하게 된다.
  {
    const prompt = buildPlanPrompt(INPUT, null);
    for (const must of [
      "2026-10-02", // 시점 검증(R3)에 필수
      "덱스는 기안84의 절친입니다", // 문단
      "기안84 옆에서 일손을 돕는 덱스", // 집필자 힌트
      "https://example.com/news/1", // 리서치의 캡처 URL
      "R3", // 규칙이 실려야 한다
      "R7",
    ]) {
      assert(prompt.includes(must), `프롬프트에 "${must}"가 있어야 한다`);
    }
    assert(prompt.includes("자리는 2개다"), "자리 수를 못 박아야 한다");
    console.log("✅ 프롬프트 - 날짜·문단·힌트·리서치·규칙이 전부 실린다");
  }

  // 3) 정상 응답 파싱.
  {
    const { plan } = parsePlan(GOOD_PLAN, 2);
    assert(plan, "정상 응답은 기획이 나와야 한다");
    assert(plan!.protagonist === "덱스", "주인공을 읽어야 한다");
    assert(plan!.slots[1].queries.length === 2, "검색어를 읽어야 한다");
    console.log("✅ 정상 응답 파싱");
  }

  // 4) 어긋난 응답은 버리되 나머지는 살린다. 모델은 통제할 수 없으니 전부 받아 낸다.
  {
    const { plan, notes } = parsePlan(
      {
        summary: "요약",
        slots: [
          { index: 99, queries: ["범위 밖"] },
          { index: 1, subject: "정상", queries: ["검색어"], acquisition: "웹검색" },
          { index: 1, subject: "중복", queries: ["중복"] },
          "문자열",
        ],
      },
      2
    );
    assert(plan, "일부가 어긋나도 나머지는 살아야 한다");
    assert(plan!.slots.length === 1, `쓸 수 있는 자리 1개여야 한다 (${plan!.slots.length})`);
    assert(plan!.slots[0].acquisition === "search", "모르는 획득 방식은 웹 검색으로 둬야 한다");
    assert(notes.some((n) => n.includes("범위를 벗어나")), "버린 이유가 기록돼야 한다");
    assert(notes.some((n) => n.includes("두 번 나와")), "중복도 기록돼야 한다");
    console.log("✅ 어긋난 응답 - 버리되 사유를 남기고 나머지는 살린다");
  }

  // 5) 쓸 자리가 하나도 없으면 null. 호출자가 집필자 마커로 돌아간다.
  {
    const { plan } = parsePlan({ slots: [] }, 2);
    assert(plan === null, "쓸 자리가 없으면 null이어야 한다");
    console.log("✅ 쓸 자리 없음 - null");
  }

  // 6) 모델 실행이 실패해도 터지지 않는다(fail-open).
  {
    const out = await planImageSlots(INPUT, { run: async () => ({ ok: false, error: "타임아웃" }), spec: null });
    assert(out.plan === null, "실패하면 기획이 없어야 한다");
    assert(out.notes.some((n) => n.includes("원고 마커로 진행")), `기록이 남아야 한다 (${out.notes.join(" / ")})`);
    console.log("✅ 실행 실패 - fail-open + 기록");
  }

  // 7) 예외를 던져도 같다.
  {
    const out = await planImageSlots(INPUT, { run: async () => { throw new Error("끊김"); }, spec: null });
    assert(out.plan === null && out.notes.length > 0, "예외도 기록으로 바꿔야 한다");
    console.log("✅ 예외 - fail-open");
  }

  // 8) 끝에서 끝까지. JSON이 설명 뒤에 붙어도 읽어야 한다.
  {
    const out = await planImageSlots(INPUT, {
      run: async () => ({ ok: true, output: `설명을 늘어놓고\n${JSON.stringify(GOOD_PLAN)}` }),
      spec: null,
    });
    assert(out.plan, "JSON이 뒤에 붙어도 읽어야 한다");
    assert(out.plan!.slots[1].queries[0] === "덱스 프로필", "바뀐 검색어가 나와야 한다");
    console.log("✅ 종단 - 설명 뒤의 JSON도 읽는다");
  }

  // 9) 사람이 읽는 기록은 **바뀐 자리만**. 전부 적으면 읽히지 않는다.
  {
    const notes = describePlan(GOOD_PLAN as unknown as ImagePlan);
    assert(notes.some((n) => n.includes("한 줄은")), "한 줄 요약이 기록돼야 한다");
    const slotNotes = notes.filter((n) => n.startsWith("[자리 "));
    assert(slotNotes.length === 1, `바뀐 자리 1개만 기록돼야 한다 (${slotNotes.length})`);
    assert(slotNotes[0].includes("자리 2"), "바뀐 것은 2번이다");
    assert(slotNotes[0].includes("방영 전"), "왜 바꿨는지가 들어가야 한다");
    console.log("✅ 기록 - 바뀐 자리만, 사유와 함께");
  }

  // 10) 기획이 언론사 기사 캡처를 골라도 웹 검색(주인공)으로 돌린다(2026-10-02 사용자 결정).
  {
    const { plan, notes } = parsePlan(
      {
        summary: "오세훈 2심 구형",
        protagonist: "오세훈 서울시장",
        slots: [
          { index: 1, subject: "YTN 기사 화면", queries: ["https://www.ytn.co.kr/_ln/0103_1"], acquisition: "capture" },
          { index: 2, subject: "신청 안내", queries: ["https://www.gov.kr/portal/1"], acquisition: "capture" },
        ],
      },
      2
    );
    assert(plan, "기획이 나와야 한다");
    assert(plan!.slots[0].acquisition === "search", "기사 캡처는 웹 검색으로 돌려야 한다");
    assert(plan!.slots[0].queries[0] === "오세훈 서울시장", "검색어는 주인공이어야 한다");
    assert(plan!.slots[0].changed, "바뀐 것으로 기록돼야 한다");
    assert(plan!.slots[1].acquisition === "capture", "공공 페이지 캡처는 그대로 둔다");
    assert(notes.some((n) => n.includes("언론사 기사 화면")), "사유가 기록돼야 한다");
    assert(buildPlanPrompt(INPUT, null).includes("언론사 기사 화면·헤드라인은 캡처하지 않는다"), "프롬프트에 금지가 실려야 한다");
    console.log("✅ 기사 캡처 → 주인공 웹 검색으로 강등, 공공 캡처는 유지");
  }

  // 11) 언론사 판별 - 하위 도메인·포털 뉴스·이름 규칙, 공공은 예외.
  {
    for (const url of [
      "https://view.asiae.co.kr/article/1",
      "https://www.hankookilbo.com/news/article/A1",
      "https://n.news.naver.com/article/001/1",
      "https://v.daum.net/v/1",
      "https://www.somenewsdaily.com/a/1",
    ]) {
      assert(isPressUrl(url), `언론사로 봐야 한다: ${url}`);
    }
    for (const url of [
      "https://www.korea.kr/news/policyNewsView.do?newsId=1",
      "https://news.seoul.go.kr/welfare/1",
      "https://gift.kakao.com/page/1",
      "https://www.kinolights.com/title/1",
      "주소 아님",
    ]) {
      assert(!isPressUrl(url), `언론사로 보면 안 된다: ${url}`);
    }
    console.log("✅ 언론사 판별 - 포털·하위 도메인 차단, 공공·공식 페이지 통과");
  }

  // 12) 오세훈 2심 규칙(R9~R11)과 사용자 원칙이 프롬프트에 실린다. 인포그래픽은 법률까지.
  {
    const prompt = buildPlanPrompt(INPUT, null);
    for (const must of ["무엇에 관한 것인지", "R9", "R10", "R11", "건물·청사 외관", "보호 대상은 예외", "법률·혐의·처벌 기준", "recency"]) {
      assert(prompt.includes(must), `프롬프트에 "${must}"가 있어야 한다`);
    }
    console.log("✅ 프롬프트 - 원칙 + R9~R11 + 인포그래픽 법률 + 최신성");
  }

  // 13) 최신성 파싱 - 모르는 값은 any.
  {
    const { plan } = parsePlan(
      { slots: [{ index: 1, subject: "a", queries: ["a"], recency: "today" }, { index: 2, subject: "b", queries: ["b"], recency: "어제" }] },
      2
    );
    assert(plan!.slots[0].recency === "today", "today는 그대로");
    assert(plan!.slots[1].recency === "any", "모르는 값은 any");
    console.log("✅ 최신성 파싱");
  }

  // 14) 이혼숙려캠프(2026-10-02) - 방송 출연자는 보호 대상이 아니고, MC는 주인공이 아니다.
  {
    const prompt = buildPlanPrompt(INPUT, null);
    for (const must of ["방송에 얼굴을 공개하고 출연한 사람은 보호 대상이 아니다", "R12", "MC·진행자·패널", "이혼숙려캠프 자극부부"]) {
      assert(prompt.includes(must), `프롬프트에 "${must}"가 있어야 한다`);
    }
    console.log("✅ 프롬프트 - 방송 출연자 비보호 + R12(주인공은 키워드 대상, MC 아님)");
  }

  // 사용설명서 영어본: `subject`가 캡션·alt가 되므로 영어로 쓰라고 지시한다(2026-10-08).
  // 검색어는 한국어 그대로여야 한다 - 한국 소재는 한국어 검색이 잘 찾는다.
  {
    const en = buildPlanPrompt({ ...INPUT, subjectLanguage: "en" }, null);
    assert(en.includes("`subject`(찾을 대상)는 반드시 영어로 쓴다"), "영어본은 대상을 영어로 쓰라고 지시해야 한다");
    assert(en.includes("`queries`(검색어)는 평소대로"), "검색어는 평소대로라고 알려야 한다");
    assert(!buildPlanPrompt(INPUT, null).includes("반드시 영어로 쓴다"), "한글 원고에는 영어 지시가 붙지 않아야 한다");
    console.log("✅ 프롬프트 - 영어본은 대상만 영어(검색어는 그대로)");
  }

  console.log("\n✅ 이미지 기획 단계 테스트 전부 통과");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
