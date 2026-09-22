// npm run ig:capture -- <queueEntryId|--first> [--dry-run] [--keep]
//
// 대기열 1건을 손으로 돌려 본다. IG_CAPTURE_AUTO를 켜기 **전에** 캐러셀 셀렉터와 로그인 프로필이
// 실제로 맞는지 확인하는 용도다 - 자동화부터 켜면 매 분 실패 알림이 오고 무엇이 틀렸는지는
// 로그를 뒤져야 안다.
//
//   --dry-run  캡처·판정까지만 하고 job을 만들지 않는다(DB에 아무것도 안 쓴다)
//   --keep     임시 디렉터리를 지우지 않는다 - 찍힌 스크린샷을 눈으로 확인할 때
//   --headed   창을 띄운다. 인스타가 헤드리스를 탐지해 막을 때 확인·우회용
//
// 자동 경로(processPendingCaptures)와 **같은 함수**를 쓴다. 여기서 되면 자동에서도 된다.
import "dotenv/config";

import { rm } from "node:fs/promises";

import { instagramProfilePath } from "./captureInstagramCarousel.js";
import { listPendingEntries, readQueue } from "./instagramQueue.js";
import { parseCaptureFile } from "./parseCaptureFile.js";
import { runCaptureSession } from "./runCaptureSession.js";
import type { CarouselCapture, CarouselJudgement } from "./captureTypes.js";
import type { InstagramQueueEntry } from "./types.js";

function pickEntry(target: string): InstagramQueueEntry | null {
  if (target === "--first") return listPendingEntries()[0] ?? null;
  return readQueue().find((e) => e.id === target) ?? null;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const keep = args.includes("--keep");
  // 인스타가 헤드리스를 탐지해 로그인 벽을 띄우면 창을 띄우는 쪽이 유일한 우회다.
  const headed = args.includes("--headed");
  const target = args.find((a) => !a.startsWith("--")) ?? "--first";

  if (!instagramProfilePath()) {
    console.error("❌ IG_BROWSER_PROFILE이 없습니다 - 먼저 npm run ig:login을 돌려주세요.");
    process.exit(1);
  }

  const entry = pickEntry(target);
  if (!entry) {
    const pending = listPendingEntries();
    console.error(`❌ 큐에서 찾지 못했습니다: ${target}`);
    console.error(`   대기 중인 id: ${pending.map((e) => e.id).join(", ") || "(없음)"}`);
    process.exit(1);
  }

  console.log(`▶ 큐 항목 ${entry.id}`);
  console.log(`   url: ${entry.instagramUrl}`);
  console.log(`   상태: ${entry.status}${entry.attempts ? ` (실패 ${entry.attempts}회)` : ""}`);
  if (entry.lastError) console.log(`   마지막 오류: ${entry.lastError}`);
  console.log("");

  // 단계별로 무엇이 나왔는지 그대로 보여준다 - 셀렉터가 틀리면 여기서 드러난다.
  let captured: CarouselCapture | null = null;
  let judged: CarouselJudgement | null = null;

  // 임시 디렉터리 정리. runCaptureSession은 **실패했을 때만** 이걸 부른다 - 성공하면 이미지를
  // 아직 안 읽었으므로 createInstagramJob이 끝난 뒤 여기서 직접 부른다(2026-09-23).
  const finishTemp = async (dir: string): Promise<void> => {
    if (keep) {
      console.log(`\n▶ --keep - 임시 파일을 남겼습니다: ${dir}`);
      return;
    }
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  };

  const session = await runCaptureSession(entry, {
    capture: async (url) => {
      console.log("▶ 캐러셀 캡처 중...");
      const { captureInstagramCarousel } = await import("./captureInstagramCarousel.js");
      captured = await captureInstagramCarousel(url, headed ? { headless: false } : {});
      console.log(`   슬라이드 ${captured.slides.length}장`);
      for (const s of captured.slides) console.log(`     ${s.slideIndex}. ${s.localPath}`);
      console.log(`   캡션: ${captured.caption ? `${captured.caption.slice(0, 80)}...` : "(못 읽음)"}`);
      return captured;
    },
    judge: async (capture, queueEntry) => {
      console.log("\n▶ 슬라이드 판정 중(claude -p)...");
      const { judgeCarouselSlides } = await import("./judgeCarouselSlides.js");
      judged = await judgeCarouselSlides(capture, queueEntry);
      console.log(`   주제어: ${judged.searchKeyword}`);
      console.log(`   카테고리: ${judged.category ?? "(없음)"}`);
      for (const s of judged.slides) {
        console.log(
          `     ${s.slideIndex}. ${s.hasOverlay ? "오버레이 있음 → 대체 검색" : "플랫 단컷 → 그대로 사용"}` +
            `${s.burnedInText ? ` | 번인: "${s.burnedInText.slice(0, 40)}"` : ""}`
        );
      }
      return judged;
    },
    findCleanAlternative: async (input) => {
      console.log(`\n▶ 자리 ${input.slideIndex} 대체 이미지 검색...`);
      const { findCleanAlternative } = await import("./findCleanAlternative.js");
      const found = await findCleanAlternative(input);
      console.log(found ? `   찾음: ${found.sourcePage}` : "   못 찾음 - 이 자리는 비웁니다");
      return found;
    },
    cleanup: finishTemp,
  });

  if (session.status === "failed") {
    console.error(`\n❌ 실패: ${session.error}`);
    console.error("   --keep으로 남은 failure.png / failure.txt를 열어 무슨 화면이 떴는지 보세요.");
    console.error("   헤드리스 탐지가 의심되면: npm run ig:capture -- <id> --dry-run --keep --headed");
    process.exit(1);
  }

  console.log(`\n▶ 결과: 이미지 ${session.slidesUsed}장${session.slidesDropped > 0 ? `, 자리 ${session.slidesDropped}개 비움` : ""}`);

  const parsed = parseCaptureFile(session.capture as unknown);
  if (!parsed.ok) {
    console.error(`\n❌ 캡처 결과가 규격에 맞지 않습니다:`);
    for (const e of parsed.errors) console.error(`   - ${e}`);
    await finishTemp(session.tempDir);
    process.exit(1);
  }
  for (const w of parsed.warnings) console.warn(`⚠️ ${w}`);

  if (dryRun) {
    console.log("\n✅ --dry-run이라 job을 만들지 않았습니다.");
    console.log(JSON.stringify(parsed.capture, null, 2));
    await finishTemp(session.tempDir);
    return;
  }

  console.log("\n▶ job 생성 중...");
  const { createInstagramJob } = await import("./createInstagramJob.js");
  const created = await createInstagramJob(parsed.capture);
  console.log(`✅ job ${created.jobId} (이미지 ${created.imagesSaved}장 저장, ${created.imagesFailed}장 실패)`);
  await finishTemp(session.tempDir);

  console.log("\n▶ 자료조사로 자동 연결 중...");
  const { triggerResearchForJob } = await import("./triggerResearch.js");
  await triggerResearchForJob(created.jobId);
  console.log("✅ 완료 - 초안이 준비되면 Telegram으로 알림이 갑니다.");
}

main().catch((error) => {
  console.error("❌ [ig-capture] 실패:", error instanceof Error ? error.message : error);
  process.exit(1);
});
