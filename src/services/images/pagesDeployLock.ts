// 공개 이미지 Pages 프로젝트에 배포하는 동안 다른 발행이 끼어들지 못하게 잡는 뮤텍스(2026-11-12).
//
// 왜 Cloudflare 배포 목록 API로는 안 되는가(세 번째 재발에서 실측): Pages 배포는 **1.3~1.8초**면
// 끝난다(02:22:59.9→02:23:01.5, 02:23:15.2→02:23:16.5, 02:23:23.8→02:23:25.6). 그런데 정작 다투는
// 구간은 **파일 목록(manifest)을 읽고 → 기존 전량을 내려받아 → 배포를 만드는** 15~25초다. 이 구간은
// 배포 목록 API에 아무 흔적이 없으므로, "진행 중인 배포 0건"은 "지금 아무도 스냅샷을 만들고 있지
// 않다"는 뜻이 **아니다**. 그래서 락을 Cloudflare 밖, 러너가 모두 공유하는 Supabase에 둔다.
//
// 설계는 pipeline_lock(heavy-pipeline 뮤텍스)과 같다 - 조건부 UPDATE 하나가 Postgres 행 잠금으로
// 원자적이라(SQL compare-and-swap) 여러 러너가 같은 순간에 시도해도 정확히 하나만 성공한다.
// pipeline_lock을 재사용하지 않는 이유: 그쪽은 조사·집필(15~25분)이 쥐고 있어서 발행 버튼이
// 그만큼 멈춘다. 다투는 자원이 다르면 락도 달라야 한다.
//
// 주의: 이 락은 **테이블이 적용된 뒤에만** 효력이 있다(migration은 사용자 승인 뒤 `supabase db push`).
// 적용 전에는 `unavailable`을 돌려주고 호출부가 락 없이 진행한다 - 그 경우에도 rehostImagesToPages의
// 두 그물(배포 직전 목록 재확인 · 검증 통과 뒤 지켜보기)이 받는다.

import type { PagesDeployLockRow } from "../../types/database.js";

/** 러너가 비정상 종료돼 release를 못 불러도 이만큼 지나면 다음 발행이 회수한다(발행 한 건은 1~2분). */
export const LEASE_MS = 8 * 60 * 1000;
/** 앞 발행이 끝나기를 기다리는 상한. telegram-update 시한(15분) 안에서 넉넉히 잡는다. */
export const LOCK_WAIT_MS = 5 * 60 * 1000;
const POLL_MS = 3_000;

export type PagesDeployLockHandle = { release: () => Promise<void> };

export type PagesDeployLockResult =
  | { status: "held"; handle: PagesDeployLockHandle; waitedMs: number }
  /** 테이블이 아직 없다(migration 미적용) - 락 없이 진행한다. */
  | { status: "unavailable"; detail: string }
  /** 상한까지 기다렸는데 앞 발행이 안 놓았다 - 락 없이 진행한다(발행을 막지 않는다). */
  | { status: "timeout"; holder: string | null };

/** 테스트 주입용으로 좁힌 Supabase 인터페이스(PostgREST 체인 중 쓰는 것만). */
export type LockTable = {
  update: (patch: Record<string, unknown>) => {
    eq: (column: string, value: unknown) => {
      lte: (column: string, value: unknown) => { select: (columns: string) => Promise<LockQueryResult> };
      eq: (column: string, value: unknown) => { select: (columns: string) => Promise<LockQueryResult> };
    };
  };
  insert: (row: Record<string, unknown>) => { select: (columns: string) => Promise<LockQueryResult> };
  select: (columns: string) => { eq: (column: string, value: unknown) => { maybeSingle: () => Promise<LockRowResult> } };
};
type LockQueryResult = { data: unknown[] | null; error: { code?: string | null; message?: string | null } | null };
type LockRowResult = { data: Partial<PagesDeployLockRow> | null; error: { code?: string | null; message?: string | null } | null };

