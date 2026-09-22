// 인스타 URL 큐 - 로컬 JSONL 파일 하나로 관리한다.
//
// 왜 DB가 아니라 파일인가: 이 큐는 "아직 브라우저로 안 본" 상태를 담는데, 그 처리(캐러셀 캡처)는
// 사람(Claude 인터랙티브 세션)만 할 수 있어 article_jobs의 상태 머신(researching/writing...) 안에
// 넣을 이유가 없다 - job은 캡처가 끝난 뒤에야 생긴다(createManual). telegram_offsets/article_jobs와
// 달리 launchd 반복 실행 사이에 공유될 필요도 없다(폴러 한 프로세스 안에서만 append한다).
//
// 파일 형식: 한 줄 = InstagramQueueEntry 하나(JSON). 재작성 시 전체를 다시 쓴다(건수가 적어 비용 무시).

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { PIPELINE_ROOT } from "../../config/pipelinePaths.js";
import type { InstagramQueueEntry } from "./types.js";

// 다른 파이프라인 산출물과 같은 뿌리를 쓴다(2026-09-22). 예전에는 맨 `resolve("data/...")`라
// process.cwd()에 묶여, PIPELINE_ROOT를 설정한 프로세스에서 부르면 큐 파일이 두 개로 갈라졌다.
// launchd는 cd $REPO를 하니 지금까지는 우연히 맞았을 뿐이다.
export const INSTAGRAM_QUEUE_PATH = resolve(PIPELINE_ROOT, "data/instagram-queue.jsonl");

async function ensureDir(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}

export function readQueue(path: string = INSTAGRAM_QUEUE_PATH): InstagramQueueEntry[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const entries: InstagramQueueEntry[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as InstagramQueueEntry);
    } catch {
      // 손상된 줄은 건너뛴다(수동 편집 등) - 큐 전체를 죽이지 않는다.
    }
  }
  return entries;
}

// 임시 파일에 다 쓰고 rename으로 갈아끼운다(2026-09-22). 전체 재작성이라 쓰는 도중에 죽으면
// 큐가 잘린 채로 남는데, rename은 같은 파일시스템에서 원자적이라 독자는 옛 파일 아니면 새 파일만
// 본다. 단, 읽고-고쳐-쓰기 사이의 유실(폴러와 캡처 세션이 동시에 갱신)까지 막지는 못한다 -
// 창이 좁고 실제로 겹친 적이 없어 락은 붙이지 않았다.
function writeQueue(entries: InstagramQueueEntry[], path: string): void {
  const text = entries.map((e) => JSON.stringify(e)).join("\n");
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text.length > 0 ? `${text}\n` : "", "utf8");
  renameSync(tmp, path);
}

export async function appendQueueEntry(
  entry: InstagramQueueEntry,
  path: string = INSTAGRAM_QUEUE_PATH
): Promise<void> {
  await ensureDir(path);
  const entries = readQueue(path);
  // 같은 telegram update가 재전달돼도(폴링 재시도 등) 같은 id면 중복 적재하지 않는다.
  if (entries.some((e) => e.id === entry.id)) return;
  entries.push(entry);
  writeQueue(entries, path);
}

export function listPendingEntries(path: string = INSTAGRAM_QUEUE_PATH): InstagramQueueEntry[] {
  return readQueue(path).filter((e) => e.status === "pending");
}

export function markEntry(
  id: string,
  patch: Partial<Pick<InstagramQueueEntry, "status" | "jobId" | "attempts" | "lastError">>,
  path: string = INSTAGRAM_QUEUE_PATH
): void {
  const entries = readQueue(path);
  const idx = entries.findIndex((e) => e.id === id);
  if (idx === -1) return;
  entries[idx] = { ...entries[idx], ...patch };
  writeQueue(entries, path);
}
