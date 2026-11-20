// 맥미니 scenepick 대기열(job.metadata.scenepickCodex, 2026-11-21). 제미나이 그림자 대기열(gemini-person/geminiShadowQueue.ts)과
// 같은 구조이고 같은 이유다: Codex CLI와 ChatGPT 구독 로그인이 맥미니에만 있다. 클라우드(텔레그램 접수)는 status=requested만
// 남기고 맥미니 폴러가 집는다.
//
//   requested                       -> 대기 중(가장 오래된 것부터)
//   running, 심장 박동 60분 이내    -> 진행 중(건드리지 않는다)
//   running, 60분 넘게 소식 없음    -> 잔재. 집은 횟수가 2 미만이면 다시 집고, 아니면 실패로 닫는다
//   done | failed                   -> 끝
//
// 심장 박동(heartbeatAt): Codex 1회 상한이 40분이고 재작업까지 2회면 80분이다. startedAt만 보면 정상 진행 중인 두 번째 회차를
// 잔재로 오판한다 - 회차를 시작할 때마다 heartbeatAt을 새로 적어 판정이 그 시각을 본다.
//
// claim: 같은 맥의 겹친 폴러는 파일 락이 막고(scenepickPollJob), 락이 풀린 뒤에도 같은 job을 두 번 집지 않게
// "claimId를 병합하고 다시 읽어 내 claimId가 맞는지 확인"한다.
import { randomUUID } from "node:crypto";

import { ArticleJobRepository } from "../../repositories/ArticleJobRepository.js";
import { supabase } from "../../services/supabase/client.js";
import { readScenepickState } from "./scenepickTypes.js";
import type { ScenepickCodexState, ScenepickCodexStatus } from "./scenepickTypes.js";

export const STALE_RUNNING_MS = 60 * 60 * 1000;
/** 폴러가 같은 job을 집는 상한(첫 집기 + 잔재 재집기 1회). */
export const MAX_CLAIMS = 2;

export type ScenepickPendingRow = {
  id: string;
  state: Pick<ScenepickCodexState, "status" | "requestedAt" | "startedAt" | "heartbeatAt" | "claims">;
};

/** 가벼운 조회: 스칼라 몇 개만 받는다(egress - 2026-10 Supabase 용량 사고). scenepick job만 본다. */
export async function loadScenepickRows(limit = 50): Promise<ScenepickPendingRow[]> {
  // 별칭이 든 select 문자열은 supabase 타입 추론이 너무 깊어져(TS2589) 결과 타입을 직접 단언한다(geminiShadowQueue와 같다).
  const query = supabase.from("article_jobs") as unknown as {
    select: (columns: string) => {
      filter: (column: string, op: string, value: string) => {
        in: (column: string, values: string[]) => {
          order: (column: string, o: { ascending: boolean }) => { limit: (n: number) => Promise<{ data: unknown; error: Error | null }> };
        };
      };
    };
  };
  const { data, error } = await query
    .select(
      "id, status:metadata->scenepickCodex->>status, requestedAt:metadata->scenepickCodex->>requestedAt, startedAt:metadata->scenepickCodex->>startedAt, heartbeatAt:metadata->scenepickCodex->>heartbeatAt, claims:metadata->scenepickCodex->>claims"
    )
    .filter("metadata->>track", "eq", "scenepick")
    .in("metadata->scenepickCodex->>status", ["requested", "running"])
    .order("selected_at", { ascending: true })
    .limit(limit);
  if (error) throw error;
  const rows: ScenepickPendingRow[] = [];
  for (const row of (data ?? []) as unknown as Record<string, string | null>[]) {
    if (!row.requestedAt || !row.status) continue;
    rows.push({
      id: String(row.id),
      state: {
        status: row.status as ScenepickCodexStatus,
        requestedAt: row.requestedAt,
        ...(row.startedAt ? { startedAt: row.startedAt } : {}),
        ...(row.heartbeatAt ? { heartbeatAt: row.heartbeatAt } : {}),
        ...(row.claims ? { claims: Number(row.claims) } : {}),
      },
    });
  }
  return rows;
}

