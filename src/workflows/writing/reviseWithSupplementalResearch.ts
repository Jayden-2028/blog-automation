// ✏️ 수정 요청 한 건의 전체 흐름(2026-11-06). job-revise 안에서 끝낸다.
//
//   ① 조사 항목 판정(planRevisionResearch, 짧은 1콜) - 비면 ④로 바로 간다(평시 경로, 비용 변화 없음)
//   ② 좁힌 보충 조사(collectSupplementalResearch) - 뽑힌 항목만, 받아 둔 소스팩 + 웹 1콜
//   ③ 조사 기록에 **덧붙이고** sources에 출처를 더한다(원 조사는 그대로 - 감사 기록)
//   ④ 재작성(reviseArticleWithFeedback) - 사실 출처는 원고 + 조사 기록(보충분 포함)뿐이다
//
// 왜 한 워크플로인가(별도 조사 워크플로를 띄우지 않는 이유): 파이프라인 큐(pipelineQueue.ts)가
// research/write/revise를 직렬화하므로, 조사를 따로 띄우면 큐 행을 하나 더 만들고 **같은 피드백을 들고
// revise를 다시 발화**해야 한다 - 발화 체인과 실패 복구 경로가 두 배가 된다. 시간은 job-revise.yml의
// 러너 상한(45분) 안에 든다: 판정 3분 + 보충 조사 8분 + 재작성 20분. 그래서 상한을 늘리지 않았다.
//
// 전부 못 찾으면 원고를 건드리지 않는다 - 재작성 자체를 돌리지 않고 사유를 사용자에게 보낸다.

import { appendSupplementalResearch, buildSupplementBlock } from "../research/appendSupplementalResearch.js";
import { collectSupplementalResearch, toSupplementSourceInserts } from "../research/collectSupplementalResearch.js";
import { readPersonSourcePack } from "../research/personSourcePack.js";
import { planRevisionResearch } from "./planRevisionResearch.js";
import { reviseArticleWithFeedback } from "./reviseArticleWithFeedback.js";
import type { CollectSupplementalResearchInput, CollectSupplementalResearchResult, SupplementMissing } from "../research/collectSupplementalResearch.js";
import type { PlanRevisionResearchInput, PlanRevisionResearchResult } from "./planRevisionResearch.js";
import type { ReviseArticleInput, ReviseArticleResult } from "./reviseArticleWithFeedback.js";
import type { SourceInsert } from "../../types/database.js";

export type SupplementSummary = {
  /** 보충 조사 범위로 확정한 항목. 비면 보충 조사를 돌지 않았다. */
  items: string[];
  /** 재료를 확보한 항목. */
  found: string[];
  /** 못 찾은 항목과 사유. 사용자 알림에 그대로 나간다. */
  missing: SupplementMissing[];
  /** 조사 기록(researchFileContent)에 보충 블록을 덧붙였는가. */
  researchAppended: boolean;
  /** sources에 더한 출처 수. */
  sourcesAdded: number;
  /** 항목 판정이 실패했다(수정은 평시 경로로 진행했다). */
  planError?: string;
  /** 보충 조사 에이전트 호출이 실패했다. */
  agentError?: string;
};

export type ReviseWithSupplementalResearchResult = {
  result: ReviseArticleResult;
  supplement: SupplementSummary;
};

export type ReviseWithSupplementalResearchDeps = {
  planItems?: (input: PlanRevisionResearchInput) => Promise<PlanRevisionResearchResult>;
  collect?: (input: CollectSupplementalResearchInput) => Promise<CollectSupplementalResearchResult>;
  revise?: (input: ReviseArticleInput) => Promise<ReviseArticleResult>;
  /** 조사 기록·보충 메타를 job.metadata에 저장한다. */
  mergeJobMetadata?: (jobId: string, patch: Record<string, unknown>) => Promise<unknown>;
  /** 보충 출처를 sources에 더한다. */
  saveSources?: (rows: SourceInsert[]) => Promise<unknown>;
  now?: () => Date;
  log?: (message: string) => void;
};

export type ReviseWithSupplementalResearchInput = {
  jobId: string;
  keyword: string;
  category: string | null;
  metadata: Record<string, unknown> | null;
  originalTitle: string;
  originalBody: string;
  feedback: string;
};

function emptySummary(): SupplementSummary {
  return { items: [], found: [], missing: [], researchAppended: false, sourcesAdded: 0 };
}

