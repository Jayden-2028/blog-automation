// refixImageMarkers 테스트. Claude 호출을 주입해 외부 호출 없이 판정·프롬프트·치환만 본다.
//
// 가장 중요한 불변식은 **마커 개수와 순서가 그대로 유지되는 것**이다. 번호가 밀리면 이미 생성된
// 다른 이미지가 엉뚱한 문단에 붙는다(뷰어가 index로 짝짓는다).

import { applyMarkerFixes, buildFixPrompt, findMarkerViolations, proposeMarkerFixes, validateAiPrompt } from "./refixImageMarkers.js";
import type { MarkerFix } from "./refixImageMarkers.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const BODY = [
  "카페 픽업대 앞에 줄이 늘어섰습니다.",
  "[IMAGE: 카페 픽업대에 놓인 테이크아웃 음료 사진 — 웹 검색]",
  "**법은 무엇을 정하고 있나**\n산업안전보건법 제41조는 고객응대근로자 보호를 사업주 의무로 정합니다.",
  "[IMAGE: 국가법령정보센터 산업안전보건법 제41조 조문 화면 — 웹 검색]",
  "9월 16일 회의에서 방침이 보고됐습니다.",
  "[IMAGE: 9월 16일 국가정책조정회의에서 방침을 보고하는 현장 사진 — 웹 검색]",
  "[IMAGE: 종이컵 일러스트 — AI 생성]",
  "마무리 문단입니다.",
].join("\n\n");

const PROMPTS = ["카페 픽업대", "산업안전보건법 41조", "국가정책조정회의", "A paper cup illustration, no text. 16:9."];

const claudeReply = (fixes: unknown[]) => async () => ({
  ok: true as const,
  output: `설계했습니다.\n${JSON.stringify({ fixes })}`,
  durationMs: 1,
});

