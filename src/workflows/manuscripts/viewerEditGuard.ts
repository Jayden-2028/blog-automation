// 뷰어 수정·이미지 교체가 **진행 중인지** 판단하는 가드(2026-10-07 VIEWER-REFINE §2-c·§3-c).
//
// 왜 필요한가: 반영 요청은 GitHub Actions에서 1~2분 걸린다. 그 사이 발행 큐 폴러(60초)나 텔레그램 발행 콜백이
// 옛 본문·옛 이미지를 집어 가면 "고쳤는데 옛 글이 올라가는" 경합이 생긴다.
//
// 표식은 job.metadata 안의 시각 두 쌍이다. 요청 접수 시 `...PendingAt`을 쓰고, 끝나면(성공이든 실패든)
// 완료 기록(`viewerEdit.appliedAt` / `imagePick.at`)이 그 뒤 시각으로 남는다. 완료 기록이 접수 시각보다
// 늦으면 끝난 것이다. 영구 차단은 하지 않는다 - 10분이 넘으면 반영 실패로 보고 막지 않는다(stale).

export const VIEWER_EDIT_PENDING_KEY = "viewerEditPendingAt";
export const IMAGE_PICK_PENDING_KEY = "imagePickPendingAt";
export const IMAGE_PICK_RECORD_KEY = "imagePick";

/** 이보다 오래 접수 상태면 반영이 죽은 것으로 본다. */
export const EDIT_PENDING_STALE_MS = 10 * 60 * 1000;

export type EditPendingState =
  | { state: "idle" }
  | { state: "pending"; kind: "viewerEdit" | "imagePick"; since: string }
  | { state: "stale"; kind: "viewerEdit" | "imagePick"; since: string };

function asIso(value: unknown): string | null {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;
}

function finishedAt(metadata: Record<string, unknown>, key: string, field: string): string | null {
  const record = metadata[key];
  if (!record || typeof record !== "object") return null;
  return asIso((record as Record<string, unknown>)[field]);
}

function check(
  metadata: Record<string, unknown>,
  kind: "viewerEdit" | "imagePick",
  pendingKey: string,
  doneKey: string,
  doneField: string,
  nowMs: number
): EditPendingState {
  const pendingAt = asIso(metadata[pendingKey]);
  if (!pendingAt) return { state: "idle" };
  const done = finishedAt(metadata, doneKey, doneField);
  if (done && Date.parse(done) >= Date.parse(pendingAt)) return { state: "idle" };
  return nowMs - Date.parse(pendingAt) > EDIT_PENDING_STALE_MS
    ? { state: "stale", kind, since: pendingAt }
    : { state: "pending", kind, since: pendingAt };
}

/** 두 종류의 진행 중 요청을 본다. pending이 stale보다 우선한다(하나라도 진짜 진행 중이면 기다린다). */
export function readEditPending(metadata: Record<string, unknown> | null | undefined, nowMs: number = Date.now()): EditPendingState {
  const meta = metadata ?? {};
  const states = [
    check(meta, "viewerEdit", VIEWER_EDIT_PENDING_KEY, "viewerEdit", "appliedAt", nowMs),
    check(meta, "imagePick", IMAGE_PICK_PENDING_KEY, IMAGE_PICK_RECORD_KEY, "at", nowMs),
  ];
  return states.find((s) => s.state === "pending") ?? states.find((s) => s.state === "stale") ?? { state: "idle" };
}
