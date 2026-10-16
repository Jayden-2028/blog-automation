// 인물 백과 소스팩 수집 폴러 - 맥에서만 돈다(2026-10-15, WRITING-HUMANIZE B-1).
//
// 하는 일 하나: 소스팩이 없는 최근 person job에 네이버 인물DB·나무위키 원문을 채워 넣는다. 클라우드 러너(job-research)는
// 이 팩을 최대 8분 기다렸다 프롬프트에 싣는다. 대기열이 없으면 조용히 끝난다(DB 조회 1회).
//
// 실행: npm run job:person-pack  (launchd 1분 주기 권장 - 폴러·plist 변경은 사용자 승인, 이 파일은 실행만 한다)
import "dotenv/config";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { acquireSingleInstanceLock } from "./lib/singleInstanceLock.js";
import { ArticleJobRepository } from "../repositories/ArticleJobRepository.js";
import { attachAiAnswer, collectPersonSourcePacks, defaultCollectPersonSourcePackDeps } from "../workflows/research/collectPersonSourcePack.js";

/** 수동 보조 경로(§A-3): `npm run job:person-pack -- --job-id <id> --google-ai-file <txt>`(또는 `--naver-ai-file`) - 폴러 주기 실행이 아니라 사용자가 한 번 실행한다. */
function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const googleFile = argValue("--google-ai-file");
  const naverFile = argValue("--naver-ai-file");
  if (googleFile || naverFile) {
    const jobId = argValue("--job-id");
    if (!jobId) throw new Error("--google-ai-file/--naver-ai-file에는 --job-id <id>가 필요하다");
    const field = googleFile ? ("googleAiAnswer" as const) : ("naverAiAnswer" as const);
    const file = (googleFile ?? naverFile)!;
    const pack = await attachAiAnswer(jobId, field, readFileSync(resolve(file), "utf8"), {
      readMetadata: async (id) => ((await ArticleJobRepository.findById(id))?.metadata ?? null) as Record<string, unknown> | null,
      mergeMetadata: async (id, patch) => {
        await ArticleJobRepository.mergeMetadata(id, patch);
      },
    });
    console.log(`✅ [person-pack] ${field === "googleAiAnswer" ? "구글" : "네이버"} AI 답변 첨부: ${(pack[field] ?? "").length.toLocaleString()}자 (job ${jobId})`);
    return;
  }
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
