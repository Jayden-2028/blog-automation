// 다음 실시간 트렌드 수집을 단독 실행하는 CLI. `npm run collect:daum-realtime`
//
// **기본이 dry-run이다.** 실제 trend_candidates 쓰기는 WRITE=1을 명시해야 한다 -
// 원격 DB 쓰기는 승인 대상이므로 실수로 켜지지 않게 한다(collect:google-trends와 같은 규약).
//
// 사용 예:
//   npm run collect:daum-realtime          # dry-run: 홈페이지 조회 + 매핑만, DB 쓰기 없음
//   WRITE=1 npm run collect:daum-realtime  # 실제 upsert (승인 후)

import { runDaumRealtimeCollection } from "./runDaumRealtimeCollection.js";
import { fetchDaumRealtime } from "../../services/search/providers/daumRealtime/DaumRealtimeProvider.js";
import { resolveDaumRealtimeCategory } from "./mapDaumRealtimeCandidates.js";
import { isUsableTrendKeyword } from "../../config/trendSources.js";

const write = process.env.WRITE === "1";

async function main(): Promise<void> {
  console.log(`▶ 다음 실시간 트렌드 수집 (${write ? "WRITE" : "dry-run"})\n`);

  if (!write) {
    try {
      const fetched = await fetchDaumRealtime();
      console.log(`요청 URL: ${fetched.requestUrl}`);
      console.log(`갱신 시각(다음 기준): ${fetched.updatedAt ?? "알 수 없음"}`);
      console.log(`파싱된 항목: ${fetched.items.length}건\n`);

      fetched.items.forEach((item) => {
        const dropped = !isUsableTrendKeyword(item.keyword);
        const category = dropped ? "제외(너무 짧음)" : resolveDaumRealtimeCategory(item.keyword);
        console.log(
          `  ${String(item.displayRank).padStart(2)}. [${category}] ${item.keyword} ` +
            `(status=${item.status}${item.dataType ? `, ${item.dataType}` : ""})`
        );
      });

      const categoryCounts = new Map<string, number>();
      for (const item of fetched.items) {
        if (!isUsableTrendKeyword(item.keyword)) continue;
        const category = resolveDaumRealtimeCategory(item.keyword);
        categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
      }
      console.log(
        `\ncategory 분포: ${[...categoryCounts].map(([c, n]) => `${c} ${n}`).join(", ") || "(없음)"}\n`
      );
    } catch (error) {
      console.error("⚠️ 조회 실패 -", error instanceof Error ? error.message : String(error));
      console.error("   페이지 구조가 바뀌었을 수 있다. parseDaumRealtimePage.ts 상단 주석 참고.");
    }
  }

  const result = await runDaumRealtimeCollection({
    enabled: true,
    dryRun: !write,
  });

  console.log("결과:", result);
  if (result.status === "failed") process.exitCode = 1;
}

await main();
