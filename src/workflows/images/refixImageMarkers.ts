// 이미 쓰인 원고의 `[IMAGE:]` 마커 중 **규칙을 어긴 자리만** 다시 설계한다. 본문 문장은 손대지 않는다.
//
// 왜 필요한가(2026-09-17): 이미지 규칙이 하루 사이에 §8-1~§8-4로 늘었는데, 그 전에 쓰인 원고에는
// 화면 캡처 자리(§8-2)와 특정 일시의 회의·의회 현장 자리(§8-3)가 남아 있다. 그런 자리는 수집을
// 몇 번 돌려도 영영 안 채워진다 - 애초에 쓸 수 없는 것을 요구하기 때문이다. 원고를 통째로
// 재작성(job-revise)하면 본문까지 바뀌어 이미 승인된 글이 달라지므로, 마커 줄만 교체한다.
//
// 설계를 Claude에게 맡기는 이유: 어떤 이미지를 쓸지는 writer.md 계약을 따르는 집필 판단이다
// (CLAUDE.md의 역할 분담 - 원고 작성은 Claude). 검색은 Codex, 집필 판단은 Claude로 갈라 둔다.

import { runHeadlessClaude } from "../../services/llm/runHeadlessClaude.js";
import { extractTrailingJson } from "../../services/llm/runHeadlessCodex.js";
import { classifyImageMarker } from "../review/articleReviewChecks.js";
import type { ImageMarkerViolation } from "../review/articleReviewChecks.js";
import { matchImageBlock, parseManuscriptBlocks } from "../manuscripts/parseManuscriptBlocks.js";

export type MarkerViolation = {
  /** 본문 마커 순서(1부터). imagePrompts 인덱스와 짝이 맞는다. */
  index: number;
  rule: ImageMarkerViolation;
  description: string;
  prompt: string | null;
  /** 바로 위 문단. 새 마커가 이 문단을 한 장으로 요약해야 한다(§8-1). */
  context: string;
};

export type MarkerFix = {
  index: number;
  rule: ImageMarkerViolation;
  before: { description: string; prompt: string | null };
  after: { description: string; prompt: string };
  reason: string;
};

const RULE_LABEL: Record<ImageMarkerViolation, string> = {
  screen_capture: "§8-2 화면 캡처",
  news_event: "§8-3 특정 일시의 회의·발표 현장",
};

/** 한글·가나. AI 생성 프롬프트는 영어여야 한다(output-format.md §8) - 섞이면 배경이 엉뚱하게 그려진다. */
const NON_ENGLISH_IN_PROMPT = /[가-힣ぁ-んァ-ン]/;

/**
 * AI 생성 프롬프트가 규격을 지켰는지 본다. 실측(2026-09-17): 한국 행정복지센터 장면 프롬프트에
 * `(行政福祉センター)`가 섞여 왔다 - 가타카나가 들어가면 모델이 일본 관공서로 그린다.
 * 반환값은 어긋난 사유(없으면 null).
 */
export function validateAiPrompt(prompt: string): string | null {
  if (NON_ENGLISH_IN_PROMPT.test(prompt)) return "AI 생성 프롬프트에 한글·가나가 섞였습니다(영어여야 합니다)";
  if (!/no\s+text/i.test(prompt)) return "`no text`가 없습니다";
  if (!/\d+\s*:\s*\d+/.test(prompt)) return "비율 표기(16:9 등)가 없습니다";
  return null;
}

/** 규칙을 어긴 마커와 그 바로 위 문단을 뽑는다. */
export function findMarkerViolations(body: string, imagePrompts: string[]): MarkerViolation[] {
  const blocks = parseManuscriptBlocks(body, imagePrompts);
  const violations: MarkerViolation[] = [];
  let imageIndex = 0;
  let lastText = "";

  for (const block of blocks) {
    if (block.type === "image") {
      imageIndex += 1;
      const rule = classifyImageMarker(block.description);
      if (rule) {
        violations.push({ index: imageIndex, rule, description: block.description, prompt: block.prompt, context: lastText });
      }
      continue;
    }
    lastText = block.type === "heading" ? `${block.heading}\n${block.body}` : block.content;
  }

  return violations;
}

const FIX_SCHEMA_HINT = `{"fixes":[{"index":1,"description":"설명 — AI 생성","prompt":"...","reason":"한 문장"}]}`;

