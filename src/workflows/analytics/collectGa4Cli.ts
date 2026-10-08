// GA4 일일 지표(sessions·users·pageviews × 채널 그룹) 수집 - **미리보기만**(저장 없음).
//
// 저장 테이블(ga4_performance_daily)은 migration 승인 게이트라 아직 없다. 승인 후 `--apply`를 붙이는
// 단계를 추가한다(docs/ai-handoff/ANALYTICS_OPS.md §2). 지금은 API 권한·응답이 되는지 확인하는 용도다.
//
//   npm run analytics:ga4                          어제까지 최근 3일, env GA4_PROPERTY_IDS
//   npm run analytics:ga4 -- --days=7
//   npm run analytics:ga4 -- --properties=tkm:557900208,tistory:558030120
//
// GA4_PROPERTY_IDS = `라벨:숫자속성ID` 콤마 목록(숫자 속성 ID는 측정 ID G-… 와 다르다).
import "dotenv/config";

import { Ga4Client } from "../../services/ga4/Ga4Client.js";

function argValue(name: string): string | null {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

export function parseProperties(raw: string): Array<{ label: string; id: string }> {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .flatMap((item) => {
      const [label, id] = item.split(":").map((s) => s.trim());
      return label && /^\d+$/.test(id ?? "") ? [{ label, id }] : [];
    });
}

async function main(): Promise<void> {
  const properties = parseProperties(argValue("properties") ?? process.env.GA4_PROPERTY_IDS ?? "");
  if (properties.length === 0) {
    console.error("❌ GA4_PROPERTY_IDS(또는 --properties=라벨:숫자ID,...)가 없습니다.");
    process.exitCode = 1;
    return;
  }

  const client = new Ga4Client();
  const configError = client.missingConfig();
  if (configError) {
    console.error(`❌ ${configError}`);
    process.exitCode = 1;
    return;
  }

  const days = Math.max(1, Number(argValue("days") ?? 3));
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 1); // 어제(GA4는 약 1일 지연)
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  const startDate = start.toISOString().slice(0, 10);
  const endDate = end.toISOString().slice(0, 10);

  console.log(`▶ GA4 수집 - 미리보기, 쓰지 않습니다 (${startDate} ~ ${endDate})\n`);

  for (const { label, id } of properties) {
    console.log(`━━ ${label} (properties/${id}) ${"━".repeat(20)}`);
    const result = await client.fetchDaily(id, startDate, endDate);
    if (!result.ok) {
      console.error(`❌ [${result.stage}] ${result.error}`);
      process.exitCode = 1;
      continue;
    }
    if (result.data.length === 0) {
      console.log("· 응답 0행(권한은 통과, 이 기간 데이터 없음)");
      continue;
    }
    for (const r of result.data.sort((a, b) => a.date.localeCompare(b.date) || a.channelGroup.localeCompare(b.channelGroup))) {
      console.log(`· ${r.date}  ${r.channelGroup.padEnd(16)} 세션 ${r.sessions} · 사용자 ${r.totalUsers} · 조회 ${r.pageViews}`);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