export type PagesDeployLockDeps = {
  /** 기본은 supabase.from("pages_deploy_lock"). */
  table?: () => LockTable;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  waitMs?: number;
  leaseMs?: number;
};

/** 테이블이 아직 없다(migration 미적용) - imagePickQueue.isQueueTableMissing과 같은 판정. */
export function isLockTableMissing(error: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!error) return false;
  const code = error.code ?? "";
  const message = (error.message ?? "").toLowerCase();
  return code === "42P01" || code === "PGRST205" || message.includes("pages_deploy_lock") && (message.includes("does not exist") || message.includes("could not find the table"));
}

async function defaultTable(): Promise<LockTable> {
  const { supabase } = await import("../supabase/client.js");
  return supabase.from("pages_deploy_lock") as unknown as LockTable;
}

/**
 * 프로젝트 하나에 대한 배포 락을 잡는다. 성공하면 호출부가 **배포와 검증까지 끝낸 뒤** release를 부른다.
 * 실패(테이블 없음·대기 상한)는 던지지 않는다 - 발행을 막지 않고 호출부가 락 없이 진행한다.
 */
export async function acquirePagesDeployLock(
  input: { project: string; holder: string },
  deps: PagesDeployLockDeps = {}
): Promise<PagesDeployLockResult> {
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const waitMs = deps.waitMs ?? LOCK_WAIT_MS;
  const leaseMs = deps.leaseMs ?? LEASE_MS;
  const table = deps.table ?? (() => { throw new Error("default"); });
  const getTable = async (): Promise<LockTable> => {
    try {
      return table();
    } catch {
      return defaultTable();
    }
  };

  const startedAt = now().getTime();
  const release = async (): Promise<void> => {
    const db = await getTable();
    // expires_at을 지금으로 당기면 다음 시도가 곧바로 가져간다(holder는 감사용으로 남긴다).
    await db.update({ expires_at: now().toISOString() }).eq("project", input.project).eq("holder", input.holder).select("project");
  };

  for (;;) {
    const db = await getTable();
    const stamp = now();
    const patch = {
      holder: input.holder,
      locked_at: stamp.toISOString(),
      expires_at: new Date(stamp.getTime() + leaseMs).toISOString(),
    };

    // 1) 비었거나 만료된 락을 가로챈다. 조건부 UPDATE 하나라 원자적이다.
    const taken = await db.update(patch).eq("project", input.project).lte("expires_at", stamp.toISOString()).select("project");
    if (isLockTableMissing(taken.error)) return { status: "unavailable", detail: taken.error?.message ?? "pages_deploy_lock 없음" };
    if (!taken.error && (taken.data?.length ?? 0) > 0) return { status: "held", handle: { release }, waitedMs: now().getTime() - startedAt };

    // 2) 행이 아직 없으면 만든다. 같은 순간에 둘이 넣으면 PK 충돌로 하나만 성공한다.
    const created = await db.insert({ project: input.project, ...patch }).select("project");
    if (isLockTableMissing(created.error)) return { status: "unavailable", detail: created.error?.message ?? "pages_deploy_lock 없음" };
    if (!created.error && (created.data?.length ?? 0) > 0) return { status: "held", handle: { release }, waitedMs: now().getTime() - startedAt };

    // 3) 누가 쥐고 있다. 상한까지 기다린다.
    if (now().getTime() - startedAt >= waitMs) {
      const current = await db.select("holder").eq("project", input.project).maybeSingle();
      return { status: "timeout", holder: (current.data?.holder as string | null | undefined) ?? null };
    }
    await sleep(POLL_MS);
  }
}

/** GitHub Actions run / 로컬 실행을 구분해 남긴다 - 락이 안 풀렸을 때 누가 쥐고 있었는지 본다. */
export function lockHolderId(jobId: string): string {
  const run = process.env.GITHUB_RUN_ID ? `run-${process.env.GITHUB_RUN_ID}` : "local";
  return `${run}:${jobId}`;
}
