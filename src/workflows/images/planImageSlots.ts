// 이미지 기획 단계 — 자리마다 "실제로 무엇을 보여줄지"와 검색어를 다시 정한다.
//
// 설계: `docs/ai-handoff/IMAGE_PLANNING_DESIGN.md` (A안, 2026-10-01 사용자 결정)
// 드라이런 10건: `docs/ai-handoff/IMAGE_PLANNING_DRYRUN.md`
//
// **왜 필요한가.** 집필자는 검색 결과를 **보기 전에** 설명·검색어·획득 방식을 전부 정했다.
// 수집기는 그 지시를 실행만 했다. 둘 사이에 "이 지시가 맞는가"를 묻는 단계가 없었다.
//
// 실측 두 건(2026-10-01):
//   · 기안장2 — 자리 6개 중 2개만 찼다. 원고 메인이 "덱스 합류"인데 **덱스가 한 장도 없다.**
//     그 회차가 방영 전이라 "기안84 옆에서 일손 돕는 덱스" 사진은 세상에 존재하지 않는다.
//   · 폭설 — 원고 한 줄은 "예고편 공개"인데 1번 마커는 포스터였다. 게다가 동명 작품이 있어
//     배우명 없이는 다른 작품이 섞인다.
//
// **이 단계는 LLM을 원고당 한 번 부른다.** 자리를 하나씩 부르지 않는 이유는, 원고 전체를 봐야
// "한 줄 요약"과 "주인공"이 정해지기 때문이다(R1·R4).
//
// **실패해도 파이프라인을 멈추지 않는다**(fail-open). 기획이 안 되면 집필자 마커로 그대로 돈다 -
// 이미지가 통째로 사라지는 것보다 낫다.

import { runHeadlessClaude } from "../../services/llm/runHeadlessClaude.js";
import { extractTrailingJson } from "../../services/llm/runHeadlessCodex.js";
import { parseManuscriptBlocks } from "../manuscripts/parseManuscriptBlocks.js";
import { stripAcquisitionSuffix } from "../manuscripts/parseManuscriptBlocks.js";
import { imageMakerSpecLines } from "./imageMakerSpec.js";
import { isPressUrl } from "./pressDomains.js";
import { groupShotsAllowed } from "../../config/imageGroupShots.js";

/** 기획이 정할 수 있는 획득 방식. `table`은 폐지됐고 기획이 고르지 않는다. */
export const PLANNABLE_ACQUISITIONS = ["search", "capture", "ai", "infographic"] as const;
export type PlannedAcquisition = (typeof PLANNABLE_ACQUISITIONS)[number];

export type ImageSlotPlan = {
  /** 본문 마커 순서(1부터). 집필자 마커와 같은 번호다. */
  index: number;
  /** 이 자리가 실제로 보여줄 것. 캡션이 아니라 **찾을 대상**이다. */
  subject: string;
  /** 검색어. 앞에서부터 쓴다. `capture`면 URL 하나만 넣는다. */
  queries: string[];
  acquisition: PlannedAcquisition;
  /** 집필자 마커에서 바꿨는가. 사람이 훑을 때 바뀐 자리만 보게 한다. */
  changed: boolean;
  /** 왜 바꿨는지(또는 왜 그대로 뒀는지). 사람이 읽는 값이다. */
  reason: string;
  /** 주의할 점(중의성·시점 등). 없으면 빈 문자열. */
  caution: string;
  /**
   * 사진이 얼마나 최근 것이어야 하나(2026-10-02, 오세훈 2심 피드백 "10/2일자 이미지들이 후보").
   * `today`·`recent`면 수집이 날짜순 검색을 한 번 더 돌려 후보에 섞는다. 모르면 `any`.
   * 선택값인 이유: 이 필드 이전에 저장된 기획(job.metadata.imagePlan)에는 없다.
   */
  recency?: Recency;
};

export const RECENCIES = ["today", "recent", "any"] as const;
export type Recency = (typeof RECENCIES)[number];

export type ImagePlan = {
  /** 원고를 한 줄로 요약한 것. 1번 자리가 이걸 보여줘야 한다(R1). */
  summary: string;
  /** 원고의 주인공(사람·작품). 비어 있으면 검사하지 않는다(R4). */
  protagonist: string;
  slots: ImageSlotPlan[];
};

