// 임시저장된 Blogspot 초안을 공개하거나 미래 시각으로 예약한다(2026-09-16 사용자 요청).
//
// 왜 별도 CLI인가: 자동 발행 파이프라인(publishArticleToBlogspot)은 초안까지만 만든다
// (BLOGGER_PUBLISH_AS_DRAFT=true). 그 사이에 **사람이 반드시 해야 하는 일**이 있기 때문이다 -
// 퍼머링크와 검색 설명은 Blogger API로 설정할 수 없어서(2026-09-16 실측) UI에서 직접 넣어야 하고,
// 웹 검색 마커 자리의 이미지도 사람이 채워야 한다. 그 검수가 끝난 뒤 이 CLI로 공개/예약한다.
//
// ⚠️ 이 CLI는 글을 실제로 공개한다(예약도 결국 공개 예약이다). CLAUDE.md 발행 게이트 대상이라
// 사용자가 직접 실행하는 것을 전제로 한다 - 파이프라인에서 자동 호출하지 않는다.
//
// 사용법:
//   npm run blogspot:schedule -- <postId>                       즉시 공개
//   npm run blogspot:schedule -- <postId> "2026-09-17 09:00"    그 시각(KST)에 공개 예약
//
// postId는 임시저장 결과의 편집 링크 끝 숫자다:
//   https://www.blogger.com/blog/post/edit/<blogId>/<postId>
import "dotenv/config";

import { BloggerClient } from "../../services/publish/blogger/BloggerClient.js";

/** "2026-09-17 09:00" 또는 ISO 문자열을 Asia/Seoul 기준으로 해석한다. */
function parseKstDate(raw: string): Date | null {
  const iso = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(raw.trim())
    ? `${raw.trim().replace(" ", "T")}${raw.includes(":") && raw.trim().length <= 16 ? ":00" : ""}+09:00`
    : raw.trim();
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function main(): Promise<void> {
  const postId = process.argv[2];
  const when = process.argv[3];

  if (!postId) {
    console.log("사용법: npm run blogspot:schedule -- <postId> [\"2026-09-17 09:00\"]");
    console.log("  postId: 임시저장 편집 링크(.../post/edit/<blogId>/<postId>) 끝 숫자");
    console.log("  시각 생략 시 즉시 공개됩니다.");
    return;
  }

  let publishDate: Date | undefined;
  if (when) {
    const parsed = parseKstDate(when);
    if (!parsed) {
      console.error(`❌ 시각을 해석할 수 없습니다: ${when}`);
      console.error('   예: "2026-09-17 09:00" (KST) 또는 ISO 8601');
      process.exitCode = 1;
      return;
    }
    if (parsed.getTime() <= Date.now()) {
      console.error(`❌ 과거 시각입니다: ${parsed.toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })} (KST)`);
      console.error("   예약은 미래 시각만 됩니다. 즉시 공개하려면 시각 인자를 빼세요.");
      process.exitCode = 1;
      return;
    }
    publishDate = parsed;
  }

  const label = publishDate
    ? `${publishDate.toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })} (KST) 예약`
    : "즉시 공개";
  console.log(`▶ Blogspot ${label}: post ${postId}`);

  const result = await new BloggerClient().publishPost(postId, publishDate);

  if (!result.ok) {
    console.error(`❌ 실패 [${result.stage}]: ${result.error}`);
    process.exitCode = 1;
    return;
  }

  console.log("✅ 완료");
  console.log(`   status : ${result.status}`);
  console.log(`   공개일 : ${result.publishedAt}`);
  if (result.url) console.log(`   URL    : ${result.url}`);
  if (result.scheduled) console.log("   (예약됨 - 그 시각에 자동 공개됩니다)");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