async function main(): Promise<void> {
  console.log("▶ refixImageMarkers 테스트 시작\n");

  // 1) 규칙을 어긴 자리만, 전체 마커 기준 index로, 바로 위 문단과 함께 뽑는다.
  const violations = findMarkerViolations(BODY, PROMPTS);
  assert(violations.length === 2, `위반 2자리여야 한다 (${violations.length})`);
  assert(violations[0].index === 2 && violations[0].rule === "screen_capture", "자리 2는 화면 캡처 위반");
  assert(violations[1].index === 3 && violations[1].rule === "news_event", "자리 3은 특정 일시 현장 위반");
  assert(violations[0].context.includes("제41조는 고객응대근로자"), "바로 위 문단이 붙어야 한다");
  assert(violations[0].prompt === PROMPTS[1], "그 자리의 프롬프트가 붙어야 한다");
  console.log("✅ 위반 자리만 추출(전체 마커 기준 index + 문단 + 기존 프롬프트)");

  // 2) 프롬프트에 규칙 근거와 자리별 맥락이 실린다.
  const prompt = buildFixPrompt("남양주 카페 갑질", violations);
  assert(prompt.includes("본문 문장은 건드리지 않는다"), "본문 불변이라는 점을 못박아야 한다");
  assert(prompt.includes("§8-2") && prompt.includes("§8-3") && prompt.includes("§8-4"), "세 규칙 근거가 실려야 한다");
  assert(prompt.includes("자리 2") && prompt.includes("자리 3"), "자리 번호가 실려야 한다");
  assert(prompt.includes("no text, no letters"), "AI 프롬프트 규격이 실려야 한다");
  console.log("✅ 설계 프롬프트 - 규칙 근거 + 자리별 문단 + 출력 규격");

  // 3) 제안 파싱: 획득 방식 표기가 없는 제안은 버린다(없으면 생성기가 unknown으로 보고 만들어버린다).
  const good = {
    index: 2,
    description: "카페 카운터에서 고객을 응대하는 직원 — AI 생성",
    prompt: "A Korean cafe counter, staff serving a customer, no text, no letters. 16:9.",
    reason: "문단이 말하는 응대 상황을 보여준다",
  };
  const missingSuffix = { index: 3, description: "회의실 전경", prompt: "검색어", reason: "" };

  const parsed = await proposeMarkerFixes(
    { keyword: "k", violations },
    { runClaude: claudeReply([good, missingSuffix]) }
  );
  assert(parsed.fixes.length === 1 && parsed.fixes[0].index === 2, `표기 있는 제안만 채택해야 한다 (${JSON.stringify(parsed.fixes)})`);
  assert(parsed.fixes[0].before.description.includes("조문 화면"), "before에 원래 설명이 남아야 한다");
  assert(parsed.rejected.some((r) => r.index === 3 && r.reason.includes("표기가 없")), "버린 이유를 알려야 한다");
  console.log("✅ 제안 파싱 - 획득 방식 표기 없는 제안 거부, before/after 보존");

  // 3-1) AI 생성 프롬프트 규격(2026-09-17 실측: 한국 관공서 장면에 `(行政福祉センター)`가 섞여 왔다 -
  //      가타카나가 들어가면 모델이 일본 배경으로 그린다).
  assert(validateAiPrompt("A Korean office (行政福祉センター), no text, 16:9") !== null, "가타카나가 섞이면 거부해야 한다");
  assert(validateAiPrompt("A Korean office, 한국 관공서, no text, 16:9") !== null, "한글이 섞여도 거부해야 한다");
  assert(validateAiPrompt("A Korean office counter, 16:9") !== null, "`no text`가 없으면 거부해야 한다");
  assert(validateAiPrompt("A Korean office counter, no text, no letters") !== null, "비율이 없으면 거부해야 한다");
  assert(validateAiPrompt("A Korean office counter, no text, no letters. 16:9") === null, "규격을 지키면 통과해야 한다");

  const badPrompt = await proposeMarkerFixes(
    { keyword: "k", violations },
    {
      runClaude: claudeReply([
        { index: 2, description: "행정복지센터 창구 — AI 생성", prompt: "A Korean office (行政福祉センター), no text, 16:9", reason: "" },
      ]),
    }
  );
  assert(badPrompt.fixes.length === 0, "규격 위반 프롬프트는 채택하면 안 된다");
  assert(badPrompt.rejected[0].reason.includes("한글·가나"), `사유가 분명해야 한다 (${JSON.stringify(badPrompt.rejected)})`);
  console.log("✅ AI 프롬프트 규격 검증(영어·no text·비율) - 일본어 혼입 차단");

  // 4) Claude 실행 실패는 예외가 아니라 error로 온다.
  const failed = await proposeMarkerFixes(
    { keyword: "k", violations },
    { runClaude: async () => ({ ok: false as const, error: "claude 없음", durationMs: 1 }) }
  );
  assert(failed.fixes.length === 0 && failed.error === "claude 없음", "실행 실패가 error로 와야 한다");

  const none = await proposeMarkerFixes({ keyword: "k", violations: [] }, { runClaude: claudeReply([]) });
  assert(none.fixes.length === 0 && none.error === null, "위반이 없으면 호출 없이 빈 결과");
  console.log("✅ 실행 실패·위반 없음 안전 처리");

  // 5) **가장 중요한 불변식**: 지정한 자리만 바뀌고 마커 개수·순서·다른 자리는 그대로다.
  const fixes: MarkerFix[] = [
    {
      index: 2,
      rule: "screen_capture",
      before: { description: "x", prompt: "y" },
      after: { description: "카페 카운터에서 응대하는 직원 — AI 생성", prompt: "A Korean cafe counter. 16:9." },
      reason: "",
    },
    {
      index: 3,
      rule: "news_event",
      before: { description: "x", prompt: "y" },
      after: { description: "진료실에서 상담하는 환자 — AI 생성", prompt: "A Korean clinic room. 16:9." },
      reason: "",
    },
  ];

  const applied = applyMarkerFixes(BODY, PROMPTS, fixes);
  assert(applied.ok, `정상 본문은 교체돼야 한다 (${applied.ok ? "" : applied.reason})`);
  const next = applied;
  const markers = next.body.split("\n").filter((l) => l.startsWith("[IMAGE:"));
  assert(markers.length === 4, `마커 개수가 유지돼야 한다 (${markers.length})`);
  assert(markers[0] === "[IMAGE: 카페 픽업대에 놓인 테이크아웃 음료 사진 — 웹 검색]", "자리 1은 그대로여야 한다");
  assert(markers[1] === "[IMAGE: 카페 카운터에서 응대하는 직원 — AI 생성]", "자리 2가 바뀌어야 한다");
  assert(markers[2] === "[IMAGE: 진료실에서 상담하는 환자 — AI 생성]", "자리 3이 바뀌어야 한다");
  assert(markers[3] === "[IMAGE: 종이컵 일러스트 — AI 생성]", "자리 4는 그대로여야 한다");

  assert(next.imagePrompts.length === 4, "프롬프트 개수도 유지돼야 한다");
  assert(next.imagePrompts[0] === PROMPTS[0] && next.imagePrompts[3] === PROMPTS[3], "안 바꾼 자리의 프롬프트는 그대로");
  assert(next.imagePrompts[1] === "A Korean cafe counter. 16:9.", "바꾼 자리의 프롬프트가 갈려야 한다");

  // 본문 문장은 한 글자도 안 바뀐다.
  const textOf = (body: string) => body.split("\n").filter((l) => !l.startsWith("[IMAGE:")).join("\n");
  assert(textOf(next.body) === textOf(BODY), "본문 문장은 그대로여야 한다");
  console.log("✅ 치환 - 지정한 자리만 교체, 마커 개수·순서·본문 문장 불변");

  // 6) 바뀐 본문을 다시 검사하면 위반이 사라진다(왕복 확인).
  const after = findMarkerViolations(next.body, next.imagePrompts);
  assert(after.length === 0, `교체 후에는 위반이 없어야 한다 (${JSON.stringify(after)})`);
  console.log("✅ 왕복 확인 - 교체 후 위반 0");

  // 7) **2026-09-17 사고 회귀**: 마커가 빈 줄 없이 붙어 있으면 줄 기준과 블록 기준 번호가 어긋난다
  //    (실제 원고: 줄 5 / 블록 3). 그 상태로 바꾸면 엉뚱한 자리가 교체된다 - 거부해야 한다.
  const MALFORMED = [
    "도입 문단입니다.",
    "[IMAGE: 첫 번째 — AI 생성]\n[IMAGE: 두 번째 — AI 생성]\n[IMAGE: 세 번째 — AI 생성]",
    "[IMAGE: 조문 화면 — 웹 검색]",
    "마무리 문단입니다.",
  ].join("\n\n");
  const malformedResult = applyMarkerFixes(MALFORMED, ["a", "b"], [fixes[0]]);
  assert(!malformedResult.ok, "줄/블록 수가 다르면 거부해야 한다");
  assert(!malformedResult.ok && malformedResult.reason.includes("빈 줄"), `사유가 분명해야 한다 (${JSON.stringify(malformedResult)})`);

  // 배열이 블록 수와 어긋나는 원고(옛 파서가 인라인 프롬프트를 못 빼내 배열이 짧게 남은 경우)는
  // 거부하지 않는다 - 배열이 이미 무의미하므로 프롬프트를 본문에 인라인으로 써서 자기 완결시킨다.
  const promptMismatch = applyMarkerFixes(BODY, ["하나뿐"], [fixes[0]]);
  assert(promptMismatch.ok, `배열이 어긋나도 인라인으로 고쳐야 한다 (${promptMismatch.ok ? "" : promptMismatch.reason})`);
  assert(
    promptMismatch.ok && promptMismatch.body.includes("[IMAGE: 카페 카운터에서 응대하는 직원 — AI 생성]\n[IMAGE PROMPT: A Korean cafe counter. 16:9.]"),
    "프롬프트가 본문에 인라인으로 붙어야 한다"
  );
  assert(promptMismatch.ok && promptMismatch.imagePrompts.length === 1, "정렬이 깨진 배열은 건드리지 않는다");
  console.log("✅ 줄/블록 불일치는 거부, 배열 불일치는 인라인으로 자기 완결");

  // 8) 인라인 [IMAGE PROMPT:]가 붙은 블록도 짝을 맞춰 함께 바꾼다.
  const INLINE = ["문단.", "[IMAGE: 조문 화면 — 웹 검색]\n[IMAGE PROMPT: 옛 검색어]", "끝."].join("\n\n");
  const inlineResult = applyMarkerFixes(INLINE, ["옛 검색어"], [
    { index: 1, rule: "screen_capture", before: { description: "x", prompt: null },
      after: { description: "카운터 직원 — AI 생성", prompt: "A Korean counter, no text. 16:9." }, reason: "" },
  ]);
  assert(inlineResult.ok, "인라인 프롬프트 블록도 처리돼야 한다");
  assert(inlineResult.ok && inlineResult.body.includes("[IMAGE PROMPT: A Korean counter, no text. 16:9.]"), "인라인 프롬프트도 갈려야 한다");
  console.log("✅ 인라인 IMAGE PROMPT 블록도 함께 교체");

  // 9) **2026-09-17 사고 2회차 회귀**: 블록 판정을 복제하면 파서만 고쳤을 때 갈라진다.
  //    여러 줄 IMAGE PROMPT가 붙은 블록도 여기서 같은 기준으로 세어야 한다.
  const MULTILINE = [
    "문단 하나.",
    "[IMAGE: 조문 화면 — 웹 검색]\n[IMAGE PROMPT: A long prompt line one,\nline two continues,\nline three ends. 16:9.]",
    "문단 둘.",
  ].join("\n\n");
  const multiResult = applyMarkerFixes(MULTILINE, ["기존 프롬프트"], [
    { index: 1, rule: "screen_capture", before: { description: "x", prompt: null },
      after: { description: "카운터 직원 — AI 생성", prompt: "A Korean counter, no text. 16:9." }, reason: "" },
  ]);
  assert(multiResult.ok, `여러 줄 프롬프트 블록도 교체돼야 한다 (${multiResult.ok ? "" : multiResult.reason})`);
  assert(multiResult.ok && multiResult.body.includes("[IMAGE: 카운터 직원 — AI 생성]"), "설명이 바뀌어야 한다");
  assert(multiResult.ok && !multiResult.body.includes("line two continues"), "옛 여러 줄 프롬프트가 남으면 안 된다");
  console.log("✅ 여러 줄 IMAGE PROMPT 블록도 같은 기준으로 인식(판정 복제 회귀)");

  console.log("\n✅ refixImageMarkers 테스트 전체 통과");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
