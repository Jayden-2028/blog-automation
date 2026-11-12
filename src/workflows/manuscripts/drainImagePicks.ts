// 뷰어 후보 이미지 클릭 교체 요청을 **큐가 빌 때까지** 처리한다(2026-11-12).
//
// 전에는 run 하나가 요청 하나를 처리했다. 그런데 교체가 1~2분 걸려 사용자는 그 사이 다른 자리도 누르고,
// GitHub은 concurrency 그룹당 **대기분을 하나만** 들고 있어서 한 건이 도는 중에 두 건이 더 들어오면
// 가운데 것이 조용히 취소됐다(대기 중 취소는 스텝이 돌지 않아 알림조차 못 보낸다).
//
// 그래서 요청은 `enqueue` job(concurrency 그룹 **밖**, 항상 즉시 돈다)이 `image_pick_requests`에 적고,
// `apply` job(jobId별 그룹 안)이 **큐를 통째로 비운다.** 대기 중 취소가 무해해진다 - 취소되는 건
// apply뿐이고 요청 행은 이미 DB에 있으며, 뒤에 도는 apply가 그걸 같이 가져간다.
//
// 한 run 안에서는 **직렬**로 적용한다. `ArticleJobRepository.mergeMetadata`는 여전히 버전 검사 없는
// read-modify-write지만, 한 건을 끝내고(DB 쓰기 완료) 다음 건의 loadJob을 하므로 **읽기-쓰기 사이에
// 다른 쓰기가 끼지 않는다** - 2026-11-12 사고는 두 run이 겹쳐 돌아 생긴 것이고, 이제 같은 jobId의
// apply는 한 번에 하나만 돈다(PR #80의 concurrency가 이 설계의 일부다).
//
// 배포와 알림은 **마지막에 한 번**이다. 건마다 배포하면 N번 배포하고 N통을 보낸다(옛 동작).
//
// 마이그레이션 적용 전에는 큐를 읽을 수 없으므로 **옛 경로(단건 처리)로 떨어진다** - 이 파일의
// `mode: "single"`. 그래서 테이블이 없는 상태로 병합해도 기존 동작이 그대로 돈다.

import { applyImagePick } from "./applyImagePick.js";
import type { ApplyImagePickDeps, ImagePickRequest } from "./applyImagePick.js";
import { IMAGE_PICK_PENDING_KEY } from "./viewerEditGuard.js";
import { ImagePickQueueUnavailableError } from "./imagePickQueue.js";
import type { ImagePickQueue, ImagePickQueueItem } from "./imagePickQueue.js";
import type { ManuscriptManifest } from "./manuscriptManifest.js";
import type { ArticleJobRow } from "../../types/database.js";

/** 한 run이 처리할 상한. 평시 교체 1건이 30~60초라 러너 시한(아래 yml의 25분) 안에 든다. */
export const DEFAULT_MAX_ITEMS = 12;
/** 큐를 다시 읽는 횟수 상한. 2바퀴면 "도는 중에 들어온 요청"을 집고, 그 이상은 안전장치다. */
export const DEFAULT_MAX_ROUNDS = 6;
/** 알림 한 줄에 적는 오류 길이 상한. */
const ERROR_LINE_MAX = 120;

export type DrainPickResult = {
  slotIndex: number;
  candidateNumber: number;
  status: "applied" | "failed" | "skipped";
  error?: string;
  alreadyPublished?: boolean;
};

export type DrainImagePicksOutcome = {
  /** "queue" = 큐를 비웠다. "single" = 테이블이 없어 디스패치 payload 한 건만 처리했다(옛 경로). */
  mode: "queue" | "single";
  results: DrainPickResult[];
  /** 마지막에 배포한 횟수(0 또는 1). single 모드에서는 applyImagePick이 직접 배포한다. */
  deploys: number;
  /** 보낸 알림 통수(0 또는 1). */
  notifications: number;
  /** 상한에 걸려 이번 run이 남겨 둔 요청 수. */
  remaining: number;
};

/**
 * 같은 슬롯의 중복을 접는다 - **나중 것이 이긴다.** 순수 함수.
 *
 * 왜 필요한가: 앞 요청이 이미 그 자리를 바꿔 놓으면 뒤 요청의 `fromUrl`은 **당연히 어긋난다**
 * (resolvePick의 경합 검사에 걸린다). 그건 "다른 사람이 그 사이 바꿨다"가 아니라 우리 자신이 바꾼 것이다.
 * 그래서 중복은 여기서 미리 접고, 살아남은 한 건만 적용한다. `fromUrl` 검사 자체는 **다른 경로가 그 사이
 * 바꾼 경우를 잡는 안전장치**로 그대로 남는다.
 */
