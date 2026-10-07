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
  for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Function(match[1]); // 문법 오류면 여기서 던진다
  console.log("✅ 정적 - 사이드바 제목, 초안 안내·채울 것 표 제거, 네이버 버튼 제거, 스크립트 문법");

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
    // /api/manuscript-edit은 Pages Function 자리다 - 여기서는 받은 내용을 적어 두고 202로 답한다.
    let servedHtml = html;
    const posted: string[] = [];
    const pickPosted: string[] = [];
    await tab.route("**/*", (route) => {
      const url = route.request().url();
      if (url === "https://viewer.test/") return route.fulfill({ body: servedHtml, contentType: "text/html" });
      if (url === "https://viewer.test/api/manuscript-edit") {
        posted.push(route.request().postData() ?? "");
        return route.fulfill({ status: 202, body: JSON.stringify({ ok: true }), contentType: "application/json" });
      }
      if (url === "https://viewer.test/api/image-pick") {
        pickPosted.push(route.request().postData() ?? "");
        return route.fulfill({ status: 202, body: JSON.stringify({ ok: true }), contentType: "application/json" });
      }
      // 가짜 주소의 나머지(파비콘 등)와 외부 이미지는 바깥 네트워크로 내보내지 않는다.
      if (url.startsWith("https://viewer.test/")) return route.fulfill({ status: 404, body: "" });
      return route.request().resourceType() === "image" ? route.abort() : route.continue();
    });
    tab.on("dialog", (dialog) => void dialog.accept());
    await tab.goto("https://viewer.test/", { waitUntil: "load" });

    // ④ 후보 묶음이 펼쳐져 있다.
    const openGroups = await tab.evaluate("document.querySelectorAll('details.cands[open]').length");
    assert(openGroups === 1, `후보 묶음이 처음부터 펼쳐져 있어야 한다 (${openGroups})`);

    // ⑤ 캡션 수정 버튼 - 자리 수만큼(채워진 자리·빈 자리 모두).
    const capButtons = await tab.evaluate("document.querySelectorAll('figure.cut .cap-edit').length");
    assert(capButtons === 2, `캡션 수정 버튼이 자리마다 있어야 한다 (${capButtons})`);
    const before = await tab.evaluate("document.querySelector('.cap[data-cap=\"1\"]').textContent");
    assert(before === "수집된 캡션", `수집 캡션이 먼저 보여야 한다 (${before})`);
    // 빈 자리는 마커 설명에서 획득 방식 꼬리를 떼고 보여준다(템플릿 안 정규식 역슬래시 버그, 2026-10-03).
    const emptyCaption = await tab.evaluate("document.querySelector('.cap[data-cap=\"2\"]').textContent");
    assert(emptyCaption === "둘째 자리", `빈 자리 캡션에서 '— AI 생성' 꼬리가 떨어져야 한다 (${emptyCaption})`);

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
    assert(after.badge.includes("저장 전까지 복사에만 적용"), `저장 전에는 복사에만 적용된다는 표시가 있어야 한다 (${after.badge})`);

    // 본문 수정을 켰다 껐다 해도 캡션 수정이 살아 있다.
    await tab.click("#edit-toggle");
    await tab.click("#edit-toggle");
    const kept = await tab.evaluate("document.querySelector('.cap[data-cap=\"1\"]').textContent");
    assert(kept === "고친 캡션", `본문 수정 저장이 캡션 수정을 지우면 안 된다 (${kept})`);

    // 원본으로 → 수집 캡션으로 돌아온다.
    await tab.click("#revert");
    const reverted = await tab.evaluate("document.querySelector('.cap[data-cap=\"1\"]').textContent");
    assert(reverted === "수집된 캡션", `원본으로 돌리면 수집 캡션이어야 한다 (${reverted})`);

    // ⑥ 수정본 반영 - 바뀐 항목만 from/to로 보낸다.
    await tab.click('.cap-edit[data-cap="1"]');
    await tab.evaluate("document.querySelector('.cap[data-cap=\"1\"]').innerText = '고친 캡션'");
    await tab.click('.cap-edit[data-cap="1"]');
    await tab.click("#edit-toggle");
    await tab.evaluate("document.querySelector('.editable[data-block-index=\"0\"]').innerText = '고친 도입 문단입니다.'");
    await tab.click("#edit-toggle");
    const submitLabel = (await tab.evaluate("(document.querySelector('#submit-edits') || {}).textContent || ''")) as string;
    assert(submitLabel.includes("2곳"), `바뀐 2곳만 세야 한다 - 안 바꾼 문단은 수정이 아니다 (${submitLabel})`);
    await tab.click("#submit-edits");
    await tab.waitForFunction("(document.querySelector('.edited-badge') || {}).textContent && document.querySelector('.edited-badge').textContent.indexOf('저장 요청') >= 0");
    assert(posted.length === 1, `요청 1건 (${posted.length})`);
    const sent = JSON.parse(posted[0]) as { jobId: string; edits: Record<string, { from: string; to: string }> };
    assert(sent.jobId === ENTRY.jobId, "jobId");
    assert(Object.keys(sent.edits).sort().join(",") === "0,cap:1", `보낸 키 (${Object.keys(sent.edits).join(",")})`);
    assert(sent.edits["0"].from === "도입 문단입니다." && sent.edits["0"].to === "고친 도입 문단입니다.", `본문 from/to (${JSON.stringify(sent.edits["0"])})`);
    assert(sent.edits["cap:1"].from === "수집된 캡션" && sent.edits["cap:1"].to === "고친 캡션", `캡션 from/to (${JSON.stringify(sent.edits["cap:1"])})`);

    // 다시 배포된 페이지(원본 = 수정본 + 반영 기록)를 열면 수정 기록이 저절로 비고 결과가 보인다.
    servedHtml = renderManuscriptPage(
      {
        topics: [
          {
            ...ENTRY,
            manuscript: {
              ...ENTRY.manuscript,
              body: BODY.replace("도입 문단입니다.", "고친 도입 문단입니다."),
              images: [{ ...ENTRY.manuscript.images[0], description: "고친 캡션" }],
              viewerEdit: {
                appliedAt: "2099-01-01T00:00:00.000Z",
                applied: ["0", "cap:1"],
                skipped: [{ key: "cap:2", reason: "이미지 자리 2번이 비어 있어 발행본에 실릴 캡션이 없습니다" }],
              },
            },
          },
        ],
      },
      new Date("2026-10-03T09:00:00Z")
    );
    await tab.goto("https://viewer.test/", { waitUntil: "load" });
    const afterDeploy = await tab.evaluate(
      "({ submit: !!document.querySelector('#submit-edits'), badge: !!document.querySelector('.edited-badge'), stored: localStorage.getItem('manuscript-edit:" + ENTRY.jobId + "'), result: (document.querySelector('.edit-result') || {}).textContent || '' })"
    ) as { submit: boolean; badge: boolean; stored: string | null; result: string };
    assert(!afterDeploy.submit && !afterDeploy.badge && afterDeploy.stored === null, `반영본이 배포되면 수정 기록이 비어야 한다 (${JSON.stringify(afterDeploy)})`);
    assert(afterDeploy.result.includes("2곳 저장") && afterDeploy.result.includes("이미지 2 캡션"), `반영 결과와 건너뛴 사유가 보여야 한다 (${afterDeploy.result})`);

    // ⑨ 제목 편집(2026-10-07) - ✏️ 수정 모드에서 제목을 고치면 키 "title"로 from/to가 간다. 한 줄이고, 이미 발행된 글에 소급 안 된다는 안내가 선다.
    servedHtml = html;
    await tab.evaluate("localStorage.clear()");
    await tab.goto("https://viewer.test/", { waitUntil: "load" });
    posted.length = 0;
    const titleNoteHidden = await tab.evaluate("getComputedStyle(document.querySelector('.title-note')).display");
    assert(titleNoteHidden === "none", `수정 모드 전에는 제목 안내가 숨어 있다 (${titleNoteHidden})`);
    await tab.click("#edit-toggle");
    const titleEditable = await tab.evaluate("[document.querySelector('.doc-title').getAttribute('contenteditable'), getComputedStyle(document.querySelector('.title-note')).display]") as [string, string];
    assert(titleEditable[0] === "true" && titleEditable[1] === "block", `수정 모드에서 제목이 편집되고 안내가 보인다 (${JSON.stringify(titleEditable)})`);
    await tab.evaluate("document.querySelector('.doc-title').innerText = '고친 제목\\n둘째 줄'");
    await tab.click("#edit-toggle");
    const shownTitle = await tab.evaluate("[document.querySelector('.doc-title').textContent, document.querySelector('.meta-grid').textContent.indexOf('고친 제목 둘째 줄') >= 0, document.querySelector('#submit-edits').textContent]") as [string, boolean, string];
    assert(shownTitle[0] === "고친 제목 둘째 줄" && shownTitle[1] && shownTitle[2].includes("1곳"), `제목이 한 줄로 접혀 화면·메타 표에 보이고 수정 1곳으로 센다 (${JSON.stringify(shownTitle)})`);
    await tab.click("#submit-edits");
    await tab.waitForFunction("document.querySelector('.edited-badge') && document.querySelector('.edited-badge').textContent.indexOf('저장 요청') >= 0");
    const titleSent = JSON.parse(posted[0]) as { edits: Record<string, { from: string; to: string }> };
    assert(Object.keys(titleSent.edits).join() === "title" && titleSent.edits.title.from === "제목" && titleSent.edits.title.to === "고친 제목 둘째 줄", `제목 from/to (${posted[0]})`);
    // 되돌려 같아지면 수정이 아니다.
    await tab.evaluate("localStorage.clear()");
    await tab.goto("https://viewer.test/", { waitUntil: "load" });
    await tab.click("#edit-toggle");
    await tab.evaluate("document.querySelector('.doc-title').innerText = '제목'");
    await tab.click("#edit-toggle");
    assert((await tab.evaluate("!document.querySelector('#submit-edits')")) === true, "제목을 원래대로 두면 수정으로 세지 않는다");
    console.log("✅ 브라우저 - 제목 편집: 수정 모드·한 줄·from/to·안내");

    // ⑩ 제목 옆 수정 버튼(2026-10-08) - 누르면 제목만 편집, 확인하면 수정으로 남고, 저장 전에는 "저장 안 됨" 경고가 눈에 띈다.
    servedHtml = html;
    await tab.evaluate("localStorage.clear()");
    await tab.goto("https://viewer.test/", { waitUntil: "load" });
    posted.length = 0;
    assert((await tab.evaluate("!document.querySelector('.edited-badge.unsaved')")) === true, "수정이 없으면 경고도 없다");
    await tab.click(".title-edit");
    const titleBoxState = await tab.evaluate("[document.querySelector('.doc-title').getAttribute('contenteditable'), document.querySelector('.title-edit').textContent, document.querySelector('.cap[data-cap=\"1\"]').getAttribute('contenteditable')]") as [string, string, string | null];
    assert(titleBoxState[0] === "true" && titleBoxState[1] === "확인" && titleBoxState[2] !== "true", `제목 수정 버튼은 제목만 편집 상태로 만든다 (${JSON.stringify(titleBoxState)})`);
    await tab.evaluate("document.querySelector('.doc-title').innerText = '버튼으로 고친 제목'");
    await tab.click(".title-edit");
    const afterTitleBtn = await tab.evaluate("({ title: document.querySelector('.doc-title').textContent, warn: (document.querySelector('.edited-badge.unsaved') || {}).textContent || '', submit: (document.querySelector('#submit-edits') || {}).textContent || '' })") as { title: string; warn: string; submit: string };
    assert(afterTitleBtn.title === "버튼으로 고친 제목" && afterTitleBtn.submit.includes("1곳"), `확인하면 수정 1곳으로 남는다 (${JSON.stringify(afterTitleBtn)})`);
    assert(afterTitleBtn.warn.includes("저장 안 됨") && afterTitleBtn.warn.includes("발행에 반영"), `저장 전에는 '저장 안 됨' 경고가 뜬다 (${afterTitleBtn.warn})`);
    assert(posted.length === 0, "확인만으로는 서버로 보내지 않는다");
    await tab.click("#submit-edits");
    await tab.waitForFunction("document.querySelector('.edited-badge') && document.querySelector('.edited-badge').textContent.indexOf('저장 요청') >= 0");
    assert((await tab.evaluate("!document.querySelector('.edited-badge.unsaved')")) === true, "저장 요청을 보내면 경고가 풀린다");
    assert(JSON.parse(posted[0]).edits.title.to === "버튼으로 고친 제목", "저장하면 title로 간다");
    console.log("✅ 브라우저 - 제목 옆 수정 버튼·저장 안 됨 경고");

    // ⑦ 후보 클릭 교체(2026-10-07) - 채택본은 안 눌리고, 다른 후보를 누르면 서버 번호 기준 요청이 가며, 처리 중 표식이 선다.
    servedHtml = html;
    await tab.evaluate("localStorage.clear()");
    await tab.goto("https://viewer.test/", { waitUntil: "load" });
    const pickUi = await tab.evaluate(
      "({ buttons: document.querySelectorAll('.cand-pick').length, pickedHasButton: !!document.querySelector('.cand.picked .cand-pick'), origLinks: Array.from(document.querySelectorAll('.cand a')).filter(function (a) { return a.textContent === '원본 보기'; }).length })"
    ) as { buttons: number; pickedHasButton: boolean; origLinks: number };
    assert(pickUi.buttons === 1 && !pickUi.pickedHasButton, `채택된 후보는 눌러서 교체할 수 없다 (${JSON.stringify(pickUi)})`);
    assert(pickUi.origLinks === 2, `원본 보기는 클릭 교체와 분리된 링크로 남는다 (${pickUi.origLinks})`);
    await tab.click('.cand-pick[data-cand="2"]');
    await tab.waitForFunction("document.querySelector('.cand-note.busy')");
    assert(pickPosted.length === 1, `교체 요청 1건 (${pickPosted.length})`);
    const pick = JSON.parse(pickPosted[0]) as Record<string, unknown>;
    assert(pick.jobId === ENTRY.jobId && pick.index === 1 && pick.candidateNumber === 2 && pick.fromUrl === "https://x/1.jpg", `교체 요청 내용 (${pickPosted[0]})`);
    assert(!("url" in pick), "후보 주소(URL)는 보내지 않는다 - 서버가 번호로 찾는다");
    const locked = await tab.evaluate("document.querySelector('.cand-pick').disabled");
    assert(locked === true, "처리 중에는 그 자리의 후보 버튼이 잠긴다");
    // 새로고침해도(서버 기록 전) 처리 중 표식이 남는다.
    await tab.goto("https://viewer.test/", { waitUntil: "load" });
    assert((await tab.evaluate("!!document.querySelector('.cand-note.busy')")) === true, "새로고침 후에도 교체 중 표식이 남는다");

    // 교체가 끝나 재배포된 페이지(imagePick.at이 보낸 시각 뒤 + 새 채택본)면 표식이 풀리고 캡션 확인 안내가 뜬다.
    servedHtml = renderManuscriptPage(
      {
        topics: [
          {
            ...ENTRY,
            manuscript: {
              ...ENTRY.manuscript,
              images: [{ ...ENTRY.manuscript.images[0], url: "https://x/2.jpg" }],
              imageCandidates: { "1": [{ number: 1, url: "https://x/1.jpg", sourcePage: "https://x" }, { number: 2, url: "https://x/2.jpg", sourcePage: "https://x", picked: true }] },
              imagePick: { at: "2099-01-01T00:00:00.000Z", index: 1, candidateNumber: 2, status: "done" },
            },
          },
        ],
      },
      new Date("2026-10-03T09:00:00Z")
    );
    await tab.goto("https://viewer.test/", { waitUntil: "load" });
    const done = await tab.evaluate("({ busy: !!document.querySelector('.cand-note.busy'), note: (document.querySelector('.cand-note') || {}).textContent || '', stored: Object.keys(localStorage).filter(function (k) { return k.indexOf('image-pick-sent') === 0; }).length })") as { busy: boolean; note: string; stored: number };
    assert(!done.busy && done.stored === 0 && done.note.includes("캡션") && done.note.includes("교체됨"), `교체가 끝나면 표식이 풀리고 캡션 확인 안내가 뜬다 (${JSON.stringify(done)})`);

    // 실패 기록은 사유와 대체 수단(다른 후보·텔레그램 이미지 수정)을 보여준다.
    servedHtml = renderManuscriptPage(
      { topics: [{ ...ENTRY, manuscript: { ...ENTRY.manuscript, imagePick: { at: "2099-01-01T00:00:00.000Z", index: 1, candidateNumber: 2, status: "failed", error: "HTTP 403" } } }] },
      new Date("2026-10-03T09:00:00Z")
    );
    await tab.goto("https://viewer.test/", { waitUntil: "load" });
    const failedNote = (await tab.evaluate("(document.querySelector('.cand-note.bad') || {}).textContent || ''")) as string;
    assert(failedNote.includes("HTTP 403") && failedNote.includes("이미지 수정"), `실패 사유와 대체 수단이 보여야 한다 (${failedNote})`);
    console.log("✅ 브라우저 - 후보 클릭 교체: 채택본 잠금·요청 내용·처리 중 표식·완료/실패 안내");

    // ⑧ 저장은 저장일 뿐이다(2026-10-07) - 뷰어에 발행 버튼이 없고, 확인창·토스트가 "발행 원고에 반영·배포"라 말하지 않으며, 발행 안내가 있다.
    const pubUi = await tab.evaluate(
      "({ pubBtn: !!document.querySelector('#publish-tistory, [id^=publish]'), hint: (document.querySelector('.pub-hint') || {}).textContent || '' })"
    ) as { pubBtn: boolean; hint: string };
    assert(!pubUi.pubBtn && pubUi.hint.includes("텔레그램"), `발행 버튼은 없고 텔레그램 안내가 있어야 한다 (${JSON.stringify(pubUi)})`);
    assert(!html.includes("/api/publish-request"), "뷰어는 /api/publish-request를 부르지 않는다");
    assert(!html.includes("발행 원고에 반영") && !html.includes("새로 배포됩니다"), "'발행 원고에 반영'·'배포' 문구가 남아 있으면 안 된다");
    // 저장 확인창 문구: 발행되지 않는다는 말이 들어간다.
    let confirmText = "";
    tab.removeAllListeners("dialog");
    tab.on("dialog", (dialog) => { confirmText = dialog.message(); void dialog.accept(); });
    await tab.click('.cap-edit[data-cap="1"]');
    await tab.evaluate("document.querySelector('.cap[data-cap=\"1\"]').innerText = '확인창 점검 캡션'");
    await tab.click('.cap-edit[data-cap="1"]');
    await tab.click("#submit-edits");
    await tab.waitForFunction("document.querySelector('.edited-badge') && document.querySelector('.edited-badge').textContent.indexOf('저장 요청') >= 0");
    assert(confirmText.includes("저장합니다") && confirmText.includes("발행되지 않습니다") && confirmText.includes("텔레그램"), `저장 확인창 문구 (${confirmText})`);
    console.log("✅ 브라우저 - 저장은 저장만: 발행 버튼 없음·텔레그램 안내·확인창 문구");

    assert(pageErrors.length === 0, `뷰어 스크립트 오류가 없어야 한다 (${pageErrors.join(" / ")})`);
  } finally {
    await browser.close();
  }
  console.log("✅ 브라우저 - 후보 항상 펼침, 캡션 자리별 수정·저장·되돌리기, 본문 수정과 공존");
  console.log("✅ 브라우저 - 수정본 반영은 바뀐 곳만 from/to로 보내고, 반영본이 배포되면 기록이 저절로 빈다");

  console.log("\n✅ 뷰어 레이아웃 테스트 전부 통과");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
