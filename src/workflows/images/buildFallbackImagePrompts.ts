// 웹 검색으로 못 채운 자리를 AI 생성 프롬프트로 바꾼다(2026-09-17 사용자 보고 대응).
//
// 왜 필요한가(실측): 09-17 원고들에서 웹 검색 자리 20개 중 18개가 빈 채로 남았다. 그런데 수집기는
// 실패할 때마다 `skipReason`에 대안을 적어 두고 있었다 - 예: "안동 탈놀이단의 결선 오프닝 공연은
// 9월 19일 예정이라 아직 사진이 존재하지 않는다. 전통 탈춤단이 야외 무대에서 공연하는 일반적
// 장면을 AI로 만드는 편이 낫다." 그 문장을 로그에 찍고 버렸기 때문에 자리가 비었다.
//
// "빈 자리보다 AI 이미지가 낫다"는 것은 이미 정해진 방침이다(rules/output-format.md §8-4).
// 그래서 여기서 그 제안을 받아 **규격에 맞는 영어 프롬프트**로 바꾼 뒤 기존 생성 경로에 얹는다.
//
// 이 단계가 지키는 경계 두 가지:
//   1. **본문은 건드리지 않는다.** 마커는 `웹 검색` 그대로 남는다 - 원고는 "여기엔 실제 사진이
//      들어가야 한다"는 사실을 계속 말해야 하고, 나중에 사람이 더 나은 사진으로 갈아끼울 수 있다.
//   2. **실존 인물·로고·글자를 만들지 않는다.** 웹에서 못 찾은 이유가 대개 "실존 대상이라서"인데,
//      그걸 AI로 그리면 가짜가 된다. 그래서 프롬프트는 반드시 **일반화된 장면**이어야 한다.

import { runHeadlessClaude } from "../../services/llm/runHeadlessClaude.js";
import type { RunHeadlessClaudeResult } from "../../services/llm/runHeadlessClaude.js";
import { validateAiPrompt } from "./refixImageMarkers.js";
import type { UnfilledSlot } from "./collectWebImages.js";

export const FALLBACK_PROMPT_TIMEOUT_MS = 5 * 60 * 1000;

export type FallbackImagePrompt = { index: number; description: string; prompt: string };

export type BuildFallbackImagePromptsResult = {
  slots: FallbackImagePrompt[];
  failures: string[];
};

export function buildFallbackPrompt(keyword: string, unfilled: UnfilledSlot[]): string {
  const lines = [
    "블로그 원고의 이미지 자리 몇 개를 웹에서 찾으려다 실패했다. 그 자리를 **AI 이미지 생성으로**",
    "대신 채우려 한다. 자리마다 이미지 생성 프롬프트를 하나씩 써라.",
    "",
    `## 원고 주제: ${keyword}`,
    "",
    "## 가장 중요한 제약 - 일반화된 장면으로 바꾼다",
    "웹에서 못 찾은 이유는 대개 **실존 인물·실존 기업·특정 날짜의 현장**이기 때문이다. 그것을 AI로",
    "그리면 가짜가 된다. 그러니 그 대상 자체를 그리려 하지 말고, **같은 이야기를 하는 일반적인 장면**",
    "으로 바꾼다.",
    "",
    "```",
    "자리: 안동 탈놀이단이 결선 오프닝 무대에서 공연하는 모습 (아직 열리지 않은 공연)",
    "(X) 안동 탈놀이단을 그리려는 시도",
    "(O) 한국 전통 탈춤 공연자들이 야외 무대에서 탈을 쓰고 춤추는 장면",
    "",
    "자리: 나란히 해설위원으로 앉은 김아랑과 곽윤기 (실존 인물)",
    "(X) 두 사람의 얼굴을 그리려는 시도",
    "(O) 빙상 경기장 중계석에서 헤드셋을 쓴 해설위원 두 명이 경기를 보며 이야기하는 장면",
    "```",
    "",
    "## 프롬프트 규칙 (하나라도 어기면 그 자리는 버려진다)",
    "- **영어로만 쓴다.** 한글·일본어 가나가 한 글자라도 섞이면 안 된다(고유명사도 영어로 풀어 쓴다).",
    "- 반드시 `no text, no letters`를 넣는다. 이미지 모델은 한글을 제대로 못 그린다.",
    "- 반드시 비율을 넣는다: `16:9`.",
    "- **실사 사진**이어야 한다. `photorealistic photograph`로 시작하고 일러스트·3D 렌더를 쓰지 않는다.",
    "- **한국 배경**임이 드러나야 한다(`in Korea`, `Korean`). 간판·복장·거리가 한국이어야 본문과 맞는다.",
    "- **사람이 무언가를 하고 있는 장면**으로 쓴다. 텅 빈 공간, 책상 위 소품 클로즈업, 상징물은 금지다.",
    "  (실측: 그렇게 만든 이미지가 문단과 전혀 겹치지 않아 사용자가 전부 반려했다.)",
    "- 실존 인물의 얼굴, 브랜드 로고, 특정 제품의 외형을 지목하지 않는다.",
    "",
    "## 자리",
  ];

  for (const slot of unfilled) {
    lines.push("");
    lines.push(`### 자리 ${slot.index}`);
    lines.push(`- 원래 필요했던 이미지: ${slot.description}`);
    if (slot.suggestion) lines.push(`- 수집기가 적은 실패 사유와 대안: ${slot.suggestion}`);
    lines.push("- 이 이미지가 요약해야 할 문단:");
    lines.push(`  """${slot.context.slice(0, 600)}"""`);
  }

  lines.push(
    "",
    "## 출력",
    "아래 형식으로만 답한다. 설명·머리말·코드펜스를 붙이지 않는다.",
    "자리 하나에 두 줄이고, 자리 사이에 빈 줄을 하나 둔다.",
    "",
    "INDEX: <자리 번호>",
    "PROMPT: <영어 프롬프트 한 줄>"
  );

  return lines.join("\n");
}