export function foldSameSlot(items: readonly ImagePickQueueItem[]): { apply: ImagePickQueueItem[]; folded: ImagePickQueueItem[] } {
  const latest = new Map<number, ImagePickQueueItem>();
  const folded: ImagePickQueueItem[] = [];
  // 입력은 requested_at 오름차순이다 - 뒤에 오는 것이 더 나중 요청이므로 앞의 것을 접는다.
  for (const item of items) {
    const previous = latest.get(item.slotIndex);
    if (previous) folded.push(previous);
    latest.set(item.slotIndex, item);
  }
  const apply = items.filter((item) => latest.get(item.slotIndex) === item);
  return { apply, folded };
}

function shorten(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > ERROR_LINE_MAX ? `${flat.slice(0, ERROR_LINE_MAX - 1)}…` : flat;
}

/**
 * 이 run이 처리한 자리를 **한 통으로 묶은** 알림 문구(2026-11-12).
 *
 * 전에는 교체 1건 = 알림 1통이라 한 글에서 3장을 바꾸면 3통이 왔다(run이 건마다 따로 돌아 묶을 수
 * 없었다). 이제 한 run이 큐를 비우므로 묶을 수 있다. 성공·실패·건너뜀이 섞이면 줄로 나눠 적는다.
 *
 * 캡션을 짚는 이유는 전과 같다: 교체는 그림만 바꾸고 캡션(description)은 그대로 둔다.
 */
export function imagePickDrainMessage(keyword: string, results: readonly DrainPickResult[], remaining = 0): string {
  const lines = [`🖼 "${keyword}" 이미지 교체 결과 (${results.length}건)`, ""];
  for (const result of results) {
    const head = `${result.slotIndex}번 ← 후보 ${result.candidateNumber}번`;
    if (result.status === "applied") lines.push(`${head} ✅`);
    else if (result.status === "failed") lines.push(`${head} ❌ ${shorten(result.error ?? "알 수 없는 오류")}`);
    else lines.push(`${head} ⏭ 같은 자리를 더 나중에 눌러서 건너뜀`);
  }
  lines.push("");
  if (results.some((r) => r.status === "applied")) {
    lines.push("캡션은 그대로입니다 - 새 그림과 맞는지 확인하고 필요하면 뷰어에서 고치세요.");
  }
  if (results.some((r) => r.status === "applied" && r.alreadyPublished)) {
    lines.push("이미 발행된 글에는 반영되지 않습니다(원고·뷰어만 바뀜).");
  }
  if (results.some((r) => r.status === "failed")) {
    lines.push('실패한 자리는 다른 후보를 고르거나, 후보가 다 마음에 안 들면 텔레그램 "🖼 이미지 수정"으로 다시 수집하세요.');
  }
  if (remaining > 0) {
    lines.push(`요청 ${remaining}건이 남았습니다 - 뷰어에서 후보를 아무거나 한 번 더 누르면 같이 처리됩니다.`);
  }
  return lines.join("\n").trimEnd();
}

export type DrainImagePicksInput = {
  /** 디스패치 payload. 큐를 못 쓸 때(migration 미적용) 처리할 단건이자, 큐를 읽을 jobId의 출처다. */
  request: ImagePickRequest;
  deps: ApplyImagePickDeps;
  /** null이면 큐를 쓰지 않는다(옛 경로). */
  queue: ImagePickQueue | null;
  maxItems?: number;
  maxRounds?: number;
};

