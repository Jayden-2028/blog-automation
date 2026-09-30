// 커뮤니티 수집을 단독 실행하는 CLI. `npm run collect:community`
//
// **기본이 dry-run이다.** 실제 trend_candidates 쓰기는 WRITE=1을 명시해야 한다 -
// 원격 DB 쓰기는 승인 대상이므로 실수로 켜지지 않게 한다(collect:google-trends와 같은 규약).
//
// 등록된 사이트는 CommunitySource.ts의 COMMUNITY_SOURCE_PROVIDERS가 정한다(2026-09-30 기준
// 더쿠 + 루리웹). dry-run도 LLM 추출까지는 실제로 돈다 - 헤드리스 호출 1회를 쓴다.
//
// 사용 예:
//   npm run collect:community                 # dry-run: 조회 + 추출 + 매핑만, DB 쓰기 없음
//   WRITE=1 npm run collect:community         # 실제 upsert (승인 후)

import { runCommunityCollection } from "./runCommunityCollection.js";
import { COMMUNITY_SOURCE_PROVIDERS } from "../../services/community/CommunitySource.js";

const write = process.env.WRITE === "1";

async function main(): Promise<void> {
  console.log(`▶ 커뮤니티 수집 (${write ? "WRITE" : "dry-run"})\n`);
  console.log(
    `등록된 사이트: ${COMMUNITY_SOURCE_PROVIDERS.length}개` +
      (COMMUNITY_SOURCE_PROVIDERS.length > 0
        ? ` (${COMMUNITY_SOURCE_PROVIDERS.map((p) => p.label).join(", ")})`
        : " - 아직 실측 전이라 provider가 하나도 없다(CommunitySource.ts 참고)")
  );

  const result = await runCommunityCollection({ enabled: true, dryRun: !write });

  // dry-run은 "저장될 내용"을 눈으로 보는 게 목적이라 미리보기를 펼친다. 사이트별 건수를 함께
  // 세는 이유: 한 사이트가 조용히 0건이 돼도 합계(fetchedCount)만으로는 안 드러난다.
  const preview = result.preparedPreview;
  if (preview && preview.length > 0) {
    const bySite = new Map<string, number>();
    for (const row of preview) bySite.set(row.site, (bySite.get(row.site) ?? 0) + 1);

    console.log(`\n저장될 키워드 ${preview.length}건 (사이트별: ${[...bySite].map(([s, n]) => `${s} ${n}`).join(", ")})`);
    for (const row of preview) {
      console.log(`  ${row.keyword}  [${row.category}] ${row.site} ${row.siteRank}위 · score ${row.candidateScore}`);
    }
  }

  const { preparedPreview: _preview, ...summary } = result;
  console.log("\n결과:", summary);

  // 글은 긁혔는데 저장될 게 하나도 없으면 LLM 추출이 빈손으로 끝난 것이다. 조용히 성공으로
  // 넘기면 다음 사람이 "정상인데 dry-run이라 0"으로 오해한다.
  if (result.fetchedCount > 0 && result.preparedCount === 0) {
    console.log("\n⚠️ 글은 조회됐는데 저장될 키워드가 0건이다 - LLM 추출 결과를 확인할 것.");
  }
  if (result.status === "failed") process.exitCode = 1;
}

await main();
