// job-gemini-person.yml 진입점. 사용법: npm run job:gemini-person -- <jobId> [--force]
//
// 실패해도 종료 코드는 0이다 - 실패 사유는 job.metadata.geminiShadow.error와 텔레그램 한 줄로 이미 남았고,
// 이 트랙은 기존 파이프라인과 무관한 비교용이라 빨간 Actions run이 쌓일 이유가 없다. 이 프로세스가 **시작조차
// 못 하거나 비정상 종료**하는 경우는 워크플로의 `if: failure()` 스텝(notifyWorkflowFailure.mjs)이 잡는다.
import "dotenv/config";

import { cloudflarePagesUrl } from "../../config/manuscriptsPageTargets.js";
import { viewerPageLink } from "../../config/manuscriptViewerPages.js";
import { dispatchGithubWorkflow } from "../../services/github/dispatchWorkflow.js";
import { supabase } from "../../services/supabase/client.js";
import { notifierForJob } from "../../notifications/notifierForJob.js";
import type { TelegramInlineKeyboardButton } from "../../notifications/TelegramNotifier.js";
import { trackOfJob } from "../../notifications/telegramTracks.js";
import { runGeminiPerson } from "./runGeminiPerson.js";

async function main(): Promise<void> {
  const jobId = process.argv[2];
  const force = process.argv.includes("--force");
  if (!jobId || jobId.startsWith("--")) {
    console.log("사용법: npm run job:gemini-person -- <jobId> [--force]");
    return;
  }

  console.log(`▶ 제미나이 인물 그림자 시작: ${jobId}${force ? " (force)" : ""}`);
  const result = await runGeminiPerson(
    jobId,
    { force },
    {
      hasManifestEntry: async (id) => {
        const { data, error } = await supabase.from("manuscript_manifest_topics").select("job_id").eq("job_id", id).maybeSingle();
        if (error) throw error;
        return Boolean(data);
      },
      dispatchRefresh: () => dispatchGithubWorkflow({ workflowFile: "manuscripts-refresh.yml", inputs: {} }),
      pageUrlFor: (job) => {
        const base = cloudflarePagesUrl();
        return base ? viewerPageLink(base, trackOfJob(job), job.id) : null;
      },
      notify: async (job, text, pageUrl) => {
        const rows: TelegramInlineKeyboardButton[][] = pageUrl ? [[{ text: "📄 원고 페이지 열기", url: pageUrl }]] : [];
        await notifierForJob(job).sendMessages([
          { text, replyMarkup: rows.length > 0 ? { inline_keyboard: rows } : undefined },
        ]);
      },
    }
  );

  if (result.status === "skipped") console.log(`· 건너뜀: ${result.reason}`);
  else if (result.status === "failed") console.error(`❌ 제미나이 인물 그림자 실패: ${result.error}`);
  else console.log(`✅ 제미나이 버전 완료 - "${result.shadow.title}" (${result.shadow.body?.length ?? 0}자, 페이지 갱신 ${result.pageRefreshed ? "요청함" : "없음"})`);
}

main().catch((error) => {
  console.error("❌ [gemini-person] 실패:", error instanceof Error ? error.message : error);
  process.exit(1);
});
