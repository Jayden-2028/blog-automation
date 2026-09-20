// 발행된 글의 색인 상태를 점검하고 텔레그램으로 알린다(2단계).
//
// 왜 필요한가: 2026-09-21에 "블로그가 색인이 안 된다"는 사실을 **사용자가 GSC를 직접 열어보고**
// 발견했다. 그때 상태는 홈페이지가 구글에 알려지지도 않았고 크롤링된 2건이 리디렉션 오류였다.
// 이 점검을 주 1회 자동으로 돌리면 사람이 찾아 들어가지 않아도 먼저 알 수 있다.
//
// 상태를 저장하지 않는다(테이블 없음). 매주 현재 상태만 보고 알린다 - 추세가 필요해지면
// 그때 테이블을 만든다(마이그레이션은 승인 게이트라 필요해진 뒤에 연다).
//
// 사용:
//   npm run analytics:index-health              점검 + 출력(알림 없음)
//   npm run analytics:index-health -- --notify  텔레그램 발송까지
import "dotenv/config";

import { SearchConsoleClient } from "../../services/searchConsole/SearchConsoleClient.js";
import type { UrlInspectionResult } from "../../services/searchConsole/SearchConsoleClient.js";
import { TelegramNotifier } from "../../notifications/TelegramNotifier.js";
import { loadPublishedUrlToJobId } from "../../services/supabase/repositories/searchPerformanceRepository.js";
import { normalizePageUrl } from "./normalizeSearchRows.js";
import { buildHealthMessage, buildReport, classifyCoverage } from "./classifyIndexHealth.js";

/** URL Inspection은 사이트당 하루 2,000건이다. 한 번에 이만큼만 본다(여유 있게). */
const MAX_URLS = 100;
/** 호출 간 간격(ms). 분당 한도(600)를 넉넉히 밑돈다. */
const DELAY_MS = 150;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const notify = process.argv.includes("--notify");
  const client = new SearchConsoleClient();

  const configError = client.missingConfig();
  if (configError) {
    console.error(`❌ ${configError}`);
    process.exitCode = 1;
    return;
  }

  // 점검 대상 = 우리가 발행한 글 + 홈페이지. 홈페이지를 빼면 안 된다 - 실제로 거기가 제일
  // 먼저 망가져 있었다("URL is unknown to Google").
  //
  // ⚠️ **속성 밖 주소를 걸러야 한다**(2026-09-21 실측): publications에는 아직 공개되지 않은
  // 초안의 **편집 URL**(www.blogger.com/blog/post/edit/...)이 섞여 있다. 그대로 넣으면 20건이
  // 403("You do not own this site")으로 떨어져 할당량만 쓰고 보고서도 지저분해진다. 공개 주소가
  // 아닌 것은 애초에 색인 대상이 아니므로 여기서 제외한다.
  const published = await loadPublishedUrlToJobId();
  const siteUrl = process.env.GSC_SITE_URL ?? "";
  const candidates = [...new Set([siteUrl, ...[...published.keys()].map(normalizePageUrl)])];
  const targets = candidates.filter((url) => url.startsWith(siteUrl)).slice(0, MAX_URLS);
  const skipped = candidates.length - targets.length;
  if (skipped > 0) console.log(`· 속성 밖 주소 ${skipped}건 제외(미공개 초안의 편집 URL 등)\n`);

  console.log(`▶ 색인 점검 ${targets.length}건\n`);

  const results: UrlInspectionResult[] = [];
  const failures: string[] = [];

  for (const url of targets) {
    const result = await client.inspectUrl(url);
    if (!result.ok) {
      failures.push(`${url}: ${result.error}`);
      console.log(`❌ ${url} → ${result.error}`);
    } else {
      results.push(result.data);
      const bucket = classifyCoverage(result.data.coverageState);
      const mark = bucket === "indexed" ? "✅" : bucket === "broken" ? "⚠️ " : "· ";
      console.log(`${mark} ${new URL(url).pathname.padEnd(38)} ${result.data.coverageState}`);
    }
    await sleep(DELAY_MS);
  }

  const report = buildReport(results, failures);
  console.log(
    `\n색인됨 ${report.indexed.length} · 대기 ${report.pending.length} · 고장 ${report.broken.length}` +
      (failures.length > 0 ? ` · 검사 실패 ${failures.length}` : "")
  );

  const message = buildHealthMessage(report, targets.length);
  console.log(`\n── 알림 문구 ${"─".repeat(40)}\n${message.replace(/<[^>]+>/g, "")}`);

  if (!notify) {
    console.log("\n· --notify를 붙이면 텔레그램으로 보냅니다.");
    return;
  }
  await TelegramNotifier.fromEnv().sendMessages([{ text: message }]);
  console.log("\n✅ 텔레그램 발송 완료");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
