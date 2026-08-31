// 커뮤니티 수집을 단독 실행하는 CLI. `npm run collect:community`
//
// **기본이 dry-run이다.** 실제 trend_candidates 쓰기는 WRITE=1을 명시해야 한다 -
// 원격 DB 쓰기는 승인 대상이므로 실수로 켜지지 않게 한다(collect:google-trends와 같은 규약).
//
// 지금은 COMMUNITY_SOURCE_PROVIDERS가 비어 있어(CommunitySource.ts 참고) 이 CLI를 실행해도
// "0건 조회"만 나온다 - 실제 사이트 provider가 붙기 전까지는 배선이 맞는지 확인하는 용도다.
//
// 사용 예:
//   npm run collect:community                 # dry-run: 조회 + 추출 + 매핑만, DB 쓰기 없음
//   WRITE=1 npm run collect:community         # 실제 upsert (승인 후, provider가 붙은 뒤)

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

  console.log("\n결과:", result);
  if (result.status === "failed") process.exitCode = 1;
}

await main();