export function buildFixPrompt(keyword: string, violations: MarkerViolation[]): string {
  const lines = [
    "이미 발행 준비된 블로그 원고에서, **이미지 자리 설명만** 규칙에 맞게 다시 설계한다.",
    "본문 문장은 건드리지 않는다 - 너는 `[IMAGE:]` 줄의 내용만 새로 쓴다.",
    "",
    `## 원고 주제: ${keyword}`,
    "",
    "## 왜 바꾸는가",
    "- **§8-2**: 법령 조문·정부 포털·기관 홈페이지 **화면 캡처**는 쓰지 않는다. 웹에 이미지 파일로",
    "  존재하지 않아 못 구하고, 글자 이미지라 검색 노출에도 불리하다.",
    "- **§8-3**: **특정 날짜의 회의·발표·의회 현장** 사진도 쓰지 않는다. 거의 항상 언론사 저작물이라",
    "  광고가 붙는 블로그에서 쓸 수 없다.",
    "",
    "## 무엇으로 바꾸는가",
    "그 제도·사건이 **적용되는 일반적 현장**으로 바꾼다. 사건이 아니라 상태를 보여주는 자리로 만든다.",
    "예: 조문 화면 → 카운터에서 고객을 응대하는 직원 / 국가정책조정회의 현장 → 진료실에서 상담하는 환자",
    "",
    "## 획득 방식은 **실물을 특정해야 하는가**로 정한다(§8-4)",
    "- `웹 검색`: 특정 인물·특정 제품·특정 작품·특정 장소의 실제 모습이어야 할 때.",
    "- `AI 생성`: 제도가 적용되는 전형적 장면, 개념·절차처럼 **다른 날 찍은 비슷한 사진을 넣어도 글이",
    "  성립할 때.** 이 경우가 대부분이다 - 억지로 웹 검색으로 두면 또 못 찾는다.",
    "",
    "## 쓰는 법",
    "- `description`은 반드시 `설명 — AI 생성` 또는 `설명 — 웹 검색` 형식으로 끝낸다(대시는 —).",
    "- 설명은 **무엇이 보이는지** 구체적으로 쓴다. '관련 이미지' 같은 추상적 표현 금지.",
    "- `prompt`:",
    "  - `AI 생성`이면 **영어** 이미지 생성 프롬프트. 3~6줄, `no text, no letters` 필수, 마지막에 `16:9`.",
    "    한국 이야기면 `in Korea`, `Korean` 같은 국가 맥락을 반드시 넣는다(안 넣으면 서구권으로 그려진다).",
    "    실존 인물·브랜드·로고를 그리게 하지 않는다.",
    "  - `웹 검색`이면 **한국어 검색어** 한 줄, 8단어 안쪽, 고유명사 포함.",
    "- 바로 위 문단을 한 장으로 요약해야 한다(§8-1) - 그 문단의 구체 요소가 2개 이상 담기게 쓴다.",
    "",
    "## 바꿀 자리",
  ];

  for (const v of violations) {
    lines.push("");
    lines.push(`### 자리 ${v.index} (${RULE_LABEL[v.rule]} 위반)`);
    lines.push(`- 지금 설명: ${v.description}`);
    if (v.prompt) lines.push(`- 지금 프롬프트: ${v.prompt}`);
    lines.push("- 이 이미지가 요약해야 할 문단:");
    lines.push(`  """${v.context.slice(0, 600)}"""`);
  }

  lines.push("", "## 출력", `마지막 줄에 JSON 한 줄만 답한다: ${FIX_SCHEMA_HINT}`, "자리마다 항목 하나씩, 위 자리 번호를 그대로 쓴다.");

  return lines.join("\n");
}

export type ProposeMarkerFixesOptions = {
  /** 테스트 주입 지점. 기본은 claude -p. */
  runClaude?: typeof runHeadlessClaude;
};

export type ProposeMarkerFixesResult = {
  fixes: MarkerFix[];
  /** 규격에 어긋나 버린 제안들(사용자에게 왜 빠졌는지 알린다). */
  rejected: { index: number; reason: string }[];
  error: string | null;
};

export async function proposeMarkerFixes(
  input: { keyword: string; violations: MarkerViolation[] },
  options: ProposeMarkerFixesOptions = {}
): Promise<ProposeMarkerFixesResult> {
  if (input.violations.length === 0) return { fixes: [], rejected: [], error: null };

  const runClaude = options.runClaude ?? runHeadlessClaude;
  const result = await runClaude({ prompt: buildFixPrompt(input.keyword, input.violations), timeoutMs: 180_000 });
  if (!result.ok) return { fixes: [], rejected: [], error: result.error };

  const parsed = extractTrailingJson(result.output) as { fixes?: unknown } | null;
  const raw = parsed && Array.isArray(parsed.fixes) ? parsed.fixes : [];

  const fixes: MarkerFix[] = [];
  const rejected: { index: number; reason: string }[] = [];

  for (const violation of input.violations) {
    const proposal = raw.find(
      (f): f is { index: number; description: string; prompt: string; reason?: string } =>
        !!f && typeof f === "object" && (f as { index?: unknown }).index === violation.index
    );
    if (!proposal || typeof proposal.description !== "string" || typeof proposal.prompt !== "string") {
      rejected.push({ index: violation.index, reason: "제안이 없거나 형식이 맞지 않습니다" });
      continue;
    }

    const description = proposal.description.trim();
    const prompt = proposal.prompt.trim();

    // 획득 방식 표기가 빠지면 generateManuscriptImages가 unknown으로 보고 생성해버린다 - 반드시 확인한다.
    const acquisition = description.match(/—\s*(AI\s*생성|웹\s*검색)\s*$/);
    if (!acquisition) {
      rejected.push({ index: violation.index, reason: "설명 끝에 `— AI 생성`/`— 웹 검색` 표기가 없습니다" });
      continue;
    }

    if (/AI/i.test(acquisition[1])) {
      const invalid = validateAiPrompt(prompt);
      if (invalid) {
        rejected.push({ index: violation.index, reason: invalid });
        continue;
      }
    }

    fixes.push({
      index: violation.index,
      rule: violation.rule,
      before: { description: violation.description, prompt: violation.prompt },
      after: { description, prompt },
      reason: typeof proposal.reason === "string" ? proposal.reason : "",
    });
  }

  return { fixes, rejected, error: null };
}