export async function reviseWithSupplementalResearch(
  input: ReviseWithSupplementalResearchInput,
  deps: ReviseWithSupplementalResearchDeps = {}
): Promise<ReviseWithSupplementalResearchResult> {
  const planItems = deps.planItems ?? planRevisionResearch;
  const collect = deps.collect ?? collectSupplementalResearch;
  const revise = deps.revise ?? reviseArticleWithFeedback;
  // 저장소는 **동적 import**로 늦게 부른다. 최상단에서 import하면 Supabase 클라이언트가 모듈 로드
  // 시점에 자격증명을 요구해, 주입만으로 검증하는 테스트가 이 모듈을 아예 못 읽는다.
  const mergeJobMetadata =
    deps.mergeJobMetadata ??
    (async (id: string, patch: Record<string, unknown>) => {
      const { ArticleJobRepository } = await import("../../repositories/ArticleJobRepository.js");
      return ArticleJobRepository.mergeMetadata(id, patch);
    });
  const saveSources =
    deps.saveSources ??
    (async (rows: SourceInsert[]) => {
      const { createSources } = await import("../../services/supabase/repositories/sourceRepository.js");
      return createSources(rows);
    });
  const log = deps.log ?? ((message: string) => console.log(message));
  const now = deps.now ?? (() => new Date());

  const metadata = input.metadata ?? {};
  const baseResearch = typeof metadata.researchFileContent === "string" ? metadata.researchFileContent : null;

  const plan = await planItems({
    keyword: input.keyword,
    category: input.category,
    originalTitle: input.originalTitle,
    originalBody: input.originalBody,
    researchText: baseResearch,
    feedback: input.feedback,
  });
  if (plan.error) log(`⚠️ [revise] 조사 항목 판정 실패(보충 조사 없이 진행): ${plan.error}`);

  // 평시 경로: 조사할 것이 없다. 조사 기록만 사실 출처로 함께 넘긴다(2026-11-06부터).
  if (plan.items.length === 0) {
    log("ℹ️ [revise] 보충 조사 없음 - 기존 원고 + 조사 기록으로 재작성합니다");
    const result = await revise({
      keyword: input.keyword,
      category: input.category,
      metadata: input.metadata,
      originalTitle: input.originalTitle,
      originalBody: input.originalBody,
      researchText: baseResearch,
      feedback: input.feedback,
    });
    return { result, supplement: { ...emptySummary(), ...(plan.error ? { planError: plan.error } : {}) } };
  }

  log(`ℹ️ [revise] 보충 조사 항목 ${plan.items.length}개: ${plan.items.join(" / ")}`);

  const collected = await collect({
    keyword: input.keyword,
    category: input.category,
    originalTitle: input.originalTitle,
    items: plan.items,
    sourcePack: readPersonSourcePack(metadata),
    researchText: baseResearch,
  });

  const findings = [...collected.packFindings, ...collected.agentFindings];
  const found = findings.map((f) => f.item);
  const at = now().toISOString();

  // 조사 기록은 **덧붙인다**(원 조사는 감사 기록). 못 찾은 항목까지 남긴다 - "시도했고 없었다"도 기록이다.
  const block = buildSupplementBlock({
    feedback: input.feedback,
    items: plan.items,
    packFindings: collected.packFindings,
    agentFindings: collected.agentFindings,
    missing: collected.missing,
    sources: collected.sources,
    at,
  });
  const nextResearch = appendSupplementalResearch(baseResearch, block);

  const sourceRows = toSupplementSourceInserts(input.jobId, collected.sources);
  let sourcesAdded = 0;
  if (sourceRows.length > 0) {
    try {
      await saveSources(sourceRows);
      sourcesAdded = sourceRows.length;
    } catch (error) {
      // 출처 저장 실패가 수정을 막지는 않는다 - 조사 기록(researchFileContent)에 같은 표가 남는다.
      log(`⚠️ [revise] 보충 출처 저장 실패(조사 기록에는 남아 있음): ${error instanceof Error ? error.message : error}`);
    }
  }

  let researchAppended = true;
  try {
    await mergeJobMetadata(input.jobId, {
      researchFileContent: nextResearch,
      lastSupplementalResearch: { at, items: plan.items, found, missing: collected.missing },
    });
  } catch (error) {
    researchAppended = false;
    log(`⚠️ [revise] 조사 기록 저장 실패: ${error instanceof Error ? error.message : error}`);
  }

  const summary: SupplementSummary = {
    items: plan.items,
    found,
    missing: collected.missing,
    researchAppended,
    sourcesAdded,
    ...(plan.error ? { planError: plan.error } : {}),
    ...(collected.agentError ? { agentError: collected.agentError } : {}),
  };

  // 하나도 못 찾았다 - 원고를 건드리지 않는다. 억지로 고치면 요청과 무관한 글이 된다.
  if (findings.length === 0) {
    const reason = [
      `요청한 자료를 보충 조사했지만 근거를 찾지 못해 원고를 그대로 두었습니다.`,
      ...collected.missing.map((entry) => `· ${entry.item}: ${entry.reason}`),
    ].join("\n");
    log("⚠️ [revise] 보충 조사 결과 없음 - 재작성을 돌리지 않습니다");
    return { result: { status: "blocked", reason, durationMs: 0 }, supplement: summary };
  }

  log(
    `ℹ️ [revise] 보충 조사 완료 - 확보 ${findings.length}/${plan.items.length}` +
      `${collected.missing.length > 0 ? ` · 못 찾음 ${collected.missing.map((m) => m.item).join(", ")}` : ""}`
  );

  const result = await revise({
    keyword: input.keyword,
    category: input.category,
    metadata: input.metadata,
    originalTitle: input.originalTitle,
    originalBody: input.originalBody,
    researchText: nextResearch,
    unavailableItems: collected.missing,
    feedback: input.feedback,
  });

  return { result, supplement: summary };
}

/**
 * 보충 조사 결과를 사용자 알림에 붙일 줄로 만든다(없으면 빈 배열 - 평시 수정 알림은 그대로다).
 * **못 찾은 항목은 반드시 사용자에게 보인다** - 조용히 빠지면 사용자는 반영됐다고 믿는다.
 */
export function describeSupplement(summary: SupplementSummary): string[] {
  if (summary.items.length === 0) return [];
  const lines = [`🔎 보충 조사: ${summary.found.length}/${summary.items.length}건 반영`];
  if (summary.sourcesAdded > 0) lines.push(`출처 ${summary.sourcesAdded}건을 조사 기록에 더했습니다.`);
  if (!summary.researchAppended) lines.push("⚠️ 조사 기록 저장에 실패했습니다(본문에는 반영됨).");
  if (summary.missing.length > 0) {
    lines.push("자료를 못 찾아 넣지 못한 항목:");
    for (const entry of summary.missing) lines.push(`· ${entry.item} — ${entry.reason}`);
  }
  if (summary.agentError) lines.push(`⚠️ 보충 조사 실패: ${summary.agentError}`);
  return lines;
}
