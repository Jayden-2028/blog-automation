// ✏️ 수정 요청을 반영하려면 **무엇을 더 조사해야 하는가**를 목록으로 뽑는다(2026-11-06).
//
// 계기(2026-11-06 실측): 인물 백과 "신민아" 원고에 "필로그래피 문단을 더 늘려주세요. 마들렌·달콤한
// 인생·야수와 미녀·이 죽일놈의 사랑·마왕"이라는 답장이 왔는데, 그 다섯 작품은 원고에 한 줄도 없었다.
// 수정 단계는 "새 사실을 추가하지 않는다(기존 원고가 유일한 사실 출처다)"가 절대 규칙이라 모델이
// 재작성을 거부했고, 출력 형식에 거부할 자리가 없어 "마커 형식을 따르지 않았습니다"로 나갔다.
//
// 추적성은 버리지 않는다 - 모델이 웹에서 보고 바로 쓰게 하는 대신, **무엇을 더 조사할지 먼저 목록으로
// 정하고** 그 목록만 조사해 조사 기록에 남긴 뒤 그것을 사실 출처로 삼는다. 그 목록은 동시에
// **범위 가드**다: 2026-10-30 "부산 특산품" 사고(2차 브리프 재작성이 글의 주제를 통째로 바꿨다)와 같은
// 계열의 위험을 여기서 막는다 - 조사도 재작성도 이 목록 밖으로 나가지 않는다.
//
// 목록이 비면(대부분의 수정 요청) 보충 조사를 돌지 않고 지금까지와 똑같이 간다 - 비용이 늘지 않는다.

import { runHeadlessClaude } from "../../services/llm/runHeadlessClaude.js";
import type { RunHeadlessClaudeResult } from "../../services/llm/runHeadlessClaude.js";

/** 항목 추출은 짧은 판정 1콜이다 - 조사·재작성보다 훨씬 작은 상한을 쓴다. */
export const RESEARCH_ITEM_TIMEOUT_MS = 3 * 60 * 1000;

export const RESEARCH_ITEM_MARKERS = {
  items: "### RESEARCH_ITEMS",
  /** 보충 조사가 필요 없을 때 모델이 적는 한 줄. */
  none: "(없음)",
} as const;

/**
 * 한 번의 수정에서 조사할 항목 수 상한. 넘치면 앞에서부터 자른다.
 * 왜 상한이 필요한가: 항목이 많아질수록 조사가 길어지고, 무엇보다 **글이 다른 글이 된다**
 * (문단을 몇 개 더하는 일이지 다시 쓰는 일이 아니다).
 */
export const MAX_RESEARCH_ITEMS = 6;
/** 항목 하나의 길이 상한(자). 항목은 "마들렌(2003년 영화) 역할·줄거리"처럼 검색어 한 줄이다. */
export const MAX_RESEARCH_ITEM_CHARS = 60;

export type PlanRevisionResearchInput = {
  keyword: string;
  category: string | null;
  originalTitle: string;
  originalBody: string;
  /** job.metadata.researchFileContent. 조사 기록에 이미 있는 내용은 보충 조사 대상이 아니다. */
  researchText: string | null;
  feedback: string;
  /** 테스트 주입 지점. 기본은 runHeadlessClaude(claude -p, 도구 없음 - 판정만 한다). */
  generate?: (prompt: string) => Promise<RunHeadlessClaudeResult>;
};

export type PlanRevisionResearchResult = {
  /** 보충 조사할 항목. 비면 보충 조사를 돌지 않는다. */
  items: string[];
  /** 판정 자체가 실패한 사유. 이때도 items는 빈 배열이고 수정은 지금까지대로 진행한다. */
  error?: string;
};

/**
 * 항목 목록을 파싱한다. 모델이 무엇을 적든 코드가 범위를 좁힌다 - 개수·길이 상한, 중복 제거,
 * 번호·불릿 제거. `(없음)`이면 빈 배열이다.
 */
