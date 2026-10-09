// 주간 검색 성과 리포트(속성별 메시지). 기본은 출력만, --notify로 텔레그램 발송.
//
//   npm run analytics:weekly-report                    출력만
//   npm run analytics:weekly-report -- --notify        텔레그램(메인봇) 발송
//   npm run analytics:weekly-report -- --date=2026-10-05   이 날짜(포함)까지의 7일
//
// 기준일은 수집 지연(3일)을 반영한 reportDate()다. 읽기만 한다 - DB에 쓰지 않는다.
import "dotenv/config";

import { TelegramNotifier } from "../../notifications/TelegramNotifier.js";
import { loadSearchPerformanceRange } from "../../services/supabase/repositories/searchPerformanceRepository.js";
import { reportDate } from "./normalizeSearchRows.js";
import { resolveSiteUrls, siteLabel } from "./siteUrls.js";
import { buildSiteMessage, buildWeeklyReport } from "./weeklyReport.js";

function argValue(name: string): string | null {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

function addDays(date: string, delta: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const notify = process.argv.includes("--notify");
  const endDate = argValue("date") ?? reportDate();
  const sites = resolveSiteUrls(process.env).map(siteLabel);

  // 데이터 일수 판정(14일 미만 = 축적 중)을 위해 전주 시작보다 더 넓게 읽는다.
  const rows = await loadSearchPerformanceRange(addDays(endDate, -29), endDate);
  const weeks = buildWeeklyReport(rows, endDate, sites);
  const messages = weeks.map((w) => ({ text: buildSiteMessage(w, endDate) }));

  console.log(`▶ 주간 리포트 ${endDate} 기준, 속성 ${weeks.length}개 (읽은 행 ${rows.length})\n`);
  console.log(messages.map((m) => m.text.replace(/<[^>]+>/g, "")).join("\n\n────────\n\n"));

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
