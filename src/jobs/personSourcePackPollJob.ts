// 인물 백과 소스팩 수집 폴러 - 맥에서만 돈다(2026-10-15, WRITING-HUMANIZE B-1).
//
// 하는 일 하나: 소스팩이 없는 최근 person job에 네이버 인물DB·나무위키 원문을 채워 넣는다. 클라우드 러너(job-research)는
// 이 팩을 최대 8분 기다렸다 프롬프트에 싣는다. 대기열이 없으면 조용히 끝난다(DB 조회 1회).
//
// 실행: npm run job:person-pack  (launchd 1분 주기 권장 - 폴러·plist 변경은 사용자 승인, 이 파일은 실행만 한다)
import "dotenv/config";

import { resolve } from "node:path";

import { acquireSingleInstanceLock } from "./lib/singleInstanceLock.js";
import { collectPersonSourcePacks, defaultCollectPersonSourcePackDeps } from "../workflows/research/collectPersonSourcePack.js";

async function main(): Promise<void> {
  const lock = acquireSingleInstanceLock(resolve("logs/.person-pack.lock"));
  if (!lock) return;
  try {
    const { processed } = await collectPersonSourcePacks(defaultCollectPersonSourcePackDeps());
    if (processed.length === 0) return; // 대기 없음 - 조용히 종료
  } finally {
    lock.release();
  }
}

main().catch((error) => {
  console.error(`❌ [person-pack] ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
