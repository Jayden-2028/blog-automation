// 맥미니 대기열(job.metadata.geminiShadow) - 클라우드가 requestedAt만 남기고 맥미니 폴러가 집어 간다.
// Codex 조사 대기열(workflows/research/localResearchQueue.ts)과 같은 구조이고 같은 이유다: agy는 맥미니에만
// 로그인돼 있다. status를 새로 만들지 않는다 - 대기·진행·끝남은 이 키 안의 시각들이 드러낸다.
//
//   requestedAt만 있음            -> 대기 중
//   startedAt 있고 finishedAt 없음 -> 진행 중(40분을 넘기면 잔재로 보고 1회만 다시 집는다)
//   finishedAt 있음               -> 끝남(성공 또는 error)
//
// claim: 같은 맥의 겹친 폴러는 파일 락이 막고(geminiPersonPollJob), 락이 풀린 뒤에도 같은 job을 두 번 집지 않게
// "startedAt+claimId를 병합하고 다시 읽어 내 claimId가 맞는지 확인"한다.

import { randomUUID } from "node:crypto";

import { ArticleJobRepository } from "../../repositories/ArticleJobRepository.js";
import { supabase } from "../../services/supabase/client.js";
import { readGeminiShadow } from "./geminiShadowTypes.js";
import type { GeminiShadow } from "./geminiShadowTypes.js";

export const STALE_START_MS = 40 * 60 * 1000;
export const MAX_ATTEMPTS = 2;

export type PendingRow = { id: string; shadow: Pick<GeminiShadow, "requestedAt" | "startedAt" | "finishedAt" | "attempts"> };

/** 가벼운 조회: 스칼라 네 개만 받는다(본문·조사 노트를 100행씩 받지 않는다 - egress). */
export async function loadShadowRows(limit = 100): Promise<PendingRow[]> {
  // 별칭이 든 select 문자열은 supabase 타입 추론이 너무 깊어져(TS2589) 결과 타입을 직접 단언한다.
  const query = supabase.from("article_jobs") as unknown as {
    select: (columns: string) => {
      eq: (column: string, value: string) => { order: (column: string, o: { ascending: boolean }) => { limit: (n: number) => Promise<{ data: unknown; error: Error | null }> } };
    };
  };
  const { data, error } = await query
    .select(
      "id, requestedAt:metadata->geminiShadow->>requestedAt, startedAt:metadata->geminiShadow->>startedAt, finishedAt:metadata->geminiShadow->>finishedAt, attempts:metadata->geminiShadow->>attempts"
    )
    .eq("category", "person")
    .order("selected_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  const rows: PendingRow[] = [];
  for (const row of (data ?? []) as unknown as Record<string, string | null>[]) {
    if (!row.requestedAt) continue;
    rows.push({
      id: String(row.id),
      shadow: {
        requestedAt: row.requestedAt,
        ...(row.startedAt ? { startedAt: row.startedAt } : {}),
        ...(row.finishedAt ? { finishedAt: row.finishedAt } : {}),
        ...(row.attempts ? { attempts: Number(row.attempts) } : {}),
      },
    });
  }
  return rows;
}

export type DueDecision =
  | { kind: "fresh"; id: string }
  | { kind: "stale"; id: string }
  | { kind: "exhausted"; id: string };

/** 이번 주기에 할 일 하나(가장 오래된 것). 순수 함수. exhausted는 집지 않고 실패로 닫아야 하는 잔재다. */
export function pickDue(rows: readonly PendingRow[], now: Date): DueDecision | null {
  const sorted = [...rows].sort((a, b) => a.shadow.requestedAt.localeCompare(b.shadow.requestedAt));
  for (const { id, shadow } of sorted) {
    if (shadow.finishedAt) continue;
    if (!shadow.startedAt) return { kind: "fresh", id };
    const started = Date.parse(shadow.startedAt);
    const stale = !Number.isFinite(started) || now.getTime() - started > STALE_START_MS;
    if (!stale) continue; // 다른 곳에서 진행 중
    return (shadow.attempts ?? 1) >= MAX_ATTEMPTS ? { kind: "exhausted", id } : { kind: "stale", id };
  }
  return null;
}

export type QueueDeps = {
  findJob?: (jobId: string) => Promise<{ metadata: Record<string, unknown> } | null>;
  mergeMetadata?: (jobId: string, patch: Record<string, unknown>) => Promise<unknown>;
  now?: () => Date;
  newClaimId?: () => string;
};

/** 집는다. 병합 뒤 다시 읽어 내 claimId가 아니면(다른 폴러가 먼저) false. */
export async function claimGeminiShadow(jobId: string, deps: QueueDeps = {}): Promise<boolean> {
  const findJob = deps.findJob ?? ((id: string) => ArticleJobRepository.findById(id));
  const merge = deps.mergeMetadata ?? ((id: string, patch: Record<string, unknown>) => ArticleJobRepository.mergeMetadata(id, patch));
  const job = await findJob(jobId);
  const current = readGeminiShadow(job?.metadata);
  if (!current || current.finishedAt) return false;
  const claimId = (deps.newClaimId ?? randomUUID)();
  const next: GeminiShadow = {
    requestedAt: current.requestedAt,
    startedAt: (deps.now ?? (() => new Date()))().toISOString(),
    claimId,
    attempts: (current.attempts ?? (current.startedAt ? 1 : 0)) + 1,
  };
  await merge(jobId, { geminiShadow: next });
  const confirmed = readGeminiShadow((await findJob(jobId))?.metadata);
  return confirmed?.claimId === claimId;
}

/** 재시도 한도를 넘긴 잔재를 실패로 닫는다. */
export async function closeExhausted(jobId: string, deps: QueueDeps = {}): Promise<void> {
  const findJob = deps.findJob ?? ((id: string) => ArticleJobRepository.findById(id));
  const merge = deps.mergeMetadata ?? ((id: string, patch: Record<string, unknown>) => ArticleJobRepository.mergeMetadata(id, patch));
  const current = readGeminiShadow((await findJob(jobId))?.metadata);
  if (!current || current.finishedAt) return;
  await merge(jobId, {
    geminiShadow: { ...current, finishedAt: (deps.now ?? (() => new Date()))().toISOString(), error: "맥미니 폴러가 두 번 집었지만 끝내지 못했다(40분 초과). 수동 재실행: npm run job:gemini-person-poll -- <jobId> --force" },
  });
}
