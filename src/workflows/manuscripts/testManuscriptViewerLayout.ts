// 뷰어 레이아웃·기능 정리(2026-10-03 사용자 결정)가 유지되는지 본다. 실행: npm run test:viewer-layout
//
// 지켜야 할 것:
//  ① 사이드바 제목이 "왜지금 NAVER & Blogger"다(옛 "우아아빠 · Blogspot" 아님).
//  ② "초안이 Blogspot에 자동 저장됩니다" 안내와 "발행 전 채울 것" 표가 없다(초안 저장은 09-19에 폐지).
//  ③ "네이버 배리에이션 없음" 문구·네이버 복사 버튼이 없다(배리에이션 단계는 09-30에 폐지).
//  ④ 후보 묶음이 처음부터 펼쳐져 있다(details[open]).
//  ⑤ 캡션마다 수정 버튼이 있고, 누르면 그 캡션만 편집되며, 저장하면 그림 아래 캡션과 캡션 표가
//     같은 값으로 바뀐다. 본문 수정(edit-toggle)을 저장해도 캡션 수정이 지워지지 않는다.
//
// 뷰어 스크립트는 템플릿 문자열 안에 있어 tsc가 못 잡으므로 ④⑤는 실제 Chromium으로 연다
// (testImageNotes.ts와 같은 방식, PLAYWRIGHT_CHROMIUM_PATH로 브라우저 경로를 바꿀 수 있다).
import { renderManuscriptPage } from "./renderManuscriptPage.js";
import type { ManuscriptManifest, ManuscriptTopicEntry } from "./manuscriptManifest.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const BODY = [
  "도입 문단입니다.",
  "[IMAGE: 첫 자리 — 웹 검색]",
  "**소제목**\n둘째 문단입니다.",
  "[IMAGE: 둘째 자리 — AI 생성]",
].join("\n\n");

const ENTRY: ManuscriptTopicEntry = {
  jobId: "054bfe0b-1234-4abc-8def-0123456789ab",
  keyword: "테스트 키워드",
  category: "living",
  date: "2026-10-03",
  readyAt: "2026-10-03T00:00:00.000Z",
  manuscript: {
    title: "제목",
    searchDescription: "검색 설명입니다",
    slug: "test-slug",
    tags: ["태그"],
    body: BODY,
    imagePrompts: ["검색어 1", "검색어 2"],
    images: [
      { index: 1, description: "수집된 캡션", prompt: null, url: "https://x/1.jpg", provider: "web", fileName: "01.jpg" },
    ],
    imageNotes: ["[자리 2] 생성 실패"],
    imageCandidates: {
      "1": [
        { number: 1, url: "https://x/1.jpg", sourcePage: "https://x", picked: true },
        { number: 2, url: "https://x/2.jpg", sourcePage: "https://x" },
      ],
    },
    filePath: "manuscripts/2026-10-03/테스트.md",
    naver: { title: "네이버 제목", body: BODY, tags: ["네이버"] },
  },
};