export type PlanImageSlotsInput = {
  keyword: string;
  category: string | null;
  body: string;
  imagePrompts: string[];
  /** 오늘 날짜(YYYY-MM-DD). **시점 판단(R3)에 반드시 필요하다.** */
  today: string;
  /** 리서치 파일 전문. `## 11. 캡처할 페이지`의 URL을 기획이 쓴다. */
  researchText?: string | null;
  /**
   * `subject`를 쓸 언어. 사용설명서 영어본은 "en" - subject가 생성 이미지 캡션·alt의 바탕이 돼
   * 독자에게 그대로 보인다(2026-10-08 실측: 기획 subject가 한글이라 영어 글 캡션이 전부 한글로 나갔다).
   * 검색어(queries)는 영향 없다 - 한국 소재는 한국어 검색이 잘 찾는다.
   */
  subjectLanguage?: "ko" | "en";
};

export type PlanImageSlotsOptions = {
  /** 테스트 주입 지점. 기본은 헤드리스 Claude. */
  run?: (prompt: string) => Promise<{ ok: true; output: string } | { ok: false; error: string }>;
  /** 규격 본문. 생략하면 파일에서 읽는다. */
  spec?: string | null;
};

export type PlanImageSlotsResult = {
  plan: ImagePlan | null;
  /** 사람이 읽는 기록. 수집 기록(imageNotes)에 그대로 실린다. */
  notes: string[];
};

const PLAN_SCHEMA_HINT = `{"summary":"한 줄 요약","protagonist":"주인공","slots":[{"index":1,"subject":"찾을 대상","queries":["검색어"],"acquisition":"search","recency":"any","changed":true,"reason":"왜 바꿨는지","caution":""}]}`;

/** 자리별 입력(마커 설명 + 바로 위 문단). 프롬프트에 그대로 들어간다. */
export function collectPlanSlots(
  body: string,
  imagePrompts: string[]
): { index: number; hint: string; hintQuery: string | null; context: string }[] {
  const blocks = parseManuscriptBlocks(body, imagePrompts);
  const slots: { index: number; hint: string; hintQuery: string | null; context: string }[] = [];
  let index = 0;
  let lastText = "";

  for (const block of blocks) {
    if (block.type === "image") {
      index += 1;
      slots.push({
        index,
        // 꼬리는 떼어 넘긴다 - 획득 방식은 기획이 정한다(A안). 집필자가 적어 둔 것은 힌트일 뿐이다.
        hint: stripAcquisitionSuffix(block.description),
        hintQuery: block.prompt,
        context: lastText,
      });
      continue;
    }
    lastText = block.type === "heading" ? `${block.heading}\n${block.body}` : block.content;
  }
  return slots;
}

/**
 * R7 - 여러 인물을 한 자리에 요구해도 되나(2026-10-02 사용자 결정으로 **기본은 허용**).
 * 옛 R7("두 인물을 동시에 요구하지 않는다")이 "한 명짜리로 넘어간다"는 기획을 만들었고, 영상물에서는
 * 배우 2샷·단체샷이 흔해 오히려 손해였다. `IMAGE_GROUP_SHOTS=false`면 옛 문구로 돌아간다.
 */
export function r7Lines(allowed: boolean): string[] {
  if (allowed) {
    return [
      "**R7. 함께 나오는 인물은 함께 찾는다.** 드라마·영화·OTT·예능·방송은 배우 2샷·단체샷이 많다.",
      "문단이 여러 사람을 말하면 `queries` 첫째는 **작품명 + 인물들**로 묶고, 둘째에 한 명짜리를 둔다.",
      "단체 사진·2샷·합성컷을 피하라는 `caution`을 쓰지 않는다(2026-10-02 폐지).",
      "  (O) `유일무이 로맨스 박수영 김현진` → 둘째 `유일무이 로맨스 박수영`",
      "",
    ];
  }
  return [
      "**R7. 두 인물을 한 자리에 동시에 요구하지 않는다.** 함께 찍힌 사진은 특정 행사뿐이라 거의 없다.",
      "한 명씩 쪼개고 작품명을 붙인다.",
      "  (X) `박수영 김현진`  (O) `유일무이 로맨스 박수영`",
      "",
  ];
}

