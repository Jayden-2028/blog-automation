// 뷰어의 발행 버튼이 보낸 요청 1건을 큐에 넣는다(TISTORY_AUTO_PUBLISH_DESIGN.md §5).
//
// 경로: 뷰어 🟠 버튼 -> Pages Function(functions/api/publish-request.ts, Access 토큰 검증) ->
// repository_dispatch(publish_request) -> .github/workflows/publish-request.yml -> 이 파일.
// 텔레그램 버튼(TelegramBot.handlePublishDecisionCallback)과 **같은 큐**(requestTistoryPublish)에 들어가므로
// 둘 다 눌러도 한 번만 올라간다. 실제 발행은 맥미니 폴러(job:tistory-poll)가 한다.
import "dotenv/config";

import { escapeTelegramHtml } from "../notifications/TelegramNotifier.js";
import { notifierForJob } from "../notifications/notifierForJob.js";
import { ArticleJobRepository } from "../repositories/ArticleJobRepository.js";
import { requestTistoryPublish } from "../workflows/publish/tistoryPublishQueue.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHANNELS = ["tistory"] as const;
type Channel = (typeof CHANNELS)[number];

export function parsePublishRequest(raw: unknown): { jobId: string; channel: Channel } {
  const value = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!value || typeof value !== "object") throw new Error("요청 형식이 아닙니다");
  const { jobId, channel } = value as { jobId?: unknown; channel?: unknown };
  if (typeof jobId !== "string" || !UUID_RE.test(jobId)) throw new Error("jobId가 UUID가 아닙니다");
  if (typeof channel !== "string" || !(CHANNELS as readonly string[]).includes(channel)) throw new Error(`지원하지 않는 채널: ${String(channel)}`);
  return { jobId, channel: channel as Channel };
}

async function main(): Promise<void> {
  const raw = process.env.PUBLISH_REQUEST_JSON;
  if (!raw) throw new Error("PUBLISH_REQUEST_JSON 환경변수가 없습니다.");
  const { jobId, channel } = parsePublishRequest(raw);

  const job = await ArticleJobRepository.findById(jobId);
  if (!job) throw new Error(`job을 찾을 수 없습니다: ${jobId}`);
  if (job.status !== "approved") throw new Error(`승인된 원고만 발행할 수 있습니다(현재: ${job.status})`);

  const queued = await requestTistoryPublish(job, { source: "viewer" });
  console.log(`${queued.queued ? "✅" : "ℹ️"} [publish-request] ${channel} ${job.keyword}: ${queued.queued ? "예약" : queued.reason}`);

  await notifierForJob(job)
    .sendMessages([
      {
        text: [
          queued.queued ? "🟠 <b>뷰어에서 티스토리 발행을 예약했습니다</b>" : "ℹ️ <b>티스토리 발행 - 이미 예약돼 있습니다</b>",
          "",
          `<b>${escapeTelegramHtml(job.keyword)}</b>`,
          queued.queued ? "맥미니가 켜져 있으면 곧 올라갑니다. 완료되면 주소를 보내드립니다." : escapeTelegramHtml(queued.reason ?? ""),
        ].join("\n"),
      },
    ])
    .catch((error) => console.warn(`⚠️ 알림 실패(무시): ${error instanceof Error ? error.message : error}`));
}

main().catch((error) => {
  console.error(`❌ [publish-request] 실패: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