async function main(): Promise<void> {
  const manifest: ManuscriptManifest = { topics: [ENTRY] };
  const html = renderManuscriptPage(manifest, new Date("2026-10-03T09:00:00Z"));

  // ①②③ - 정적 HTML만 봐도 판단된다.
  assert(html.includes("왜지금 NAVER &amp; Blogger"), "사이드바 제목이 '왜지금 NAVER & Blogger'여야 한다");
  assert(!html.includes("우아아빠 · Blogspot"), "옛 사이드바 제목이 남아 있으면 안 된다");
  assert(!html.includes("초안이 Blogspot에 자동 저장"), "초안 자동 저장 안내는 없어야 한다(09-19 폐지)");
  assert(!html.includes("발행 전 채울 것"), "'발행 전 채울 것' 표는 없어야 한다");
  assert(!html.includes("네이버 배리에이션 없음"), "'네이버 배리에이션 없음' 문구는 없어야 한다");
  assert(!html.includes("네이버용 원고 복사"), "네이버 복사 버튼은 없어야 한다");
  assert(!html.includes('"naver":'), "manifest의 naver 본문을 페이지 JSON에 싣지 않는다");
  console.log("✅ 정적 - 사이드바 제목, 초안 안내·채울 것 표 제거, 네이버 버튼 제거");

  // ④⑤ - 브라우저.
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({
    args: ["--no-sandbox"],
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
  });
  try {
    const pageErrors: string[] = [];
    const tab = await browser.newPage();
    tab.on("pageerror", (error) => pageErrors.push(String(error)));
    // setContent(about:blank)는 origin이 불투명해 localStorage가 막힌다 - 수정 저장이 그 위에 있으므로
    // 가짜 주소로 서빙해 연다. 외부 이미지는 불러오지 않는다(테스트가 네트워크에 기대면 안 된다).
    await tab.route("**/*", (route) => {
      if (route.request().url() === "https://viewer.test/") return route.fulfill({ body: html, contentType: "text/html" });
      return route.request().resourceType() === "image" ? route.abort() : route.continue();
    });
    await tab.goto("https://viewer.test/", { waitUntil: "load" });

    // ④ 후보 묶음이 펼쳐져 있다.
    const openGroups = await tab.evaluate("document.querySelectorAll('details.cands[open]').length");
    assert(openGroups === 1, `후보 묶음이 처음부터 펼쳐져 있어야 한다 (${openGroups})`);

    // ⑤ 캡션 수정 버튼 - 자리 수만큼(채워진 자리·빈 자리 모두).
    const capButtons = await tab.evaluate("document.querySelectorAll('figure.cut .cap-edit').length");
    assert(capButtons === 2, `캡션 수정 버튼이 자리마다 있어야 한다 (${capButtons})`);
    const before = await tab.evaluate("document.querySelector('.cap[data-cap=\"1\"]').textContent");
    assert(before === "수집된 캡션", `수집 캡션이 먼저 보여야 한다 (${before})`);

    // 1번 수정 → 편집 상태는 1번만.
    await tab.click('.cap-edit[data-cap="1"]');
    const editing = await tab.evaluate(
      "[document.querySelector('.cap[data-cap=\"1\"]').getAttribute('contenteditable'), document.querySelector('.cap[data-cap=\"2\"]').getAttribute('contenteditable'), document.querySelector('.cap-edit[data-cap=\"1\"]').textContent]"
    ) as [string | null, string | null, string];
    assert(editing[0] === "true" && editing[1] !== "true", `누른 캡션만 편집돼야 한다 (${JSON.stringify(editing)})`);
    assert(editing[2] === "저장", `편집 중에는 버튼이 '저장'이어야 한다 (${editing[2]})`);

    // 글자를 바꾸고 저장 → 그림 캡션과 캡션 표가 같은 값.
    await tab.evaluate("document.querySelector('.cap[data-cap=\"1\"]').innerText = '고친 캡션'");
    await tab.click('.cap-edit[data-cap="1"]');
    const after = await tab.evaluate(
      "({ fig: document.querySelector('.cap[data-cap=\"1\"]').textContent, table: document.querySelector('table tbody tr td').textContent, copy: document.querySelector('table tbody tr .mini').getAttribute('data-copy'), badge: (document.querySelector('.edited-badge') || {}).textContent || '' })"
    ) as { fig: string; table: string; copy: string; badge: string };
    assert(after.fig === "고친 캡션", `저장한 캡션이 그림 아래에 보여야 한다 (${after.fig})`);
    assert(after.table.startsWith("고친 캡션"), `캡션 표도 같은 값이어야 한다 (${after.table})`);
    assert(after.copy === "고친 캡션", `캡션 표의 복사 버튼도 고친 값을 복사해야 한다 (${after.copy})`);
    assert(after.badge.includes("발행 버튼 미반영"), `수정이 발행에 반영되지 않는다는 표시가 있어야 한다 (${after.badge})`);

    // 본문 수정을 켰다 껐다 해도 캡션 수정이 살아 있다.
    await tab.click("#edit-toggle");
    await tab.click("#edit-toggle");
    const kept = await tab.evaluate("document.querySelector('.cap[data-cap=\"1\"]').textContent");
    assert(kept === "고친 캡션", `본문 수정 저장이 캡션 수정을 지우면 안 된다 (${kept})`);

    // 원본으로 → 수집 캡션으로 돌아온다.
    await tab.click("#revert");
    const reverted = await tab.evaluate("document.querySelector('.cap[data-cap=\"1\"]').textContent");
    assert(reverted === "수집된 캡션", `원본으로 돌리면 수집 캡션이어야 한다 (${reverted})`);

    assert(pageErrors.length === 0, `뷰어 스크립트 오류가 없어야 한다 (${pageErrors.join(" / ")})`);
  } finally {
    await browser.close();
  }
  console.log("✅ 브라우저 - 후보 항상 펼침, 캡션 자리별 수정·저장·되돌리기, 본문 수정과 공존");

  console.log("\n✅ 뷰어 레이아웃 테스트 전부 통과");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
