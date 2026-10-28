// 주간 네이버 문체 학습(style-learn). 월요일 Worker cron이 깨운다.
// 네이버 발행본(사용자 윤문 후) vs 파이프라인 원고를 짝지어 문체 차이를 재고, 집필 규격 개정안을 **PR로 제안**한다.
// 규격 파일(prompts/writing/*.md)은 절대 수정하지 않는다 - 보고서 안 diff 블록으로만 둔다. 자동 병합 없음.
//
//   npm run job:style-learn -- --dry-run --days 10   (보고서를 stdout에만, PR·텔레그램 없음)
//   npm run job:style-learn -- --no-pr               (docs/style-learning/에 파일만 쓴다)
//   npm run job:style-learn                          (파일 + PR + 텔레그램)
//   --no-claude                                      (분류 호출 생략: 지표·diff만)
import "dotenv/config";

import { notifyPipelineFailure } from "../notifications/notifyPipelineFailure.js";
import { TelegramNotifier, escapeTelegramHtml } from "../notifications/TelegramNotifier.js";
import { openReportPr, writeReportFile } from "../workflows/style-learn/publishReport.js";
import { renderTelegramSummary } from "../workflows/style-learn/report.js";
import { DEFAULT_DAYS, runStyleLearn } from "../workflows/style-learn/runStyleLearn.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const noPr = args.includes("--no-pr");
const noClaude = args.includes("--no-claude");
const daysIdx = args.indexOf("--days");
const days = daysIdx >= 0 ? Number(args[daysIdx + 1]) : DEFAULT_DAYS;
if (!Number.isInteger(days) || days < 1 || days > 50) {
  console.error("--days는 1~50 정수");
  process.exit(2);
}

async function main(): Promise<void> {
  const { input, markdown } = await runStyleLearn({ days, skipClaude: noClaude });
  console.log(`▶ ${input.label}: 발행 ${input.collected}/${input.listed}건 · 쌍 ${input.pairs.length} · 순수작 ${input.pure.length} · 제안 ${input.anchors.length}${input.classifyError ? ` · 분류 생략(${input.classifyError})` : ""}`);

  if (dryRun) {
    console.log(`\n${markdown}\n\n(dry-run: 파일·PR·텔레그램 없음)\n\n--- 텔레그램 미리보기 ---\n${renderTelegramSummary(input, null)}`);
    return;
  }
  const notifier = (() => {
    try {
      return TelegramNotifier.fromEnv();
    } catch {
      return null;
    }
  })();
  const notify = async (text: string) => {
    try {
      await notifier?.send(escapeTelegramHtml(text));
    } catch (error) {
      console.warn(`⚠️ 텔레그램 발송 실패(비치명): ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  if (input.pairs.length === 0) {
    console.log("짝지어진 글이 없어 보고서/PR을 만들지 않는다.");
    await notify(`📝 style-learn ${input.label}: 발행 ${input.collected}건 중 원고와 짝지어진 글 없음(순수작 ${input.pure.length}) — PR 없음`);
    return;
  }
  const rel = await writeReportFile(process.cwd(), input.label, markdown);
  console.log(`보고서 작성: ${rel}`);
  if (noPr) return;

  let prUrl: string | null = null;
  try {
    prUrl = await openReportPr(rel, input.label, `${renderTelegramSummary(input, null)}\n\n보고서: \`${rel}\`. 규격 파일은 수정하지 않았다 — 제안 diff를 보고 사람이 반영한다.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)`);
    console.log(`PR: ${prUrl}`);
  } catch (error) {
    console.error(`PR 생성 실패: ${error instanceof Error ? error.message : String(error)}`);
    await notify(`📝 style-learn ${input.label}: 보고서는 만들었으나 PR 생성 실패 — Actions 로그 확인 (Settings > Actions > "Allow GitHub Actions to create pull requests" 확인)`);
    process.exitCode = 1;
    return;
  }
  await notify(renderTelegramSummary(input, prUrl));
}

main().catch(async (error) => {
  const message = `style-learn 실패: ${error instanceof Error ? error.message : String(error)}`;
  console.error(message);
  if (!dryRun) await notifyPipelineFailure(message, []);
  process.exit(1);
});
