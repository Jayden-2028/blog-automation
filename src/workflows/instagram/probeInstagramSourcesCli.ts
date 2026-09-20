// 타당성 검증(probe) - 본 구현 전에 **이 소스가 쓸 만한지부터** 확인한다(2026-09-21).
//
// 여기서 막히면 설계가 통째로 바뀌므로 코드를 더 쌓기 전에 이것부터 돌린다. 확인 항목:
//   1. 조회 가능 여부        - 개인 계정이면 Business Discovery가 실패한다(목록에서 빠진다)
//   2. 최근 48시간 게시물 수  - 하루 후보 풀이 몇 건이나 되는지(20건을 뽑을 만한 양인가)
//   3. 과거 게시물 30건 확보  - 페이지별 "평소 수준" 중앙값을 낼 수 있는가
//   4. 실제로 오는 필드       - 좋아요·댓글이 다 오는지, 릴스 조회수가 오는지
//
// 사용: npm run ig:probe            (요약)
//       npm run ig:probe -- --json  (원본 JSON까지)
import "dotenv/config";

import { BusinessDiscoveryClient } from "../../services/instagram/BusinessDiscoveryClient.js";
import type { InstagramMedia } from "../../services/instagram/BusinessDiscoveryClient.js";
import { INSTAGRAM_SOURCES } from "../../config/instagramSources.js";

const RECENT_WINDOW_HOURS = 48;
/** 페이지의 "평소 수준"을 내려면 이만큼은 있어야 한다(아래면 중앙값이 불안정하다). */
const BASELINE_MIN_POSTS = 30;

function hoursAgo(timestamp: string): number {
  return (Date.now() - new Date(timestamp).getTime()) / 36e5;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function engagement(media: InstagramMedia): number {
  // 댓글에 가중치를 더 준다 - 좋아요보다 행동 비용이 크고, "이게 뭐야?"처럼 검색 의도가
  // 직접 드러나는 신호라서다. 배수는 데모 결과를 보고 조정한다.
  return (media.like_count ?? 0) + (media.comments_count ?? 0) * 3;
}

async function main(): Promise<void> {
  const showJson = process.argv.includes("--json");
  const client = new BusinessDiscoveryClient();

  const configError = client.missingConfig();
  if (configError) {
    console.error(`❌ ${configError}`);
    console.error("   .env에 IG_ACCESS_TOKEN / IG_USER_ID를 넣은 뒤 다시 실행하세요.");
    process.exitCode = 1;
    return;
  }

  console.log(`▶ 인스타 소스 ${INSTAGRAM_SOURCES.length}개 타당성 확인\n`);

  const reachable: string[] = [];
  const unreachable: Array<{ username: string; reason: string }> = [];
  const allFields = new Set<string>();
  let recentTotal = 0;

  for (const source of INSTAGRAM_SOURCES) {
    const result = await client.fetchAccount(source.username);

    if (!result.ok) {
      unreachable.push({ username: source.username, reason: result.hint ?? result.error });
      console.log(`❌ ${source.username.padEnd(18)} ${result.hint ?? result.error}`);
      continue;
    }

    const recent = result.media.filter((m) => hoursAgo(m.timestamp) <= RECENT_WINDOW_HOURS);
    const baseline = median(result.media.map(engagement));
    const missingLikes = result.media.filter((m) => m.like_count == null).length;

    recentTotal += recent.length;
    reachable.push(source.username);
    result.observedFields.forEach((f) => allFields.add(f));

    const baselineWarn = result.media.length < BASELINE_MIN_POSTS ? ` ⚠️ 과거 ${result.media.length}건(30 미만)` : "";
    const likeWarn = missingLikes > 0 ? ` ⚠️ 좋아요 없음 ${missingLikes}건` : "";

    console.log(
      `✅ ${source.username.padEnd(18)} 팔로워 ${result.followersCount.toLocaleString().padStart(9)} | ` +
        `최근 ${String(recent.length).padStart(2)}건 | 수집 ${String(result.media.length).padStart(2)}건 | ` +
        `평소 ${Math.round(baseline).toLocaleString()}${baselineWarn}${likeWarn}`
    );

    if (showJson && result.media[0]) {
      console.log(`   샘플: ${JSON.stringify(result.media[0])}`);
    }
  }

  console.log("\n" + "─".repeat(70));
  console.log(`조회 가능 ${reachable.length}개 / 불가 ${unreachable.length}개`);
  console.log(`최근 ${RECENT_WINDOW_HOURS}시간 게시물 합계: ${recentTotal}건  → 하루 후보 풀`);
  console.log(`응답에 실제로 온 필드: ${[...allFields].join(", ")}`);

  if (unreachable.length > 0) {
    console.log("\n조회 불가 목록(instagramSources.ts에서 reachable:false로 기록하세요):");
    for (const item of unreachable) console.log(`  - ${item.username}: ${item.reason}`);
  }

  // 판정: 후보 풀이 top 20을 뽑을 만한가. 너무 적으면 페이지를 늘려야 한다.
  if (recentTotal < 60) {
    console.log(`\n⚠️ 후보가 ${recentTotal}건뿐입니다. top 20을 뽑으려면 페이지를 더 추가하는 편이 좋습니다.`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
