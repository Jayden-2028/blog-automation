// topicScope + 브리프 재작성 범위 가드 테스트(2026-10-30). LLM·네트워크 없음.
//
// 회귀의 본체: 변환기로 받은 "한국 전국 10대 도시 지역별 특산품, 유명한 것 목록"에서 자료조사가
// 부산만 찾아오자 2차 브리프가 질문을 부산 판매처로 갈아끼웠고, 원고 주제 자체가 바뀌었다.

import { buildRevisePrompt, reviseBriefWithResearch } from "./reviseBriefWithResearch.js";
import type { KeywordBrief } from "./buildKeywordBrief.js";
import { droppedScope, readTopicScope } from "./topicScope.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

// ── 1. 범위 표지 읽기 ─────────────────────────────────────────────
{
  const s = readTopicScope("한국 전국 10대 도시 지역별 특산품, 유명한 것 목록");
  assert(s.hasScope, "범위 표지를 찾아야 한다");
  assert(s.count === 10, `개수 10을 읽어야 한다 (실제: ${s.count})`);
  assert(s.markers.includes("전국") && s.markers.includes("지역별") && s.markers.includes("목록"), `표지: ${s.markers}`);

  const single = readTopicScope("정가은 결혼반지 가품 논란");
  assert(!single.hasScope, "단일 주제에는 범위 표지가 없어야 한다");

  const en = readTopicScope("best korean street foods list");
  assert(en.hasScope && en.markers.includes("best"), `영문 표지: ${en.markers}`);
}

// ── 2. 범위를 버렸는지 판정 ───────────────────────────────────────
{
  const scope = readTopicScope("한국 전국 10대 도시 지역별 특산품, 유명한 것 목록");
  const before = ["10대 도시의 대표 특산품은 무엇인가", "지역별로 어디서 사나"];

  const narrowed = ["부산에서 기념품을 사려면 어디로 가야 하나", "기내 액체 제한은 무엇인가"];
  assert(droppedScope(scope, before, narrowed), "범위를 버린 재작성을 잡아야 한다");

  const kept = ["10대 도시 대표 특산품 중 공식 확인된 것은", "지역별 구매처는 어디인가"];
  assert(!droppedScope(scope, before, kept), "범위가 남아 있으면 통과시켜야 한다");

  // 1차가 애초에 범위를 안 담았으면 2차를 탓하지 않는다.
  assert(!droppedScope(scope, ["특산품이 무엇인가"], narrowed), "1차에 표지가 없으면 false");
  // 범위 없는 주제는 항상 false.
  assert(!droppedScope(readTopicScope("드립커피 내리는 법"), before, narrowed), "범위 없는 주제는 false");
}

// ── 3. 프롬프트에 금지 문구가 붙는다(사용자 주제일 때만) ──────────
{
  const brief: KeywordBrief = {
    type: "other",
    hook: "h",
    questions: ["10대 도시 특산품은"],
    action: "a",
    autocomplete: [],
    generatedAt: new Date().toISOString(),
  } as KeywordBrief;

  const withFlag = buildRevisePrompt({
    keyword: "한국 전국 10대 도시 지역별 특산품, 유명한 것 목록",
    brief,
    research: "자료",
    userAuthoredTopic: true,
  });
  assert(withFlag.includes("범위는 사용자가 정했다"), "사용자 주제면 금지 절이 들어가야 한다");
  assert(withFlag.includes("항목 10개 규모"), "개수를 프롬프트에 알려야 한다");

  const withoutFlag = buildRevisePrompt({
    keyword: "한국 전국 10대 도시 지역별 특산품, 유명한 것 목록",
    brief,
    research: "자료",
  });
  assert(!withoutFlag.includes("범위는 사용자가 정했다"), "파이프라인 자동 주제에는 붙지 않는다(기존 동작)");
}

// ── 4. 코드 가드: 범위를 버린 재작성은 1차를 유지한다 ─────────────
{
  const brief: KeywordBrief = {
    type: "other",
    hook: "h",
    questions: ["10대 도시의 대표 특산품은 무엇인가", "지역별로 어디서 사나", "언제 사면 좋나"],
    action: "a",
    autocomplete: [],
    generatedAt: new Date().toISOString(),
  } as KeywordBrief;

  const narrowOutput = [
    "HOOK: 부산 기념품은 네 곳에서 산다",
    "Q1: 부산에서 기념품을 사려면 어디로 가야 하나",
    "Q2: 기내 액체 제한은 무엇인가",
    "Q3: 입국 면세 한도는 얼마인가",
    "ACTION: 편의점에서 확인",
    "CHANGED: 자료에 맞게 부산 중심으로 재구성",
  ].join("\n");

  const runClaude = async () => ({ ok: true as const, output: narrowOutput, durationMs: 1 });

  const guarded = await reviseBriefWithResearch(
    { keyword: "한국 전국 10대 도시 지역별 특산품, 유명한 것 목록", brief, research: "자료", userAuthoredTopic: true },
    { runClaude }
  );
  assert(guarded.status === "failed", `범위를 버리면 failed여야 한다 (실제: ${guarded.status})`);
  assert(
    guarded.status === "failed" && guarded.error.includes("범위"),
    "실패 사유에 범위를 적어야 한다(호출부가 1차를 그대로 쓴다)"
  );

  // 같은 출력이라도 사용자 주제가 아니면 기존대로 통과한다(다른 트랙 동작 불변).
  const pipeline = await reviseBriefWithResearch(
    { keyword: "한국 전국 10대 도시 지역별 특산품, 유명한 것 목록", brief, research: "자료" },
    { runClaude }
  );
  assert(pipeline.status === "revised", `파이프라인 주제는 기존대로 revised (실제: ${pipeline.status})`);

  // 범위를 지킨 재작성은 사용자 주제에서도 통과한다.
  const keptOutput = [
    "HOOK: 공식으로 확인된 도시만 추렸다",
    "Q1: 10대 도시 가운데 공식 출처로 확인되는 특산품은 무엇인가",
    "Q2: 지역별 구매처는 어디인가",
    "Q3: 비행기에 실을 때 걸리는 것은",
    "ACTION: 목록 확인",
    "CHANGED: 확인 범위를 명시하도록 다듬음",
  ].join("\n");
  const ok = await reviseBriefWithResearch(
    { keyword: "한국 전국 10대 도시 지역별 특산품, 유명한 것 목록", brief, research: "자료", userAuthoredTopic: true },
    { runClaude: async () => ({ ok: true as const, output: keptOutput, durationMs: 1 }) }
  );
  assert(ok.status === "revised", `범위를 지킨 재작성은 통과 (실제: ${ok.status})`);
}

console.log("✅ topicScope + 브리프 범위 가드: 표지 인식·축소 판정·프롬프트·코드 가드 통과");
