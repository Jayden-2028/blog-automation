// 구글 트렌드 수집을 단독 실행하는 CLI. `npm run collect:google-trends`
//
// **기본이 dry-run이다.** 실제 trend_candidates 쓰기는 WRITE=1을 명시해야 한다 -
// 원격 DB 쓰기는 승인 대상이므로 실수로 켜지지 않게 한다(collect:creator-advisor와 같은 규약).
//
// 사용 예:
//   npm run collect:google-trends                 # dry-run: RSS 조회 + 매핑만, DB 쓰기 없음
//   WRITE=1 npm run collect:google-trends         # 실제 upsert (승인 후)
//   GEO=JP npm run collect:google-trends          # 다른 국가 코드로 확인

import { runGoogleTrendsCollection } from "./runGoogleTrendsCollection.js";
import { fetchGoogleTrends } from "../../services/search/providers/googleTrends/GoogleTrendsProvider.js";

const write = process.env.WRITE === "1";
const geo = process.env.GEO ?? "KR";

async function main(): Promise<void> {
  console.log(`▶ 구글 트렌드 수집 (geo=${geo}, ${write ? "WRITE" : "dry-run"})\n`);

  // dry-run에서는 조회 결과를 사람이 눈으로 확인할 수 있게 목록도 함께 출력한다 - 이 소스는
  // 아직 실측 검증되지 않았으므로 "무엇이 들어오는지" 보는 것이 첫 번째 목적이다.
  if (!write) {
    try {
      const fetched = await fetchGoogleTrends({ geo });
      console.log(`요청 URL: ${fetched.requestUrl}`);
      console.log(`파싱된 항목: ${fetched.items.length}건\n`);
      fetched.items.forEach((item, index) => {
        const traffic = item.approxTraffic ? ` (${item.approxTraffic})` : "";
        console.log(`  ${String(index + 1).padStart(2)}. ${item.keyword}${traffic}`);
        for (const news of item.newsItems.slice(0, 2)) {
          console.log(`        └ ${news.source ?? "?"}: ${news.title}`);
        }
      });
      console.log("");
    } catch (error) {
      console.error("⚠️ 조회 실패 -", error instanceof Error ? error.message : String(error));
      console.error("   엔드포인트나 응답 형식이 바뀌었을 수 있다. parseGoogleTrendsRss.ts 상단 주석 참고.");
    }
  }

  const result = await runGoogleTrendsCollection({
    enabled: true,
    dryRun: !write,
    geo,
  });

  console.log("결과:", result);
  if (result.status === "failed") process.exitCode = 1;
}

await main();