/**
 * 이미지 블록 판정은 **parseManuscriptBlocks의 것을 그대로 쓴다**(2026-09-17 사고 2회차).
 * 처음엔 여기에 같은 로직을 복제했는데, 파서가 여러 줄 IMAGE PROMPT를 인식하도록 고쳐졌을 때
 * 이쪽만 옛 기준(2줄 고정)으로 남아 블록 수가 어긋났다 - 판정이 두 벌이면 반드시 갈라진다.
 */
function isImageBlock(raw: string): { hasInlinePrompt: boolean } | null {
  const matched = matchImageBlock(raw.trim());
  return matched ? { hasInlinePrompt: matched.inlinePrompt !== null } : null;
}

export type ApplyMarkerFixesResult =
  | { ok: true; body: string; imagePrompts: string[] }
  | { ok: false; reason: string };

/**
 * 본문의 해당 이미지 블록과 imagePrompts 항목만 갈아끼운다.
 *
 * **번호는 반드시 블록 기준이다**(2026-09-17 사고): 처음엔 `[IMAGE:` 로 시작하는 **줄**을 셌는데,
 * findMarkerViolations는 parseManuscriptBlocks의 **블록**을 센다. 마커가 빈 줄 없이 붙어 있는 원고
 * (심정지 원고: 줄 5 / 블록 3)에서 둘이 어긋나 **엉뚱한 자리를 바꿨다.** 파이프라인의 다른 코드
 * (생성·수집·뷰어)가 전부 블록 기준 index로 이미지를 짝지으므로 블록 기준이 정본이다.
 *
 * 줄 수와 블록 수가 다르면 그 원고는 출력 형식 계약(output-format.md §8 - 마커 앞뒤 빈 줄 2개)을
 * 어긴 것이라 안전하게 짝지을 수 없다. 고치지 않고 거부한다 - 잘못 바꾸느니 그대로 두는 게 낫다.
 */
export function applyMarkerFixes(body: string, imagePrompts: string[], fixes: MarkerFix[]): ApplyMarkerFixesResult {
  // 구분자를 배열에 남기는 split - 빈 줄 개수까지 그대로 보존한다(짝수 index = 블록).
  const parts = body.split(/(\n{2,})/);
  const markerLineCount = body.split("\n").filter((l) => /^\[IMAGE:\s*/.test(l.trim())).length;
  const blockCount = parts.filter((p, i) => i % 2 === 0 && isImageBlock(p) !== null).length;

  if (markerLineCount !== blockCount) {
    return {
      ok: false,
      reason:
        `마커 줄 ${markerLineCount}개와 이미지 블록 ${blockCount}개가 다릅니다 - 마커 앞뒤가 빈 줄로 ` +
        `떨어져 있지 않아(output-format.md §8) 자리를 안전하게 짝지을 수 없습니다.`,
    };
  }

  // 프롬프트가 어디 있느냐로 쓰는 곳이 갈린다.
  // - 배열이 블록 수와 맞으면(정상 원고) 배열에 쓴다 - 본문 변화가 가장 적다.
  // - 어긋나면(옛 파서가 인라인 프롬프트를 못 빼내 배열이 짧게 남은 원고) 배열은 이미 무의미하다.
  //   parseManuscriptBlocks도 정렬이 깨지면 배열을 통째로 무시하므로, 프롬프트를 **본문에 인라인으로**
  //   써서 그 자리만은 자기 완결되게 만든다. 거부하면 영영 못 고치는 원고가 남는다.
  const promptsAligned = imagePrompts.length === blockCount;
  const byIndex = new Map(fixes.map((f) => [f.index, f]));
  let imageIndex = 0;

  const nextParts = parts.map((part, i) => {
    if (i % 2 === 1) return part;
    const block = isImageBlock(part);
    if (!block) return part;
    imageIndex += 1;
    const fix = byIndex.get(imageIndex);
    if (!fix) return part;

    const keepInline = block.hasInlinePrompt || !promptsAligned;
    return keepInline
      ? `[IMAGE: ${fix.after.description}]\n[IMAGE PROMPT: ${fix.after.prompt}]`
      : `[IMAGE: ${fix.after.description}]`;
  });

  const nextPrompts = promptsAligned
    ? imagePrompts.map((prompt, i) => byIndex.get(i + 1)?.after.prompt ?? prompt)
    : imagePrompts;

  return { ok: true, body: nextParts.join(""), imagePrompts: nextPrompts };
}
