// 트랙별 원고 뷰어 페이지 분리 테스트(§3.4). 파일 쓰기 없이 renderManuscriptPage의 필터만 본다.
import { renderManuscriptPage } from "./renderManuscriptPage.js";
import type { ManuscriptManifest, ManuscriptTopicEntry } from "./manuscriptManifest.js";
import { topicTrack } from "./manuscriptManifest.js";
import { viewerPageLink } from "../../config/manuscriptViewerPages.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

function topic(jobId: string, keyword: string, track?: "social" | "kscene"): ManuscriptTopicEntry {
  return {
    jobId,
    keyword,
    category: "living",
    date: "2026-10-05",
    readyAt: "2026-10-05T01:00:00Z",
    manuscript: {
      title: `${keyword} 제목`,
      searchDescription: null,
      slug: null,
      tags: [],
      body: "본문",
      imagePrompts: [],
      images: [],
      filePath: "x",
      ...(track ? { track } : {}),
    },
  };
}

const manifest: ManuscriptManifest = {
  topics: [topic("ent-1", "엔터원고"), topic("soc-1", "사회원고", "social")],
};

assert(topicTrack(manifest.topics[0]) === "entertainment", "track 없는 과거 행은 엔터");
assert(topicTrack(manifest.topics[1]) === "social", "track=social");

const entHtml = renderManuscriptPage(manifest);
assert(entHtml.includes("엔터원고") && !entHtml.includes("사회원고"), "기본(엔터) 페이지에는 사회 원고가 없어야 한다");
assert(entHtml.includes("<title>원고 뷰어</title>") && entHtml.includes("텔레그램 버튼으로 발행"), "엔터 페이지 문구는 기존 그대로");

const socialHtml = renderManuscriptPage(manifest, new Date(), { track: "social" });
assert(socialHtml.includes("사회원고") && !socialHtml.includes("엔터원고"), "사회 페이지에는 사회 원고만");
assert(socialHtml.includes("🟠 티스토리 버튼으로 발행") && !socialHtml.includes("수동 발행") && !socialHtml.includes("텔레그램 버튼으로 발행"), "사회 페이지는 🟠 티스토리 버튼 안내(수동 발행 문구 없음)");
assert(entHtml.includes("--pen:#1B5E3A") && !entHtml.includes("#E8590C"), "엔터(네이버용) 강조색은 다크 그린");
assert(socialHtml.includes("--pen:#1F3A68") && !socialHtml.includes("#E8590C"), "사회 강조색은 네이비");
assert(socialHtml.includes('var TRACK = "social"') && entHtml.includes('var TRACK = "entertainment"'), "페이지 스크립트가 자기 트랙을 안다");
// 뷰어 발행 버튼은 **사회 페이지에만** 있다(2026-11-05 복원). 엔터·사용설명서는 코드조차 없어야 한다 -
// 들어 있지 않은 것이 "그 트랙에는 진입점이 없다"는 사실을 가장 분명히 한다(PUBLISH_SCRIPT는 트랙으로 가린다).
assert(socialHtml.includes("/api/publish-request") && socialHtml.includes('id="publish-tistory"'), "사회 페이지에는 뷰어 발행 버튼과 요청 코드가 있어야 한다");
assert(socialHtml.includes("btn-publish") && socialHtml.includes("publish-bar"), "발행 버튼은 툴바와 구분되는 전용 스타일을 쓴다");
for (const [name, html] of [["엔터", entHtml], ["사용설명서", renderManuscriptPage(manifest, new Date(), { track: "kscene" })]] as const) {
  assert(!html.includes("/api/publish-request") && !html.includes("publish-tistory"), `${name} 페이지에 뷰어 발행 버튼 코드가 없어야 한다`);
}
assert(entHtml.includes("텔레그램의 🟢 네이버 발행 버튼으로만 됩니다"), "엔터는 그대로 텔레그램 버튼 안내");
assert(socialHtml.includes("또는 텔레그램 버튼으로 됩니다"), "사회는 뷰어·텔레그램 두 진입점을 안내한다");
const kHtml = renderManuscriptPage(manifest, new Date(), { track: "kscene" });
assert(kHtml.includes("텔레그램의 🔵 Blogger 발행 버튼으로만 됩니다") && kHtml.includes("/api/image-pick"), "사용설명서 페이지도 발행 안내와 후보 교체 코드가 있다");
assert(socialHtml.includes("/api/image-pick") && entHtml.includes("/api/image-pick"), "후보 클릭 교체 코드는 전 트랙 페이지가 공유한다");
console.log("✅ 트랙별 페이지 분리 - 엔터/사회 분리, 뷰어 발행 버튼은 사회만, 트랙별 안내");

assert(viewerPageLink("https://p.dev", "entertainment", "j1") === "https://p.dev/#j1", "엔터 링크는 루트 그대로");
assert(viewerPageLink("https://p.dev", "social", "j1") === "https://p.dev/social.html#j1", "사회 링크는 social.html");
console.log("✅ viewerPageLink");

console.log("\n✅ testManuscriptTrackPages 전체 통과");
