// Search Console 일일 성과를 받아 저장한다(1단계).
//
//   GSC searchAnalytics(date×page×query) → 모바일 주소 합산 → job 매칭 → Supabase upsert
//
// 기본은 **미리보기**다. `--apply` 없이는 아무것도 쓰지 않는다 - 테이블이 아직 없어도 수집
// 자체가 도는지 먼저 확인할 수 있어야 한다(마이그레이션은 승인 게이트라 뒤에 적용된다).
//
// 사용:
//   npm run analytics:search                    3일 전 하루치 미리보기
//   npm run analytics:search -- --apply         저장
//   npm run analytics:search -- --date=2026-09-18
//   npm run analytics:search -- --days=7        그날부터 과거 7일치(백필)
import "dotenv/config";

import { SearchConsoleClient } from "../../services/searchConsole/SearchConsoleClient.js";
import {
  loadPublishedUrlToJobId,
  upsertSearchPerformance,
} from "../../services/supabase/repositories/searchPerformanceRepository.js";
import { aggregateRows, attachJobIds, reportDate } from "./normalizeSearchRows.js";

function argValue(name: string): string | null {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

/** 기준일에서 하루씩 뒤로 물린 날짜 목록(백필용). */
function datesToFetch(baseDate: string, days: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < days; i += 1) {
    const d = new Date(`${baseDate}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const baseDate = argValue("date") ?? reportDate();
  const days = Math.max(1, Number(argValue("days") ?? 1));

  const client = new SearchConsoleClient();
  const configError = client.missingConfig();
  if (configError) {
    console.error(`❌ ${configError}`);
    console.error("   GSC_SERVICE_ACCOUNT_JSON / GSC_SITE_URL을 .env에 넣은 뒤 다시 실행하세요.");
    process.exitCode = 1;
    return;
  }

  console.log(apply ? "▶ 성과 수집(저장)\n" : "▶ 성과 수집 - 미리보기, 쓰지 않습니다(--apply로 저장)\n");

  // 매칭표는 한 번만 읽는다(날짜마다 다시 읽을 이유가 없다).
  let urlToJobId = new Map<string, string>();
  try {
    urlToJobId = await loadPublishedUrlToJobId();
    console.log(`· 발행 기록 ${urlToJobId.size}건을 매칭표로 읽었습니다.`);
  } catch (error) {
    console.warn(`⚠️ 매칭표를 못 읽어 job 연결 없이 진행합니다: ${error instanceof Error ? error.message : error}`);
  }

  let totalRows = 0;
  let totalClicks = 0;
  let totalImpressions = 0;

  for (const date of datesToFetch(baseDate, days)) {
    const result = await client.fetchDay(date);
    if (!result.ok) {
      console.error(`❌ ${date} 실패 [${result.stage}]: ${result.error}`);
      process.exitCode = 1;
      continue;
    }

    const merged = aggregateRows(result.data);
    const attached = attachJobIds(merged, urlToJobId);
    const matched = attached.filter((r) => r.jobId).length;
    const clicks = attached.reduce((sum, r) => sum + r.clicks, 0);
    const impressions = attached.reduce((sum, r) => sum + r.impressions, 0);

    totalRows += attached.length;
    totalClicks += clicks;
    totalImpressions += impressions;

    console.log(
      `· ${date}  원본 ${String(result.data.length).padStart(4)}행 → 합산 ${String(attached.length).padStart(4)}행 | ` +
        `클릭 ${clicks} · 노출 ${impressions} | job 매칭 ${matched}/${attached.length}`
    );

    if (apply && attached.length > 0) {
      const written = await upsertSearchPerformance(
        attached.map((r) => ({
          date: r.date,
          page_url: r.pageUrl,
          query: r.query,
          clicks: r.clicks,
          impressions: r.impressions,
          ctr: r.ctr,
          position: r.position,
          job_id: r.jobId,
        }))
      );
      console.log(`  → ${written}행 저장`);
    }
  }

  // 미리보기에서는 상위 몇 건을 보여준다 - 숫자만 보면 제대로 온 건지 알 수 없다.
  if (!apply && totalRows > 0) {
    const sample = await client.fetchDay(baseDate);
    if (sample.ok) {
      const top = attachJobIds(aggregateRows(sample.data), urlToJobId)
        .sort((a, b) => b.impressions - a.impressions)
        .slice(0, 10);
      console.log(`\n── ${baseDate} 노출 상위 ${top.length}건 ${"─".repeat(30)}`);
      for (const row of top) {
        console.log(`  "${row.query}"`);
        console.log(
          `    클릭 ${row.clicks} · 노출 ${row.impressions} · CTR ${(row.ctr * 100).toFixed(1)}% · ` +
            `순위 ${row.position.toFixed(1)} ${row.jobId ? "" : "(수동 발행 글)"}`
        );
      }
    }
  }

  console.log(`\n합계: ${totalRows}행 · 클릭 ${totalClicks} · 노출 ${totalImpressions}`);
  if (!apply) console.log("확인 후 --apply를 붙여 다시 실행하세요.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
