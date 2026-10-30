// 범위 게이트 테스트(2026-10-30). LLM·네트워크·DB 없음.
//
// 실측 사고: 변환기로 받은 "한국 전국 10대 도시 지역별 특산품, 유명한 것 목록"이 "부산 기념품
// 판매처 4곳" 원고로 끝났다. 10월 원고 341건 실측에서 주제어 50% 미만은 17건(5%), 그중 변환기
// 출처는 3건뿐이고 이 사고 건은 43%다.

import { finishWrite } from "./finishWrite.js";
import { measureTopicCoverage, shouldHoldForScope } from "./topicCoverage.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const BUSAN_TOPIC = "한국 전국 10대 도시 지역별 특산품, 유명한 것 목록";
const BUSAN_DRAFT =
  "한국 지역별 특산품 어디서 사나, 부산 기념품 판매처 4곳과 기내 규정\n" +
  "부산 기념품은 부산시 공식 영문 페이지에 올라 있는 판매처 네 곳에서 살 수 있습니다. " +
  "동백상회는 부산역에 있고 여가거가는 광안리에 있습니다. 기내 액체는 용기당 100㎖ 이하입니다.";

// ── 1. 커버리지 계산 ──────────────────────────────────────────────
{
  const c = measureTopicCoverage(BUSAN_TOPIC, BUSAN_DRAFT);
  assert(c.comparable, "한글 주제 + 한글 원고는 비교 가능해야 한다");
  assert(c.ratio < 0.5, `사고 건은 50% 미만이어야 한다 (실제: ${Math.round(c.ratio * 100)}%)`);
  assert(c.missing.includes("도시"), `빠진 말에 '도시'가 있어야 한다: ${c.missing}`);
  assert(!c.tokens.includes("한국"), "흔한 말(한국)은 주제어에서 뺀다");
}

// ── 2. 주제를 제대로 다룬 원고는 통과 ─────────────────────────────
{
  const good =
    "전국 10대 도시 지역별 특산품 목록\n" +
    "서울·부산·인천·대구·대전·광주·수원·울산 등 도시별 특산품을 정리했습니다. 유명한 것만 골랐습니다.";
  const r = shouldHoldForScope({ keyword: BUSAN_TOPIC, text: good, userAuthoredTopic: true });
  assert(!r.hold, `주제를 다룬 원고는 통과해야 한다 (${JSON.stringify(r)})`);
}

// ── 3. 사고 건은 잡는다 ───────────────────────────────────────────
{
  const r = shouldHoldForScope({ keyword: BUSAN_TOPIC, text: BUSAN_DRAFT, userAuthoredTopic: true });
  assert(r.hold, "사고 건은 게이트에 걸려야 한다");
  assert(r.hold && r.message.includes("빠진 것"), "빠진 말을 알려줘야 한다");
}

// ── 4. 자동 수집 키워드에는 적용하지 않는다 ───────────────────────
{
  const r = shouldHoldForScope({ keyword: BUSAN_TOPIC, text: BUSAN_DRAFT, userAuthoredTopic: false });
  assert(!r.hold && r.reason === "not_user_topic", "파이프라인 키워드는 재지 않는다");
}

// ── 5. 언어가 어긋나면 재지 않는다(영문 질의 + 한글 초고) ─────────
{
  const r = shouldHoldForScope({
    keyword: "how cold is korea in winter",
    text: "한국의 겨울 추위는 지역마다 다릅니다. 서울은 영하 10도까지 내려갑니다.",
    userAuthoredTopic: true,
  });
  assert(!r.hold && r.reason === "not_comparable", `사용설명서 영문 질의는 건너뛴다 (${JSON.stringify(r)})`);
}

// ── 6. finishWrite가 게이트에서 자동 승인을 멈추고 되묻는다 ───────
{
  const job = { id: "j1", keyword: BUSAN_TOPIC, metadata: { source: "keyword_input" } } as never;
  const result = {
    status: "success" as const,
    job,
    article: { id: 7, title: "부산 기념품 판매처 4곳", content: BUSAN_DRAFT },
    sources: [],
    isMedical: false,
    telegraphUrl: null,
    requiresMedicalReview: false,
    durationMs: 1000,
  } as never;

  let approved = 0;
  let drafted = 0;
  const warnings: string[] = [];
  const out = await finishWrite("j1", result, {
    skipDraftReview: () => true,
    autoApprove: (async () => {
      approved++;
      return { status: "approved", dispatched: true };
    }) as never,
    notifyDraft: (async () => {
      drafted++;
    }) as never,
    sendWarning: async (_job, text) => {
      warnings.push(text);
    },
  });

  assert(out.path === "scope_held", `경로는 scope_held여야 한다 (실제: ${out.path})`);
  assert(out.exitCode === 0, "실패가 아니라 보류다 - 종료 코드 0");
  assert(approved === 0, "자동 승인이 일어나면 안 된다");
  assert(drafted === 1, "초안 알림(✅/✏️/🗑)으로 되물어야 한다");
  assert(warnings.length === 1 && warnings[0].includes("다 다루지 못했습니다"), "경고 문구를 보내야 한다");
}

// ── 7. 게이트에 안 걸리면 기존 자동 승인 경로 그대로 ──────────────
{
  const job = { id: "j2", keyword: "정가은 결혼반지", metadata: { source: "keyword_input" } } as never;
  const result = {
    status: "success" as const,
    job,
    article: { id: 8, title: "정가은 결혼반지 가품 논란", content: "정가은의 결혼반지가 가품이라는 이야기가 나왔습니다." },
    sources: [],
    isMedical: false,
    telegraphUrl: null,
    requiresMedicalReview: false,
    durationMs: 1000,
  } as never;

  let approved = 0;
  const out = await finishWrite("j2", result, {
    skipDraftReview: () => true,
    autoApprove: (async () => {
      approved++;
      return { status: "approved", dispatched: true };
    }) as never,
    notifyDraft: (async () => {}) as never,
    sendWarning: async () => {},
  });
  assert(out.path === "auto_approved" && approved === 1, `기존 경로 유지 (실제: ${out.path})`);
}

console.log("✅ 범위 게이트: 커버리지 계산·사고 건 포착·자동 수집 제외·언어 어긋남 제외·finishWrite 분기 통과");