export function buildPlanPrompt(input: PlanImageSlotsInput, spec?: string | null): string {
  const slots = collectPlanSlots(input.body, input.imagePrompts);
  const lines = [
    ...imageMakerSpecLines(spec === undefined ? undefined : spec),
    "너는 한국어 블로그 원고의 **이미지 기획자**다. 자리마다 **무엇을 찾을지와 검색어**를 정한다.",
    "이미지를 만들지 않고, 검색도 하지 않는다. 기획만 한다.",
    ...(input.subjectLanguage === "en"
      ? [
          "",
          "**이 원고는 영어 블로그 발행본이다. `subject`(찾을 대상)는 반드시 영어로 쓴다** - subject가",
          "생성 이미지의 캡션·alt로 독자에게 그대로 보인다. `queries`(검색어)는 평소대로 가장 잘 찾히는",
          "언어로 쓴다(한국 소재는 한국어 검색이 잘 찾는다).",
        ]
      : []),
    "",
    `원고 주제: ${input.keyword}`,
    `카테고리: ${input.category ?? "미분류"}`,
    `**오늘 날짜: ${input.today}**`,
    "",
    "## 먼저 할 일",
    "1. 원고를 읽고 **한 줄로 요약**한다(`summary`). 예: \"영화 폭설 1차 예고편 공개\".",
    "2. 이 글의 **주인공**을 한 명(또는 한 작품) 고른다(`protagonist`).",
    "",
    "## 가장 먼저 — 이미지는 문단이 **무엇에 관한 것인지**만 보여주면 된다",
    "문단의 모든 내용(형량·날짜·쟁점·절차)을 한 장에 담으려 하지 않는다(2026-10-02 사용자 원칙).",
    "그렇게 하면 건물 외관·콜센터 일반 장면·기사 화면처럼 **내용은 다 담았는데 아무것도 안 보이는** 그림이 된다.",
    "",
    "## 자리마다 지킬 것",
    "",
    "**R9. 문단을 키워드 하나로 줄이고, 그 키워드가 대상이다.** 키워드에 사람이 있으면 **사람이 대상**이다.",
    "  문단: \"특검은 서울고법 항소심에서 오세훈 서울시장에게 징역 1년 6개월을 구형했다\"",
    "  (X) `서울고등법원 청사 외관`  →  문단의 키워드가 아니다",
    "  (O) `오세훈 서울시장`        →  이 문단은 오세훈 시장에 관한 것이다",
    "",
    "**R10. 건물·청사 외관으로 대역하지 않는다.** 법원·검찰·시청 청사는 **건물 자체가 쟁점일 때만** 쓴다.",
    "\"어디서 열렸다\"는 사진이 필요한 정보가 아니다.",
    "",
    "**R11. 공인 사건에서는 당사자를 보여준다.** 정치인·고위공직자·기업인·연예인의 **공적 활동과 사건**은",
    "실명과 얼굴이 이미 보도된 사람들이라 **당사자 실사진**을 쓴다. AI 일반 장면(콜센터·법정 일러스트)으로",
    "바꾸지 않는다 - 그건 보호가 아니라 내용과 무관한 장식이다. 당사자가 여럿이면 **이름을 묶어** 먼저 찾는다.",
    "  (X) `전화 여론조사 콜센터` (AI)   (O) `명태균 오세훈 김한정`",
    "  한 사건으로 함께 보도된 당사자는 같은 기사 사진에 함께 나오는 경우가 많다.",
    "  그래도 `queries` 둘째에는 한 명짜리를 넣어 둔다.",
    "  **보호 대상은 예외다** - 피해자·미성년자·일반인 피의자·신원 비공개 인물은 실사진을 쓰지 않는다.",
    "  **그 자리는 비우지 않고 `ai`로 만든다**(누구인지 특정되지 않는 일반화된 장면). \"AI 일반 장면으로 바꾸지 않는다\"는",
    "  **공인** 사건 얘기다 - 보호 대상 자리에서는 AI가 기본이다(2026-10-03 대구 북구 실측: 민원인 항의 자리를",
    "  \"일반인이라 실사진 불가, AI는 장식\"이라며 비웠고, 사용자가 AI로 만들라고 두 번 요청해야 했다).",
    "  **방송에 얼굴을 공개하고 출연한 사람은 보호 대상이 아니다**(2026-10-02 사용자 결정). 예능·리얼리티·",
    "  다큐 출연자는 얼굴이 방송될 것에 동의하고 나왔다 - 그 방송 화면은 쓴다. 방송에서 모자이크된 사람만 예외.",
    "",
    "**R12. 주인공은 원고 키워드가 가리키는 대상이다.** MC·진행자·패널·심사위원은 주인공이 아니다.",
    "예능·리얼리티에서 키워드에 **사연 출연자의 별칭**(예: `자극부부`)이 있으면 그들이 주인공이고,",
    "검색어는 `<프로그램명> <별칭>`이다. 진행진 사진은 문단이 **진행진의 발언·반응**을 말할 때만 쓴다.",
    "사연 출연자 자리의 `subject`는 `<프로그램명> <별칭> 방송 화면`으로 쓴다 - 그 회차 방송 캡처(자막 포함)가",
    "실물이다. 공식 포스터·스틸은 그 사연을 보여주지 못한다.",
    "  키워드 `이혼숙려캠프 자극부부 남편 성적 폭언`",
    "  (X) 주인공 `서장훈·이동건·박하선`, 검색어 `이혼숙려캠프 박하선`   ← 진행진은 이 글의 주인공이 아니다",
    "  (O) 주인공 `자극부부`, 검색어 `이혼숙려캠프 자극부부`, 대상 `이혼숙려캠프 자극부부 방송 화면`",
    "",
    "**R1. 1번 자리는 한 줄 요약을 보여준다.** 요약이 \"예고편 공개\"면 1번은 예고편 장면이다 -",
    "포스터도 배우 프로필도 아니다.",
    "",
    "**R2. 중의성을 없앤다.** 작품·인물명이 흔하면 **배우명·연도·장르**를 검색어에 붙인다.",
    "  (X) `폭설 예고편`  →  동명 작품이 섞인다",
    "  (O) `영화 폭설 김윤석 구교환 예고편`",
    "",
    "**R3. 시점을 검증한다.** 오늘 날짜 기준으로 **아직 일어나지 않은 장면은 존재하지 않는다.**",
    "방영 전 회차, 개봉 전 장면, 예정된 행사 현장이 그렇다. 그때는 **대상을 바꾼다.**",
    "  (X) `기안84 옆에서 일손을 돕는 덱스`  →  방영 전이라 없다",
    "  (O) `덱스 프로필` / `덱스 예능`      →  출연 발표 맥락에서 쓸 수 있다",
    "",
    "**R4. 주인공을 지킨다.** 주인공이 **전체 이미지에 한 번도 없으면 그 원고는 실패다.**",
    "최소 한 자리는 주인공 단독 사진으로 잡는다.",
    "",
    "**R5. 검색어는 이름 2~4단어.** 장면을 서술하지 않는다. **회차(1차/2차/3차)를 넣지 않는다** -",
    "회차를 넣으면 자막이 박힌 티저 썸네일이 올라온다.",
    "",
    "**R6. 비우느니 대상을 바꾼다.** 단, 바꾼 대상이 문단과 무관하면 그때는 비운다(`queries`를 빈 배열로).",
    "",
    ...r7Lines(groupShotsAllowed()),
    "**R8. 부제·채널명·시즌 표기를 뺀다.** 길수록 영상 썸네일이 올라온다.",
    "  (X) `닥터X 하얀 마피아의 시대 스틸컷`  (O) `닥터X 김지원`",
    "",
    "## 획득 방식 고르기",
    "- `search` — 이미 찍힌 사진으로 되는 자리(대부분 여기다)",
    "- `capture` — 그 페이지를 보여주는 것이 답인 자리. **리서치에 있는 URL만** 쓴다. 지어내지 않는다.",
    "  공공기관·공식 홈페이지·예매·순위 페이지만 해당한다. **언론사 기사 화면·헤드라인은 캡처하지 않는다**",
    "  (2026-10-02 사용자 결정 - 남발돼서 폐지). 기사 화면을 떠올렸다면 그 문단의 인물·대상을 `search`로 찾는다.",
    "- `ai` — 위 둘이 전부 불가능할 때만. 실존 인물·작품·제품은 AI로 만들지 않는다.",
    "  `queries[0]`에 **바로 생성에 넣을 영어 프롬프트**를 쓴다: `photorealistic photograph`로 시작,",
    "  한국 배경(`in Korea`), `no text, no letters`, 끝에 `16:9`. 한글을 섞지 않는다.",
    "- `infographic` — 행사·정책의 절차·조건·금액, 그리고 **법률·혐의·처벌 기준**(혐의 구조, 형량 구간,",
    "  \"벌금 100만 원 이상 → 직 상실\" 같은 흐름)을 아이콘·그래프로 보여줄 때. 본문 표를 옮기지 않는다.",
    "  `queries[0]`에 **바로 생성에 넣을 프롬프트 전체**를 쓴다(규격 §9):",
    "  · 들어갈 글자를 **전부 따옴표로** 적고 \"위에 적은 글자 외에는 넣지 마\"로 닫는다",
    "  · 글자는 라벨과 숫자까지만. 숫자는 **본문과 한 글자도 다르면 안 된다**",
    "  · 한글 라벨은 한글로. 픽토그램·화살표·막대 그래프. 끝에 `16:9`",
    "  예: `\"정치자금법 위반\" 처벌 흐름 인포그래픽. 왼쪽부터 아이콘 3개와 화살표: \"벌금 100만 원 이상 확정\" →",
    "  \"피선거권 상실\" → \"시장직 상실\". 아래 작은 라벨 \"5년간 피선거권 제한\". 위에 적은 글자 외에는 넣지 마.",
    "  흰 배경, 남색·회색 픽토그램, 16:9`",
    "",
    "## 최신성 (`recency`)",
    "- `today` — 오늘 일어난 일(구형·선고·발표·공개)의 당사자 자리. 오늘 찍힌 사진이 가장 좋다",
    "- `recent` — 최근 활동이 맞는 자리(현직 인물의 근황)",
    "- `any` — 프로필·작품 스틸처럼 시점이 상관없는 자리. 모르면 이것",
    "",
    "## 자리 목록",
  ];

  for (const slot of slots) {
    lines.push("");
    lines.push(`### 자리 ${slot.index}`);
    lines.push(`- 집필자 힌트: ${slot.hint}`);
    if (slot.hintQuery) lines.push(`- 집필자가 적어 둔 검색어(참고만): ${slot.hintQuery}`);
    lines.push("- 바로 위 문단:");
    lines.push(`  """${slot.context.slice(0, 600)}"""`);
  }

  if (input.researchText) {
    lines.push("", "## 리서치 파일(캡처할 URL은 여기 있는 것만 쓴다)");
    lines.push(`"""${input.researchText.slice(0, 6000)}"""`);
  }

  lines.push(
    "",
    "## 출력",
    "마지막 줄에 **JSON만** 출력한다. 설명을 덧붙이지 않는다.",
    PLAN_SCHEMA_HINT,
    "",
    `자리는 ${slots.length}개다. 전부 포함한다 - 비울 자리도 \`queries\`를 빈 배열로 두고 \`reason\`에 사유를 적는다.`,
    "`reason`과 `caution`은 **사람이 읽는다.** 한국어로 한 문장씩 쓴다."
  );

  return lines.join("\n");
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** 모델 응답을 검사해 쓸 수 있는 것만 남긴다. 어긋난 자리는 버리고 집필자 마커로 돈다. */
export function parsePlan(raw: unknown, slotCount: number): { plan: ImagePlan | null; notes: string[] } {
  const notes: string[] = [];
  if (!raw || typeof raw !== "object") return { plan: null, notes: ["이미지 기획: 응답을 읽지 못했습니다."] };

  const data = raw as Record<string, unknown>;
  const rawSlots = Array.isArray(data.slots) ? data.slots : [];
  const slots: ImageSlotPlan[] = [];

  for (const entry of rawSlots) {
    if (!entry || typeof entry !== "object") continue;
    const slot = entry as Record<string, unknown>;
    const index = Number(slot.index);
    if (!Number.isInteger(index) || index < 1 || index > slotCount) {
      notes.push(`이미지 기획: 자리 번호가 범위를 벗어나 버렸습니다(${String(slot.index)}).`);
      continue;
    }
    if (slots.some((s) => s.index === index)) {
      notes.push(`이미지 기획: 자리 ${index}가 두 번 나와 뒤엣것을 버렸습니다.`);
      continue;
    }

    const acquisitionRaw = asString(slot.acquisition) as PlannedAcquisition;
    const acquisition = PLANNABLE_ACQUISITIONS.includes(acquisitionRaw) ? acquisitionRaw : "search";
    if (acquisitionRaw && acquisition !== acquisitionRaw) {
      notes.push(`[자리 ${index}] 이미지 기획: 모르는 획득 방식 "${acquisitionRaw}" - 웹 검색으로 둡니다.`);
    }

    let queries = Array.isArray(slot.queries)
      ? slot.queries.map(asString).filter(Boolean).slice(0, 3)
      : [];

    // 언론사 기사 화면 캡처는 폐지됐다(2026-10-02). 규격에 적어도 모델이 고를 수 있으니 여기서
    // **웹 검색으로 돌린다**. 검색어는 주인공 - 사용자가 그런 자리마다 고른 대안이 전부 인물이었다
    // ("오세훈 1000만원", "오세훈 시장 활동"). 주인공이 없으면 비운다.
    let finalAcquisition: PlannedAcquisition = acquisition;
    if (acquisition === "capture" && queries[0] && isPressUrl(queries[0])) {
      const protagonist = asString(data.protagonist);
      finalAcquisition = "search";
      queries = protagonist ? [protagonist] : [];
      notes.push(
        `[자리 ${index}] 이미지 기획: 언론사 기사 화면 캡처는 쓰지 않습니다 - ` +
          (protagonist ? `웹 검색 "${protagonist}"로 돌립니다.` : "주인공이 없어 비웁니다.")
      );
    }

    slots.push({
      index,
      subject: asString(slot.subject),
      queries,
      acquisition: finalAcquisition,
      changed: slot.changed === true || finalAcquisition !== acquisition,
      reason: asString(slot.reason),
      caution: asString(slot.caution),
      recency: (RECENCIES as readonly string[]).includes(asString(slot.recency))
        ? (asString(slot.recency) as Recency)
        : "any",
    });
  }

  if (slots.length === 0) return { plan: null, notes: [...notes, "이미지 기획: 쓸 수 있는 자리가 없습니다."] };

  slots.sort((a, b) => a.index - b.index);
  const plan: ImagePlan = {
    summary: asString(data.summary),
    protagonist: asString(data.protagonist),
    slots,
  };

  if (slots.length < slotCount) {
    notes.push(`이미지 기획: 자리 ${slotCount}개 중 ${slots.length}개만 기획됐습니다 - 나머지는 원고 마커로 갑니다.`);
  }
  return { plan, notes };
}

/** 사람이 읽을 기록으로 바꾼다. 바뀐 자리만 남긴다 - 전부 적으면 읽히지 않는다. */
export function describePlan(plan: ImagePlan): string[] {
  const notes: string[] = [];
  if (plan.summary) notes.push(`ℹ️ 이미지 기획: 이 원고의 한 줄은 "${plan.summary}"입니다.`);
  for (const slot of plan.slots) {
    if (!slot.changed) continue;
    const query = slot.queries.length > 0 ? slot.queries.join(" / ") : "(비움)";
    notes.push(
      `[자리 ${slot.index}] ℹ️ 기획이 바꿨습니다 → ${slot.subject || "(대상 미상)"} · 검색어 ${query}` +
        (slot.reason ? ` · ${slot.reason}` : "") +
        (slot.caution ? ` · ⚠️ ${slot.caution}` : "")
    );
  }
  return notes;
}

export async function planImageSlots(
  input: PlanImageSlotsInput,
  options: PlanImageSlotsOptions = {}
): Promise<PlanImageSlotsResult> {
  const slots = collectPlanSlots(input.body, input.imagePrompts);
  if (slots.length === 0) return { plan: null, notes: [] };

  const run =
    options.run ??
    (async (prompt: string) => {
      const result = await runHeadlessClaude({ prompt, timeoutMs: 180_000 });
      return result.ok ? { ok: true as const, output: result.output } : { ok: false as const, error: result.error };
    });

  const result = await run(buildPlanPrompt(input, options.spec)).catch((error) => ({
    ok: false as const,
    error: error instanceof Error ? error.message : String(error),
  }));

  if (!result.ok) {
    // fail-open: 기획이 안 되면 집필자 마커로 돈다.
    return { plan: null, notes: [`⚠️ 이미지 기획 실패 - 원고 마커로 진행합니다: ${result.error}`] };
  }

  const parsed = parsePlan(extractTrailingJson(result.output), slots.length);
  return { plan: parsed.plan, notes: [...parsed.notes, ...(parsed.plan ? describePlan(parsed.plan) : [])] };
}