export async function drainImagePicks(input: DrainImagePicksInput): Promise<DrainImagePicksOutcome> {
  const { request, deps, queue } = input;
  const maxItems = input.maxItems ?? DEFAULT_MAX_ITEMS;
  const maxRounds = input.maxRounds ?? DEFAULT_MAX_ROUNDS;

  if (!queue) return single(request, deps, "큐를 쓰지 않습니다(queue 미주입)");

  // 배포·알림은 건마다 하지 않고 모아 둔다 - 마지막에 한 번씩. (클로저가 채우므로 객체에 담는다.)
  const captured: { manifest: ManuscriptManifest | null; job: ArticleJobRow | null } = { manifest: null, job: null };
  const itemDeps: ApplyImagePickDeps = {
    ...deps,
    publishPage: async (manifest) => {
      captured.manifest = manifest;
    },
    notify: async (notifyJob) => {
      captured.job = notifyJob;
    },
  };

  const results: DrainPickResult[] = [];
  let remaining = 0;
  let processedSlots = 0;

  for (let round = 0; round < maxRounds; round += 1) {
    let pending: ImagePickQueueItem[];
    try {
      pending = await queue.listPending(request.jobId);
    } catch (error) {
      if (error instanceof ImagePickQueueUnavailableError && results.length === 0) {
        // 테이블이 아직 없다 - 옛 경로로 떨어진다. 이미 처리한 건이 있으면 떨어뜨리지 않는다(중복 적용 방지).
        return single(request, deps, error.message);
      }
      throw error;
    }
    if (pending.length === 0) break;

    const { apply, folded } = foldSameSlot(pending);

    for (const item of folded) {
      await markQuietly(queue, item.id, "skipped", "같은 슬롯의 더 나중 요청이 있습니다");
      results.push({ slotIndex: item.slotIndex, candidateNumber: item.candidateNumber, status: "skipped" });
    }

    for (const item of apply) {
      if (processedSlots >= maxItems) {
        remaining = apply.length - apply.indexOf(item);
        console.warn(`⚠️ 한 run 상한(${maxItems}건)에 걸려 ${remaining}건을 남겨 둡니다 - 다음 요청이 이어서 비웁니다.`);
        break;
      }
      processedSlots += 1;
      const outcome = await applyImagePick(
        { jobId: item.jobId, index: item.slotIndex, candidateNumber: item.candidateNumber, fromUrl: item.fromUrl },
        itemDeps
      );
      if (outcome.status === "applied") {
        await markQuietly(queue, item.id, "done");
        results.push({
          slotIndex: item.slotIndex,
          candidateNumber: item.candidateNumber,
          status: "applied",
          alreadyPublished: outcome.record.alreadyPublished === true,
        });
        console.log(`✅ ${item.slotIndex}번 ← 후보 ${item.candidateNumber}번`);
      } else {
        await markQuietly(queue, item.id, "failed", outcome.reason);
        results.push({ slotIndex: item.slotIndex, candidateNumber: item.candidateNumber, status: "failed", error: outcome.reason });
        console.error(`❌ ${item.slotIndex}번 ← 후보 ${item.candidateNumber}번: ${outcome.reason}`);
      }
    }
    if (remaining > 0) break;
  }

  if (results.length === 0) {
    // 큐가 비어 있었다(앞 run이 이미 비웠다). **진행 중 표식은 풀어 준다** - enqueue가 쓴 표식을 그냥
    // 두면 발행 폴러·텔레그램 콜백이 10분(EDIT_PENDING_STALE_MS) 동안 이 원고를 집지 않는다.
    try {
      await deps.mergeJobMetadata(request.jobId, { [IMAGE_PICK_PENDING_KEY]: null });
    } catch (error) {
      console.warn(`⚠️ 진행 중 표식 해제 실패(무시): ${error instanceof Error ? error.message : error}`);
    }
    console.log("ℹ️ 처리할 교체 요청이 없습니다(앞 run이 이미 비웠습니다).");
    return { mode: "queue", results, deploys: 0, notifications: 0, remaining: 0 };
  }

  // 배포 한 번. 마지막 적용이 만든 manifest에는 이 run이 바꾼 모든 자리가 들어 있다(건마다 loadManifest로
  // 다시 읽고 saveTopic으로 적은 뒤이므로).
  let deploys = 0;
  if (captured.manifest) {
    await deps.publishPage(captured.manifest);
    deploys = 1;
  }

  // 알림 한 통. 배포까지 끝난 뒤 보낸다 - 알림을 보고 페이지를 열었을 때 이미 바뀐 그림이 보여야 한다.
  let notifications = 0;
  const target = captured.job ?? (await deps.loadJob(request.jobId).catch(() => null));
  if (target) {
    try {
      await deps.notify(target, imagePickDrainMessage(target.keyword, results, remaining));
      notifications = 1;
    } catch (error) {
      console.warn(`⚠️ 텔레그램 알림 실패(무시): ${error instanceof Error ? error.message : error}`);
    }
  }

  return { mode: "queue", results, deploys, notifications, remaining };
}

/** 큐를 쓸 수 없을 때의 옛 경로 - applyImagePick이 직접 배포하고 직접 알린다(2026-11-12 이전 동작). */
async function single(request: ImagePickRequest, deps: ApplyImagePickDeps, why: string): Promise<DrainImagePicksOutcome> {
  console.warn(`⚠️ 큐 없이 단건으로 처리합니다: ${why}`);
  const outcome = await applyImagePick(request, deps);
  const result: DrainPickResult =
    outcome.status === "applied"
      ? {
          slotIndex: request.index,
          candidateNumber: request.candidateNumber,
          status: "applied",
          alreadyPublished: outcome.record.alreadyPublished === true,
        }
      : { slotIndex: request.index, candidateNumber: request.candidateNumber, status: "failed", error: outcome.reason };
  return { mode: "single", results: [result], deploys: 1, notifications: 1, remaining: 0 };
}

/** 큐 마감 실패가 드레인을 멈추면 안 된다 - 이미 적용한 교체가 알림도 배포도 없이 끝난다. */
async function markQuietly(queue: ImagePickQueue, id: string, status: "done" | "failed" | "skipped", error?: string): Promise<void> {
  try {
    await queue.markProcessed(id, status, error);
  } catch (markError) {
    console.warn(`⚠️ 큐 행 마감 실패(무시하고 계속, id=${id}): ${markError instanceof Error ? markError.message : markError}`);
  }
}