export function parseResearchItems(raw: string): string[] {
  const start = raw.indexOf(RESEARCH_ITEM_MARKERS.items);
  if (start === -1) return [];
  const body = raw.slice(start + RESEARCH_ITEM_MARKERS.items.length);
  const items: string[] = [];
  const seen = new Set<string>();
  for (const line of body.split("\n")) {
    const text = line.trim();
    if (!text) continue;
    // 다음 ### 블록이 시작되면 끝이다.
    if (text.startsWith("###")) break;
    if (text.includes(RESEARCH_ITEM_MARKERS.none)) return [];
    const item = text
      .replace(/^[-*•]\s*/, "")
      .replace(/^\d+[.)]\s*/, "")
      .trim();
    if (!item) continue;
    // 모델이 설명 문장을 흘려 쓴 경우를 거른다 - 항목은 검색어 한 줄이다.
    if (item.length > MAX_RESEARCH_ITEM_CHARS) continue;
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(item);
    if (items.length >= MAX_RESEARCH_ITEMS) break;
  }
  return items;
}

function buildPrompt(input: PlanRevisionResearchInput): string {
  const { keyword, originalTitle, originalBody, researchText, feedback } = input;
  const M = RESEARCH_ITEM_MARKERS;

  return [
    `당신은 블로그 원고의 수정 요청을 받은 편집 보조다. 원고를 고치지 말고, **이 수정 요청을 반영하려면`,
    `어떤 항목을 더 조사해야 하는가**만 판정한다.`,
    ``,
    `## 판정 규칙`,
    `- 수정 요청이 가리키는 내용이 아래 "기존 원고"나 "기존 조사 자료"에 **이미 있으면** 조사할 항목이 없다.`,
    `  문체·분량·구성·순서·제목만 바꾸라는 요청도 항목이 없다. 그 경우 \`${M.none}\` 한 줄만 적는다.`,
    `- 요청이 원고에도 조사 자료에도 **없는 구체적 사실**(작품·사건·수치·날짜·인물 관계)을 넣어 달라고 할 때만`,
    `  그 사실을 항목으로 적는다.`,
    `- 항목은 **이 글의 주제(${keyword})에 붙는 보강**이어야 한다. 주제를 바꾸거나 넓히는 항목은 적지 않는다 -`,
    `  문단을 더하기 위한 조사이지 다른 글을 쓰기 위한 조사가 아니다.`,
    `- 항목은 **검색어 한 줄**로 짧게(${MAX_RESEARCH_ITEM_CHARS}자 이내), 최대 ${MAX_RESEARCH_ITEMS}개. 편집자가 이름을 나열했으면 그 이름 그대로 한 줄씩 적는다.`,
    `- 설명·사유·인사말을 쓰지 않는다. 아래 형식만 출력한다.`,
    ``,
    `## 출력 형식 (이 마커를 정확히 그대로)`,
    M.items,
    `- 항목1`,
    `- 항목2`,
    `(조사할 것이 없으면 목록 대신 ${M.none} 한 줄)`,
    ``,
    `## 수정 요청 (편집자)`,
    feedback,
    ``,
    `## 기존 원고 (키워드: ${keyword} / 제목: ${originalTitle})`,
    originalBody,
    ``,
    `## 기존 조사 자료`,
    researchText && researchText.trim() ? researchText : `(없음)`,
  ].join("\n");
}

/**
 * 보충 조사가 필요한지, 필요하면 무엇을 조사할지 판정한다.
 *
 * 실패(타임아웃·마커 누락)는 수정을 막지 않는다 - 빈 목록을 돌려주고 지금까지의 수정 경로로 간다.
 * 보충 조사는 **예외 경로**이고, 판정 실패로 평시 수정이 깨지면 안 된다.
 */
export async function planRevisionResearch(input: PlanRevisionResearchInput): Promise<PlanRevisionResearchResult> {
  const generate =
    input.generate ??
    ((prompt: string) => runHeadlessClaude({ prompt, timeoutMs: RESEARCH_ITEM_TIMEOUT_MS }));

  const result = await generate(buildPrompt(input));
  if (!result.ok) return { items: [], error: result.error };
  const items = parseResearchItems(result.output);
  if (items.length === 0 && !result.output.includes(RESEARCH_ITEM_MARKERS.items)) {
    return { items: [], error: `조사 항목 판정이 마커(${RESEARCH_ITEM_MARKERS.items})를 따르지 않았습니다` };
  }
  return { items };
}
