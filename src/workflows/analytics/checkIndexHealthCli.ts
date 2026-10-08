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
import { belongsToSite, resolveSiteUrls, siteLabel } from "./siteUrls.js";
import { buildHealthMessage, buildReport, classifyCoverage } from "./classifyIndexHealth.js";

/** URL Inspection은 사이트당 하루 2,000건이다. 한 번에 이만큼만 본다(여유 있게). */
const MAX_URLS = 100;
/** 호출 간 간격(ms). 분당 한도(600)를 넉넉히 밑돈다. */
const DELAY_MS = 150;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type SiteOutcome = { siteUrl: string; message: string; broken: number };

/** 속성 하나를 점검해 알림 문구를 만든다. 속성마다 따로 보고한다(합치면 어느 채널 문제인지 안 보인다). */
async function checkSite(siteUrl: string, published: Map<string, string>): Promise<SiteOutcome> {
  const client = new SearchConsoleClient({ siteUrl });
  console.log(`\n━━ ${siteLabel(siteUrl)} ${"━".repeat(30)}`);

  // 점검 대상 = 우리가 발행한 글 + 홈페이지. 홈페이지를 빼면 안 된다 - 실제로 거기가 제일
  // 먼저 망가져 있었다("URL is unknown to Google").
  //
  // ⚠️ **속성 밖 주소를 걸러야 한다**(2026-09-21 실측): publications에는 아직 공개되지 않은
  // 초안의 **편집 URL**(www.blogger.com/blog/post/edit/...)이 섞여 있다. 그대로 넣으면 20건이
  // 403("You do not own this site")으로 떨어져 할당량만 쓰고 보고서도 지저분해진다. 공개 주소가
  // 아닌 것은 애초에 색인 대상이 아니므로 여기서 제외한다. 다중 속성에서는 타 채널 글도 같은
  // 이유로 걸러진다.
  const candidates = [...new Set([siteUrl, ...[...published.keys()].map(normalizePageUrl)])];
  const targets = candidates.filter((url) => belongsToSite(url, siteUrl)).slice(0, MAX_URLS);
  const skipped = candidates.length - targets.length;
  if (skipped > 0) console.log(`· 속성 밖 주소 ${skipped}건 제외(타 채널 글·미공개 초안의 편집 URL 등)\n`);

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

  return { siteUrl, message: buildHealthMessage(report, targets.length, siteLabel(siteUrl)), broken: report.broken.length };
}

async function main(): Promise<void> {
  const notify = process.argv.includes("--notify");
  const sites = resolveSiteUrls(process.env);

  const configError = new SearchConsoleClient({ siteUrl: sites[0] ?? "" }).missingConfig();
  if (configError) {
    console.error(`❌ ${configError}`);
    process.exitCode = 1;
    return;
  }

  const published = await loadPublishedUrlToJobId();
  const outcomes: SiteOutcome[] = [];
  for (const siteUrl of sites) {
    // 한 속성이 실패(소유권 미확인 등)해도 나머지는 계속 점검한다.
    try {
      outcomes.push(await checkSite(siteUrl, published));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`❌ ${siteLabel(siteUrl)} 점검 실패: ${reason}`);
      outcomes.push({ siteUrl, message: `❌ <b>${siteLabel(siteUrl)}</b> 색인 점검 실패`, broken: 0 });
      process.exitCode = 1;
    }
  }

  // 속성별 메시지를 따로 보낸다 - 텔레그램 한 메시지가 길어지면 잘리고, 채널별로 읽히는 편이 낫다.
  const messages = outcomes.map((o) => ({ text: o.message }));
  console.log(`\n── 알림 문구 ${"─".repeat(40)}\n${messages.map((m) => m.text.replace(/<[^>]+>/g, "")).join("\n\n")}`);

  if (!notify) {
    console.log("\n· --notify를 붙이면 텔레그램으로 보냅니다.");
    return;
  }
  await TelegramNotifier.fromEnv().sendMessages(messages);
  console.log("\n✅ 텔레그램 발송 완료");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