export type ScenepickDue = { kind: "fresh"; id: string } | { kind: "stale"; id: string } | { kind: "exhausted"; id: string };

/** 이번 주기에 할 일 하나(가장 오래된 것). 순수 함수. exhausted는 집지 않고 실패로 닫아야 하는 잔재다. */
export function pickScenepickDue(rows: readonly ScenepickPendingRow[], now: Date): ScenepickDue | null {
  const sorted = [...rows].sort((a, b) => a.state.requestedAt.localeCompare(b.state.requestedAt));
  for (const { id, state } of sorted) {
    if (state.status === "requested") return { kind: "fresh", id };
    if (state.status !== "running") continue;
    const beat = Date.parse(state.heartbeatAt ?? state.startedAt ?? "");
    const stale = !Number.isFinite(beat) || now.getTime() - beat > STALE_RUNNING_MS;
    if (!stale) continue; // 다른 폴러(또는 이 맥의 앞선 실행)가 진행 중
    return (state.claims ?? 1) >= MAX_CLAIMS ? { kind: "exhausted", id } : { kind: "stale", id };
  }
  return null;
}

export type ScenepickQueueDeps = {
  findJob?: (jobId: string) => Promise<{ metadata: Record<string, unknown> } | null>;
  mergeMetadata?: (jobId: string, patch: Record<string, unknown>) => Promise<unknown>;
  now?: () => Date;
  newClaimId?: () => string;
};

function depsOf(deps: ScenepickQueueDeps) {
  return {
    findJob: deps.findJob ?? ((id: string) => ArticleJobRepository.findById(id)),
    merge: deps.mergeMetadata ?? ((id: string, patch: Record<string, unknown>) => ArticleJobRepository.mergeMetadata(id, patch)),
    now: deps.now ?? (() => new Date()),
  };
}

/** 집는다. 병합 뒤 다시 읽어 내 claimId가 아니면(다른 폴러가 먼저) false. */
export async function claimScenepick(jobId: string, deps: ScenepickQueueDeps = {}): Promise<boolean> {
  const { findJob, merge, now } = depsOf(deps);
  const current = readScenepickState((await findJob(jobId))?.metadata);
  if (!current || current.status === "done" || current.status === "failed") return false;
  const claimId = (deps.newClaimId ?? randomUUID)();
  const at = now().toISOString();
  const next: ScenepickCodexState = {
    ...current,
    status: "running",
    claimId,
    startedAt: at,
    heartbeatAt: at,
    claims: (current.claims ?? 0) + 1,
  };
  await merge(jobId, { scenepickCodex: next });
  const confirmed = readScenepickState((await findJob(jobId))?.metadata);
  return confirmed?.claimId === claimId;
}

/** 진행 상태 갱신(심장 박동·회차 수·검사 실패 항목). 기존 값 위에 덮는다. */
export async function patchScenepickState(jobId: string, patch: Partial<ScenepickCodexState>, deps: ScenepickQueueDeps = {}): Promise<ScenepickCodexState | null> {
  const { findJob, merge } = depsOf(deps);
  const current = readScenepickState((await findJob(jobId))?.metadata);
  if (!current) return null;
  const next = { ...current, ...patch };
  await merge(jobId, { scenepickCodex: next });
  return next;
}

/** 같은 텔레그램 메시지로 이미 만든 scenepick job(접수 중복 방지). id만 받는다. */
export async function findScenepickJobByMessageId(messageId: number): Promise<{ id: string } | null> {
  const { data, error } = await supabase
    .from("article_jobs")
    .select("id")
    .filter("metadata->>track", "eq", "scenepick")
    .filter("metadata->>scenepickMessageId", "eq", String(messageId))
    .limit(1);
  if (error) throw error;
  const row = (data ?? [])[0] as { id?: unknown } | undefined;
  return row?.id ? { id: String(row.id) } : null;
}

export const EXHAUSTED_MESSAGE = "맥미니 폴러가 두 번 집었지만 끝내지 못했습니다(60분 넘게 소식 없음).";
