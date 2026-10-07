// 기획 결과를 각 수집·생성 경로의 입력으로 나눈다(2026-10-02).
//
// 왜 따로 떼었나: prepareManuscript 안에서 경로마다 따로 걸러 쓰다 보니 **두 군데가 빠졌다.**
//   1. 기획이 `ai`·`infographic`으로 정한 자리는 **어느 경로에도 안 실렸다.** 생성은 집필자 마커의
//      꼬리만 보고, 기획 결과는 검색·캡처에만 배선돼 있었다. 오세훈 2심 3번 자리가 그래서 비었다
//      ("기획이 바꿨습니다 → AI 생성"이라 적혀 있는데 아무것도 안 만들어졌다).
//   2. 기획이 **일부 자리만** 돌려주면 나머지 자리도 어느 경로에도 안 실렸다. 기록에는
//      "나머지는 원고 마커로 갑니다"라고 적혔는데 실제로는 아니었다.
// 한곳에서 자리 하나하나를 정확히 한 경로에 배정하고, 그 배정을 테스트로 고정한다.
import { parseManuscriptBlocks, stripAcquisitionSuffix } from "../manuscripts/parseManuscriptBlocks.js";
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

export type RouteImagePlanOptions = {
  /**
   * 독자에게 보일 캡션의 언어. 사용설명서 영어본은 "en"(2026-10-08).
   *
   * 기획의 `subject`는 **검색·판정 기준**이자 **캡션의 바탕**이라는 두 일을 겸한다. 영어본에서는
   * 한글 subject가 그대로 캡션·alt가 돼 독자에게 나간다(실측: 영어 글 7자리 캡션이 전부
   * "…하는 장면"). 영어 캡션이 필요한데 subject가 한글이면 **영어 마커 설명을 캡션으로 쓰고**
   * subject는 판정 기준(caution)으로만 남긴다 - 검색어는 건드리지 않는다(한국 소재는 한국어로 잘 찾는다).
   */
  captionLanguage?: "ko" | "en";
};

const HANGUL_RE = /[가-힣]/;

/** 영어 캡션이 필요한 자리에서 한글 subject를 캡션으로 쓰면 안 된다. */
function subjectUsableAsCaption(subject: string, captionLanguage: "ko" | "en" | undefined): boolean {
  if (!subject.trim()) return false;
  return captionLanguage !== "en" || !HANGUL_RE.test(subject);
}

export function routeImagePlan(
  plan: ImagePlan,
  body: string,
  imagePrompts: string[],
  options: RouteImagePlanOptions = {}
): ImagePlanRoute {
  const route: ImagePlanRoute = { searchIndexes: [], queries: {}, subjects: {}, captureUrls: {}, generate: [], notes: [] };
  const byIndex = new Map(plan.slots.map((s) => [s.index, s]));
  const captionLanguage = options.captionLanguage;

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

    // `subject`는 **캡션이 될 수 있는 글**이다. 영어 캡션 자리에서 한글 subject는 캡션으로 내보내지
    // 않고 판정 기준(caution)으로만 넘긴다 - 수집 에이전트는 무엇을 찾을지 그대로 알 수 있고,
    // 캡션은 영어 마커 설명이 쓰인다. 검색어는 queries가 따로 나르므로 영향이 없다.
    const captionSafeSubject = subjectUsableAsCaption(slot.subject, captionLanguage);
    const subjectAsCaution = !captionSafeSubject && slot.subject.trim() ? `찾을 대상: ${slot.subject.trim()}` : "";
    const caution = [subjectAsCaution, slot.caution].filter(Boolean).join(" ");
    if (slot.subject.trim()) {
      route.subjects[index] = {
        subject: captionSafeSubject ? slot.subject : "",
        ...(caution ? { caution } : {}),
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
        route.generate.push({
          // 생성 이미지의 캡션·alt가 되는 글이다 - 영어 캡션 자리에서 한글 subject는 쓰지 않는다.
          // 마커 설명으로 되돌아갈 때는 획득 방식 꼬리(`— 웹 검색`)를 뗀다. 독자에게 보일 글이다.
          description: (captionSafeSubject ? slot.subject : "") || stripAcquisitionSuffix(block.description),
          index,
          prompt,
          acquisition: slot.acquisition,
        });
        break;
      }
    }
  }
  return route;
}
