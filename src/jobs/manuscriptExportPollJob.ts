// 보관함 내보내기 폴러 - 맥에서만 돈다(2026-09-29 사용자 요청).
//
// 왜 로컬인가: 파이프라인은 GitHub Actions에서 돌아 맥 디스크에 직접 쓸 수 없다. 원고와 이미지를
// 보관함(~/blog-automation/blog-manuscripts/whyissuenow)에 놓으려면 맥이 당겨오는 수밖에 없다.
//
// 이미 30분마다 도는 전체 내보내기(scripts/export-manuscripts.sh)가 있다. 이건 그 앞에 끼어드는
// **빠른 길**이다 - 텔레그램 [⬇️ 맥으로 내려받기]를 누른 원고만 1분 안에 받아 온다. 이 폴러가
// 죽어도 원고는 늦어도 30분 안에 내려간다(그래서 실패해도 조용히 다음 주기를 기다린다).
//
// 실행: npm run job:export-poll  (launchd가 60초마다 부른다)
import "dotenv/config";

import { resolve } from "node:path";

import { acquireSingleInstanceLock } from "./lib/singleInstanceLock.js";
import {
  finishManuscriptExport,
  listPendingExportRequests,
} from "../workflows/manuscripts/manuscriptExportQueue.js";
import { exportManuscript } from "../workflows/manuscripts/exportManuscript.js";
import { loadManifest } from "../workflows/manuscripts/manuscriptManifest.js";
import { TelegramNotifier, escapeTelegramHtml } from "../notifications/TelegramNotifier.js";

/** 한 번에 처리할 최대 건수. 이미지를 내려받는 작업이라 길게 돌면 다음 주기와 겹친다. */
const MAX_PER_RUN = 3;

async function notify(text: string): Promise<void> {
  await TelegramNotifier.fromEnv()
    .sendMessages([{ text }])
    .catch((error) => {
      console.warn(`⚠️ [export-poll] 알림 실패(무시하고 계속): ${error instanceof Error ? error.message : error}`);
    });
}

async function main(): Promise<void> {
  // 겹쳐 돌면 같은 폴더에 동시에 쓴다. 락이 없으면 조용히 끝낸다.
  const lock = acquireSingleInstanceLock(resolve("logs/.export-poll.lock"));
  if (!lock) return;

  const pending = await listPendingExportRequests();
  if (pending.length === 0) return; // 대기열 없음 - 조용히 종료

  console.log(`▶ [export-poll] 대기 ${pending.length}건 중 ${Math.min(pending.length, MAX_PER_RUN)}건 처리`);

  // manifest는 한 번만 읽는다(원고 본문·이미지 목록의 단일 소스). 대기열의 job이 여기 없으면
  // 아직 원고 준비가 안 끝난 것이다 - 실패로 적고 넘어간다.
  const manifest = await loadManifest();

  for (const job of pending.slice(0, MAX_PER_RUN)) {
    console.log(`   · ${job.keyword}`);
    try {
      const topic = manifest.topics.find((t) => t.jobId === job.id);
      if (!topic) {
        throw new Error("원고 목록(manifest)에 아직 없습니다 - 원고 준비가 끝난 뒤 다시 눌러주세요.");
      }

      const result = await exportManuscript(topic);
      await finishManuscriptExport(job, { ok: true, dir: result.dir });
      console.log(`   ✅ ${job.keyword} -> ${result.dir} (받음 ${result.downloaded} / 건너뜀 ${result.skipped})`);

      const unfilled = result.slots.filter((s) => s.fileNames.length === 0).length;
      await notify(
        [
          "⬇️ <b>맥 보관함에 내려받았습니다</b>",
          "",
          `<b>${escapeTelegramHtml(job.keyword)}</b>`,
          `<code>${escapeTelegramHtml(result.dir)}</code>`,
          `이미지 ${result.downloaded}장 받음 · ${result.skipped}장 이미 있음`
            + (unfilled > 0 ? ` · 빈 자리 ${unfilled}개` : ""),
        ].join("\n")
      );
    } catch (error) {
      // 예외로 폴러가 죽으면 다음 건이 영영 안 돈다 - 기록하고 다음으로 넘어간다.
      const detail = error instanceof Error ? error.message : String(error);
      await finishManuscriptExport(job, { ok: false, error: detail }).catch(() => {});
      console.error(`   ❌ ${job.keyword} - ${detail}`);
      await notify(
        [
          "⚠️ <b>맥으로 내려받지 못했습니다</b>",
          "",
          `<b>${escapeTelegramHtml(job.keyword)}</b>`,
          escapeTelegramHtml(detail),
          "",
          "자동 재시도는 없습니다 - 버튼을 다시 눌러주세요(30분 주기 내보내기로도 들어옵니다).",
        ].join("\n")
      );
      process.exitCode = 1;
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
