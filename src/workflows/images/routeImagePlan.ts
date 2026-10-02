// 기획 결과를 각 수집·생성 경로의 입력으로 나눈다(2026-10-02).
//
// 왜 따로 떼었나: prepareManuscript 안에서 경로마다 따로 걸러 쓰다 보니 **두 군데가 빠졌다.**
//   1. 기획이 `ai`·`infographic`으로 정한 자리는 **어느 경로에도 안 실렸다.** 생성은 집필자 마커의
//      꼬리만 보고, 기획 결과는 검색·캡처에만 배선돼 있었다. 오세훈 2심 3번 자리가 그래서 비었다
//      ("기획이 바꿨습니다 → AI 생성"이라 적혀 있는데 아무것도 안 만들어졌다).
//   2. 기획이 **일부 자리만** 돌려주면 나머지 자리도 어느 경로에도 안 실렸다. 기록에는
//      "나머지는 원고 마커로 갑니다"라고 적혔는데 실제로는 아니었다.
// 한곳에서 자리 하나하나를 정확히 한 경로에 배정하고, 그 배정을 테스트로 고정한다.
import { parseManuscriptBlocks } from "../manuscripts/parseManuscriptBlocks.js";
import type { ImagePlan, Recency } from "./planImageSlots.js";
import { validateAiPrompt } from "./refixImageMarkers.js";

export type PlannedGeneration = {
  index: number;
  description: string;
  prompt: string;
  acquisition: "ai" | "infographic";
};

export type ImagePlanRoute = {
  searchIndexes: number[];
  queries: Record<number, string[]>;
  subjects: Record<number, { subject: string; caution?: string; recency?: Recency }>;
  captureUrls: Record<number, string>;
  /** 기획이 생성으로 정한 자리. 프롬프트 검증을 통과한 것만. */
  generate: PlannedGeneration[];
  /** 사람이 읽는 기록(검증 실패 등). */
  notes: string[];
};

/**
 * 인포그래픽 프롬프트 최소 검증. 글자가 들어가는 그림이라 `no text`는 요구하지 않는다(§9).
 * 대신 **들어갈 글자를 따옴표로 못 박았는지**와 비율을 본다 - 안 못 박으면 모델이 없는 문구를
 * 사실처럼 그려 넣는다.
 */
export function validateInfographicPrompt(prompt: string): string | null {
  if (prompt.length < 40) return "인포그래픽 프롬프트가 너무 짧습니다(검색어가 들어온 것 같습니다)";
  if (!/["“”'‘’「」]/.test(prompt)) return "들어갈 글자를 따옴표로 적지 않았습니다";
  if (!/\d+\s*:\s*\d+/.test(prompt)) return "비율 표기(16:9 등)가 없습니다";
  return null;
}

export function routeImagePlan(plan: ImagePlan, body: string, imagePrompts: string[]): ImagePlanRoute {
  const route: ImagePlanRoute = { searchIndexes: [], queries: {}, subjects: {}, captureUrls: {}, generate: [], notes: [] };
  const byIndex = new Map(plan.slots.map((s) => [s.index, s]));

  let index = 0;
  for (const block of parseManuscriptBlocks(body, imagePrompts)) {
    if (block.type !== "image") continue;
    index += 1;
    const slot = byIndex.get(index);

    // 기획에 없는 자리는 집필자 마커대로 간다 - 기록에 적힌 그대로.
    if (!slot) {
      if (block.acquisition === "search" || block.acquisition === "unknown") route.searchIndexes.push(index);
      else if (block.acquisition === "capture" && /^https?:\/\//i.test(block.prompt ?? "")) {
        route.captureUrls[index] = (block.prompt ?? "").trim();
      }
      // ai·infographic 마커는 첫 생성 단계가 마커를 보고 이미 만든다.
      continue;
    }

    if (slot.subject.trim()) {
      route.subjects[index] = {
        subject: slot.subject,
        ...(slot.caution ? { caution: slot.caution } : {}),
        ...(slot.recency ? { recency: slot.recency } : {}),
      };
    }
    if (slot.queries.length > 0) route.queries[index] = slot.queries;

    switch (slot.acquisition) {
      case "search":
        if (slot.queries.length > 0) route.searchIndexes.push(index);
        break;
      case "capture":
        if (/^https?:\/\//i.test(slot.queries[0] ?? "")) route.captureUrls[index] = slot.queries[0];
        break;
      case "ai":
      case "infographic": {
        // 집필자 마커가 이미 같은 방식이면 첫 생성 단계가 마커 프롬프트로 만든다 - 두 번 만들지 않는다.
        if (block.acquisition === slot.acquisition) break;
        const prompt = slot.queries[0] ?? "";
        const problem = slot.acquisition === "ai" ? validateAiPrompt(prompt) : validateInfographicPrompt(prompt);
        if (problem) {
          route.notes.push(`[자리 ${index}] 이미지 기획: ${slot.acquisition === "ai" ? "AI" : "인포그래픽"} 프롬프트를 쓸 수 없어 비웁니다 - ${problem}.`);
          break;
        }
        route.generate.push({ index, description: slot.subject || block.description, prompt, acquisition: slot.acquisition });
        break;
      }
    }
  }
  return route;
}