/**
 * `INDEX:` / `PROMPT:` 두 줄 짝을 뽑는다. 모델이 앞뒤에 잡음을 붙여도 이 짝만 골라낸다.
 * 프롬프트가 여러 줄로 나오면 한 줄로 이어 붙인다 - 생성 API에는 줄바꿈이 의미 없다.
 */
export function parseFallbackPrompts(raw: string): { index: number; prompt: string }[] {
  const out: { index: number; prompt: string }[] = [];
  const lines = raw.split("\n");

  for (let i = 0; i < lines.length; i += 1) {
    const indexMatch = lines[i].match(/^\s*INDEX:\s*(\d+)\s*$/);
    if (!indexMatch) continue;

    const promptLines: string[] = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const promptStart = lines[j].match(/^\s*PROMPT:\s*(.*)$/);
      if (promptStart) {
        promptLines.push(promptStart[1]);
        // 다음 INDEX나 빈 줄을 만날 때까지가 한 프롬프트다.
        for (let k = j + 1; k < lines.length; k += 1) {
          if (!lines[k].trim() || /^\s*INDEX:/.test(lines[k])) break;
          promptLines.push(lines[k].trim());
        }
        break;
      }
      if (lines[j].trim()) break; // INDEX 다음에 PROMPT가 안 오면 짝이 깨진 것이다.
    }

    const prompt = promptLines.join(" ").trim();
    if (prompt) out.push({ index: Number(indexMatch[1]), prompt });
  }

  return out;
}

export async function buildFallbackImagePrompts(
  input: { keyword: string; unfilled: UnfilledSlot[] },
  options: { generate?: (prompt: string) => Promise<RunHeadlessClaudeResult> } = {}
): Promise<BuildFallbackImagePromptsResult> {
  if (input.unfilled.length === 0) return { slots: [], failures: [] };

  const generate =
    options.generate ??
    ((prompt: string) =>
      runHeadlessClaude({ prompt, timeoutMs: FALLBACK_PROMPT_TIMEOUT_MS, allowedTools: [] }));

  const result = await generate(buildFallbackPrompt(input.keyword, input.unfilled));
  if (!result.ok) return { slots: [], failures: [`폴백 프롬프트 생성 실패: ${result.error}`] };

  const parsed = parseFallbackPrompts(result.output);
  const slots: FallbackImagePrompt[] = [];
  const failures: string[] = [];

  for (const slot of input.unfilled) {
    const match = parsed.find((p) => p.index === slot.index);
    if (!match) {
      failures.push(`[자리 ${slot.index}] 폴백 프롬프트를 받지 못했습니다.`);
      continue;
    }
    // 규격 위반 프롬프트를 그대로 태우면 한글이 박힌 이미지나 세로 이미지가 나온다 - 마커 교정
    // 도구와 **같은 검증기**를 쓴다(기준이 두 벌이 되지 않게).
    const invalid = validateAiPrompt(match.prompt);
    if (invalid) {
      failures.push(`[자리 ${slot.index}] 폴백 프롬프트가 규격 위반이라 버립니다: ${invalid}`);
      continue;
    }
    slots.push({ index: slot.index, description: slot.description, prompt: match.prompt });
  }

  return { slots, failures };
}
