// npm run ig:create-job -- <캡처결과.json> [--dry-run]
//
// 브라우저 캡처 세션의 산출물(JSON)을 검증해 article_jobs 1건으로 만든다.
//
// 왜 CLI인가: createInstagramJob은 InstagramCaptureResult를 그대로 믿고 DB에 쓰고 이미지를
// 업로드하는데, 그 타입을 만드는 코드가 없어 캡처 세션이 매번 일회용 스크립트를 짜야 했다
// (2026-09-22까지 호출부 0건). 대기열을 여러 건 처리할 때 같은 손실수를 반복하게 되고, 실패해도
// 이미 job row가 생긴 뒤라 되돌리기가 번거롭다.
//
// --dry-run은 **아무것도 쓰지 않고** 검증만 한다. 캡처 세션이 JSON을 먼저 이걸로 통과시킨 뒤
// 실제 실행하면 "job은 생겼는데 이미지가 0장" 같은 중간 실패를 피할 수 있다.
import "dotenv/config";

import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

// createInstagramJob은 여기서 import하지 않는다 - 그쪽이 supabase 클라이언트를 끌고 오는데,
// 그 모듈은 로드 시점에 SUPABASE_URL이 없으면 throw한다. 정적 import면 --dry-run조차 자격증명을
// 요구하게 되어 "쓰기 전에 검증만" 이라는 목적이 사라진다. 실제로 쓸 때만 동적으로 부른다.
import { readQueue, INSTAGRAM_QUEUE_PATH } from "./instagramQueue.js";
import { parseCaptureFile } from "./parseCaptureFile.js";

function fail(lines: string[]): never {
  for (const line of lines) console.error(line);
  process.exit(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const filePath = args.find((a) => !a.startsWith("--"));

  if (!filePath) {
    console.log("사용법: npm run ig:create-job -- <캡처결과.json> [--dry-run]");
    console.log("JSON 형식은 docs/ai-handoff/INSTAGRAM_POSTING_CONVERTER.md의 '캡처 결과 JSON'을 보세요.");
    process.exit(1);
  }

  const absolute = resolve(filePath);
  if (!existsSync(absolute)) fail([`❌ 파일이 없습니다: ${absolute}`]);

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(absolute, "utf8"));
  } catch (error) {
    fail([`❌ JSON을 읽지 못했습니다: ${error instanceof Error ? error.message : error}`]);
  }

  const parsed = parseCaptureFile(raw);
  if (!parsed.ok) {
    fail([`❌ 캡처 JSON이 규격에 맞지 않습니다 (${parsed.errors.length}건):`, ...parsed.errors.map((e) => `   - ${e}`)]);
  }
  const { capture, warnings } = parsed;

  // 큐 대조: 존재하지 않는 id면 markEntry가 조용히 아무 일도 안 해(instagramQueue.ts) 항목이
  // pending으로 남고 다음 처리 때 중복 job이 생긴다. 여기서 먼저 막는다.
  const entries = readQueue();
  const entry = entries.find((e) => e.id === capture.queueEntryId);
  if (!entry) {
    fail([
      `❌ 큐에 없는 queueEntryId입니다: ${capture.queueEntryId}`,
      `   큐 파일: ${INSTAGRAM_QUEUE_PATH}`,
      `   대기 중인 id: ${entries.filter((e) => e.status === "pending").map((e) => e.id).join(", ") || "(없음)"}`,
    ]);
  }
  if (entry.status !== "pending") {
    fail([
      `❌ 이미 처리된 항목입니다(status=${entry.status}${entry.jobId ? `, jobId=${entry.jobId}` : ""}): ${capture.queueEntryId}`,
      "   다시 만들려면 큐 파일에서 해당 줄의 status를 pending으로 되돌리세요.",
    ]);
  }
  if (entry.instagramUrl !== capture.instagramUrl) {
    warnings.push(`큐의 URL과 JSON의 instagramUrl이 다릅니다 - 큐: ${entry.instagramUrl}`);
  }

  // 이미지 파일 존재·크기 확인. 업로드 중간에 터지면 일부만 올라간 채 job이 남는다.
  const fileProblems: string[] = [];
  for (const img of capture.images) {
    const path = resolve(img.localPath);
    if (!existsSync(path)) {
      fileProblems.push(`slide ${img.slideIndex} (${img.kind}): 파일이 없습니다 - ${path}`);
      continue;
    }
    const size = statSync(path).size;
    if (size === 0) fileProblems.push(`slide ${img.slideIndex} (${img.kind}): 파일이 0바이트입니다 - ${path}`);
  }
  if (fileProblems.length > 0) {
    fail([`❌ 이미지 파일 문제 ${fileProblems.length}건:`, ...fileProblems.map((p) => `   - ${p}`)]);
  }

  console.log(`▶ 검증 통과: ${absolute}`);
  console.log(`   주제어 : ${capture.searchKeyword}`);
  console.log(`   카테고리: ${capture.category ?? "(없음)"}`);
  console.log(`   URL    : ${capture.instagramUrl}`);
  console.log(`   이미지  : ${capture.images.length}장 (자리 ${new Set(capture.images.map((i) => i.slideIndex)).size}개)`);
  console.log(`   번인텍스트: ${capture.burnedInText.length}건`);
  for (const w of warnings) console.warn(`⚠️ ${w}`);

  if (dryRun) {
    console.log("\n✅ --dry-run이라 아무것도 쓰지 않았습니다.");
    return;
  }

  console.log("\n▶ job 생성 + 이미지 업로드 중...");
  const { createInstagramJob } = await import("./createInstagramJob.js");
  const result = await createInstagramJob(capture);

  console.log(`\n✅ job ${result.jobId} 생성 (이미지 ${result.imagesSaved}장 저장, ${result.imagesFailed}장 실패)`);
  if (result.imagesFailed > 0) {
    console.warn("⚠️ 일부 이미지가 실패했습니다 - 위 로그를 확인하고, 필요하면 캡처를 다시 올리세요.");
  }
  console.log("\n다음 단계:");
  console.log(`   npm run job:research -- ${result.jobId}`);
  console.log(`   npm run job:write -- ${result.jobId}     # 여기서 이미지가 자동 승격됩니다`);
}

main().catch((error) => {
  console.error("❌ [ig-create-job] 실패:", error instanceof Error ? error.message : error);
  process.exit(1);
});
