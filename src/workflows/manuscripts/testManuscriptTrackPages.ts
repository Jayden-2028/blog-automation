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
const kHtml = renderManuscriptPage(manifest, new Date(), { track: "kscene" });

// 뷰어 발행 버튼은 **사회·사용설명서 페이지에만** 있다(2026-11-05 사용자 지시). 엔터는 코드조차 없어야
// 한다 - 네이버는 뷰어에서 복사해 직접 올리는 채널이라 버튼이 가리킬 곳이 없고, 들어 있지 않은 것이
// "그 트랙에는 진입점이 없다"는 사실을 가장 분명히 한다(publishScript는 PUBLISH_BUTTONS로 가린다).
assert(socialHtml.includes("/api/publish-request") && socialHtml.includes('id="publish-tistory"'), "사회 페이지에는 뷰어 발행 버튼과 요청 코드가 있어야 한다");
assert(socialHtml.includes('channel: "tistory"'), "사회 버튼은 티스토리로 요청한다");
assert(kHtml.includes("/api/publish-request") && kHtml.includes('id="publish-blogspot"'), "사용설명서 페이지에도 뷰어 발행 버튼이 있어야 한다");
assert(kHtml.includes('channel: "blogspot"') && !kHtml.includes('channel: "tistory"'), "사용설명서 버튼은 Blogger로 요청한다");
assert(kHtml.includes("🔵 Blogger 발행") && !kHtml.includes("TISTORY_DRAFT_ONLY ? '🔵"), "Blogger에는 임시저장 모드가 없어 라벨이 하나뿐이다");
for (const [name, html] of [["사회", socialHtml], ["사용설명서", kHtml]] as const) {
  assert(html.includes("btn-publish") && html.includes("publish-bar"), `${name} 발행 버튼은 툴바와 구분되는 전용 스타일을 쓴다`);
}
assert(!entHtml.includes("/api/publish-request") && !entHtml.includes("publish-tistory") && !entHtml.includes("publish-blogspot"), "엔터 페이지에 뷰어 발행 버튼 코드가 없어야 한다");
assert(entHtml.includes("텔레그램의 🟢 네이버 발행 버튼으로만 됩니다"), "엔터는 그대로 텔레그램 버튼 안내");
assert(socialHtml.includes("또는 텔레그램 버튼으로 됩니다"), "사회는 뷰어·텔레그램 두 진입점을 안내한다");
assert(kHtml.includes("아래 🔵 Blogger 버튼 또는 텔레그램 버튼으로 됩니다") && kHtml.includes("/api/image-pick"), "사용설명서 페이지도 두 진입점 안내와 후보 교체 코드가 있다");
assert(socialHtml.includes("/api/image-pick") && entHtml.includes("/api/image-pick"), "후보 클릭 교체 코드는 전 트랙 페이지가 공유한다");
console.log("✅ 트랙별 페이지 분리 - 엔터/사회 분리, 뷰어 발행 버튼은 사회·사용설명서, 트랙별 안내");

assert(viewerPageLink("https://p.dev", "entertainment", "j1") === "https://p.dev/#j1", "엔터 링크는 루트 그대로");
assert(viewerPageLink("https://p.dev", "social", "j1") === "https://p.dev/social.html#j1", "사회 링크는 social.html");
console.log("✅ viewerPageLink");


// 뷰어에는 "참고 자료" 목록을 보이지 않는다(2026-11-20, 전 트랙). 해시태그는 남는다.
{
  const { stripViewerReferences } = await import("./writeManuscriptPages.js");
  const body = "본문 문단입니다.\n\n**참고 자료**\n- [MTN](https://news.mtn.co.kr/a)\n- [엘르](https://www.elle.co.kr/b)\n\n#영화폭설 #김윤석";
  const topic = { ...manifest.topics[0], manuscript: { ...manifest.topics[0].manuscript, body, naver: { title: "n", body, tags: [] } } };
  const stripped = stripViewerReferences({ topics: [topic] });
  const out = stripped.topics[0].manuscript;
  if (out.body.includes("참고 자료") || out.body.includes("mtn.co.kr") || out.naver?.body.includes("참고 자료")) throw new Error("❌ 뷰어 본문에 참고 자료가 남았다");
  if (!out.body.includes("본문 문단입니다.") || !out.body.includes("#영화폭설")) throw new Error("❌ 참고 자료를 빼면서 본문·해시태그까지 지웠다");
  if (!topic.manuscript.body.includes("참고 자료")) throw new Error("❌ 원본 manifest를 건드렸다(뷰어 렌더용 사본만 바꿔야 한다)");
  console.log("✅ 뷰어 본문에서 참고 자료를 뺀다(전 트랙, 원본은 그대로)");
}

console.log("\n✅ testManuscriptTrackPages 전체 통과");
