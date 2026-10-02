// 뷰어의 "본문 복사"가 발행 변환기와 **같은 서식**을 내는지 본다. 실행: npm run test:viewer-copy
//
// 왜 이 테스트가 있는가(2026-10-02): 사용자는 뷰어에서 본문을 복사해 네이버 편집기·Blogspot에
// 그대로 붙여넣는다. 그래서 뷰어 복사 결과와 발행 버튼 경로(renderPublishBlocks.ts)의 서식이
// 갈리면, 같은 원고가 경로에 따라 다르게 보인다. 뷰어 쪽 복사 로직은 브라우저로 내보내는
// 문자열 템플릿 안에 있어 import할 수 없으므로, 렌더된 페이지에서 그 함수들을 잘라 내
// 실제로 실행해 renderPublishBlocks 출력과 비교한다.
//
// 지켜야 할 것: 5개 서식 규칙(문단 뒤 1줄 / 소제목 19px / 소제목 아래 0줄 / 이미지 뒤 1줄 /
// 해시태그 앞 2줄)이 두 구현에서 같다.

import { renderManuscriptPage } from "./renderManuscriptPage.js";
import { renderPublishBlocks } from "../../services/publish/renderPublishBlocks.js";
import type { PublishRenderOptions } from "../../services/publish/renderPublishBlocks.js";
import type { ManuscriptManifest, ManuscriptTopicEntry } from "./manuscriptManifest.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const TAGS = ["한글날", "연휴"];

// 소제목·문단·목록·이미지·해시태그가 모두 들어간 본문. 작은 따옴표는 쓰지 않는다 -
// 뷰어 esc()는 '를 &#39;로 바꾸고 발행 변환기는 그대로 둔다(둘 다 안전하지만 문자열이 달라진다).
const BODY = [
  "도입 문단입니다. 첫 줄이 답입니다.",
  "**금요일 한글날, 사흘 연휴**\n10월 9일 금요일부터 11일 일요일까지 사흘입니다.",
  "[IMAGE: 달력 — 웹 검색]",
  "**무엇이 바뀌나**\n- 첫째 항목입니다\n- 둘째 항목입니다",
  "마무리 문단입니다.",
].join("\n\n");

/** 뷰어가 쓰는 블록 모양으로 만들기 위해 렌더된 페이지에서 복사 로직만 잘라 낸다. */
function extractCollectRichHtml(html: string): (topic: unknown) => string {
  const pieces: string[] = [];

  const consts = html.match(/var BODY_PX = [^\n]+;/);
  assert(consts, "뷰어에서 BODY_PX/HEADING_PX/SPACER 선언을 찾지 못했다(이름이 바뀌었나?)");
  pieces.push(consts[0]);

  for (const name of ["esc", "hashtagLine", "isListLine", "stripListMarker", "inlineHtml", "linesToHtml", "blockHtml", "collectRichHtml"]) {
    const start = html.indexOf(`function ${name}(`);
    assert(start >= 0, `뷰어에서 ${name}()을 찾지 못했다(이름이 바뀌었나?)`);
    let depth = 0;
    let end = -1;
    for (let i = html.indexOf("{", start); i < html.length; i += 1) {
      if (html[i] === "{") depth += 1;
      else if (html[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    assert(end > start, `${name}()의 본문 끝을 찾지 못했다`);
    pieces.push(html.slice(start, end));
  }

  // 편집 중인 DOM 요소는 없다(복사 시점에 수정값이 없는 경우와 같다).
  const prelude = "function findEditable() { return null; }";
  // eslint-disable-next-line no-new-func
  return new Function("topic", `${prelude}\n${pieces.join("\n")}\nreturn collectRichHtml(topic);`) as (
    topic: unknown
  ) => string;
}

function entry(): ManuscriptTopicEntry {
  return {
    jobId: "054bfe0b-1234-4abc-8def-0123456789ab",
    keyword: "한글날 연휴",
    category: "living",
    date: "2026-10-02",
    readyAt: "2026-10-02T00:00:00.000Z",
    manuscript: {
      title: "한글날 연휴, 금요일부터 사흘",
      searchDescription: null,
      slug: null,
      tags: TAGS,
      body: BODY,
      imagePrompts: ["한글날 달력"],
      images: [],
      imageNotes: [],
      filePath: "manuscripts/2026-10-02/한글날-연휴.md",
      naver: null,
    },
  };
}

/** 발행 변환기 쪽 기대값. 뷰어는 이미지를 [[이미지 N]] 자리로 남기므로 같은 자리에 넣고 비교한다. */
function expected(): string {
  const options: PublishRenderOptions = { boldTag: "b", italicTag: "i", image: "img", linkTarget: false };
  const markdown = [BODY.replace("[IMAGE: 달력 — 웹 검색]", "[[이미지 1]]"), `#${TAGS.join(" #")}`].join("\n\n");
  return renderPublishBlocks(markdown, options);
}

function main(): void {
  console.log("▶ 뷰어 복사 서식 테스트 시작\n");

  const manifest: ManuscriptManifest = { topics: [entry()] };
  const html = renderManuscriptPage(manifest, new Date("2026-10-02T09:00:00Z"));
  const collectRichHtml = extractCollectRichHtml(html);

  const dataMatch = html.match(/<script id="manuscript-data" type="application\/json">([\s\S]*?)<\/script>/);
  assert(dataMatch, "뷰어 페이지에서 원고 데이터(JSON)를 찾지 못했다");
  const topics = JSON.parse(dataMatch[1]);
  assert(Array.isArray(topics) && topics.length === 1, "원고 데이터 1건이어야 한다");

  const viewer = collectRichHtml(topics[0]);
  const publish = expected();

  if (viewer !== publish) {
    console.log("--- 뷰어 복사 ---\n" + viewer);
    console.log("--- 발행 변환 ---\n" + publish);
  }
  assert(viewer === publish, "뷰어 복사 HTML이 발행 변환 결과와 다르다(서식 규칙이 갈렸다)");
  console.log("✅ 뷰어 복사 HTML == renderPublishBlocks 출력");

  // 규칙이 실제로 들어 있는지도 직접 확인한다(두 구현이 똑같이 틀린 경우를 잡는다).
  const lines = viewer.split("\n");
  assert(lines[0] === '<p style="font-size:15px">도입 문단입니다. 첫 줄이 답입니다.</p>', `도입 문단 실패 (${lines[0]})`);
  assert(lines[1] === "<p>&nbsp;</p>", "문단 뒤 빈 줄 1개 실패");
  assert(lines[2] === '<p style="font-size:19px"><b>금요일 한글날, 사흘 연휴</b></p>', `소제목 19px 실패 (${lines[2]})`);
  assert(lines[3].startsWith('<p style="font-size:15px">10월 9일'), `소제목 아래 빈 줄이 들어갔다 (${lines[3]})`);
  assert(viewer.includes('<p style="font-size:15px">[[이미지 1]]</p>\n<p>&nbsp;</p>'), "이미지 뒤 빈 줄 1개 실패");
  assert(viewer.includes('<ul style="font-size:15px">'), "목록 본문 크기 실패");
  assert(
    viewer.endsWith('<p>&nbsp;</p>\n<p>&nbsp;</p>\n<p style="font-size:15px">#한글날 #연휴</p>'),
    "해시태그 앞 빈 줄 2개 실패"
  );
  console.log("✅ 5개 서식 규칙이 복사 결과에 그대로 들어간다");

  console.log("\n✅ 전체 테스트 통과");
}

main();
