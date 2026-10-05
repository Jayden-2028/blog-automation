// 인스타 큐 버튼 선택 가드 테스트(applyTrackPick). 실행: npm run test:ig-queue-guard
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyTrackPick, readQueue } from "./instagramQueue.js";
import type { InstagramQueueEntry } from "./types.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const entry = (id: string, over: Partial<InstagramQueueEntry> = {}): InstagramQueueEntry =>
  ({ id, instagramUrl: `https://www.instagram.com/p/${id}/`, rawCaption: "", telegramChatId: "1", telegramMessageId: 1, receivedAt: "x", attempts: 0, status: "needs_track", ...over }) as InstagramQueueEntry;

const path = join(mkdtempSync(join(tmpdir(), "ig-queue-")), "q.jsonl");
const seed = [
  entry("tg-1"),
  entry("tg-2", { status: "done", track: "social", jobId: "job-x" }),
  entry("tg-3", { status: "pending", track: "social" }),
  entry("tg-4", { status: "needs_topic" }),
];
writeFileSync(path, seed.map((e) => JSON.stringify(e)).join("\n") + "\n");

assert(applyTrackPick("tg-1", "entertainment", path) === "applied", "needs_track은 적용");
const one = readQueue(path).find((e) => e.id === "tg-1")!;
assert(one.status === "pending" && one.track === "entertainment", "적용 결과 pending + 트랙");

assert(applyTrackPick("tg-2", "entertainment", path) === "already_handled", "done은 되돌리지 않는다");
const two = readQueue(path).find((e) => e.id === "tg-2")!;
assert(two.status === "done" && two.track === "social" && two.jobId === "job-x", "done 항목은 그대로");

assert(applyTrackPick("tg-3", "entertainment", path) === "already_handled", "pending도 무시");
assert(readQueue(path).find((e) => e.id === "tg-3")!.track === "social", "pending 트랙 유지");
assert(applyTrackPick("tg-4", "social", path) === "already_handled", "needs_topic도 무시");
assert(applyTrackPick("tg-9", "social", path) === "not_found", "없는 id");
// 같은 버튼을 두 번 눌러도 두 번째는 무시
assert(applyTrackPick("tg-1", "social", path) === "already_handled", "재클릭 무시");
assert(readQueue(path).find((e) => e.id === "tg-1")!.track === "entertainment", "재클릭이 트랙을 바꾸지 않는다");
console.log("✅ 인스타 큐 버튼 선택 가드");
