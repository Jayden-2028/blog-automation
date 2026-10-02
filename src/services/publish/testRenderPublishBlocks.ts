// renderPublishBlocks 테스트 - 발행 서식 5개 규칙(2026-10-02 사용자 결정, 네이버 발행 글 실측).
//
//   1. 문단이 끝나면 빈 줄 1개       2. 소제목 19px / 본문 15px
//   3. 소제목 바로 아래 빈 줄 없음    4. 이미지 아래 빈 줄 1개
//   5. 마지막 문단과 해시태그 사이 빈 줄 2개
//
// 이 규칙은 발행 변환기 두 개와 원고 뷰어 복사 버튼이 **같이** 지켜야 한다. 여기서 깨지면
// "뷰어에서 복사해 붙여넣은 글"과 "버튼으로 발행한 글"의 서식이 갈린다.

import { renderPublishBlocks, PUBLISH_FONT_PX, SPACER_HTML, isHashtagLine } from "./renderPublishBlocks.js";
import type { PublishRenderOptions } from "./renderPublishBlocks.js";

const NAVER: PublishRenderOptions = { boldTag: "b", italicTag: "i", image: "img", linkTarget: false };

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

function main(): void {
  console.log("▶ renderPublishBlocks 테스트 시작\n");

  // 규칙 2 - 글자 크기는 본문 15 / 소제목 19(= 본문의 125%)
  assert(PUBLISH_FONT_PX.body === 15 && PUBLISH_FONT_PX.heading === 19, "글자 크기 상수 실패");
  assert(PUBLISH_FONT_PX.heading === Math.round(PUBLISH_FONT_PX.body * 1.25), "소제목이 본문의 125%가 아니다");
  console.log("✅ 규칙 2 - 본문 15px, 소제목 19px(본문의 125%)");

  // 규칙 1 - 문단 사이에 빈 문단 하나
  const twoParagraphs = renderPublishBlocks("첫 문단입니다.\n\n둘째 문단입니다.", NAVER).split("\n");
  assert(twoParagraphs.length === 3, `문단 2개 + 빈 줄 1개여야 한다 (${twoParagraphs.length}줄)`);
  assert(twoParagraphs[1] === SPACER_HTML, `문단 사이 빈 줄 실패 (${twoParagraphs[1]})`);
  console.log("✅ 규칙 1 - 문단이 끝나면 빈 줄 1개");

  // 규칙 3 - 소제목과 본문 사이에는 빈 줄이 없다
  const section = renderPublishBlocks("**소제목 하나**\n섹션 본문입니다.\n\n다음 문단입니다.", NAVER).split("\n");
  assert(section[0] === '<p style="font-size:19px"><b>소제목 하나</b></p>', `소제목 실패 (${section[0]})`);
  assert(section[1] === '<p style="font-size:15px">섹션 본문입니다.</p>', `소제목 아래 빈 줄이 들어갔다 (${section[1]})`);
  assert(section[2] === SPACER_HTML && section.length === 4, `섹션 뒤 간격 실패 (${section.join(" | ")})`);
  console.log("✅ 규칙 3 - 소제목 바로 아래에는 빈 줄 없음");

  // 규칙 4 - 이미지 아래 빈 줄 1개(위는 앞 문단이 이미 만든 1개로 끝 - 중복되지 않는다)
  const withImage = renderPublishBlocks(
    "앞 문단입니다.\n\n![스틸컷](https://img.example.com/1.jpg)\n\n뒤 문단입니다.",
    NAVER
  ).split("\n");
  assert(withImage.length === 5, `이미지 블록 간격 실패 (${withImage.join(" | ")})`);
  assert(withImage[1] === SPACER_HTML && withImage[3] === SPACER_HTML, "이미지 위/아래 빈 줄 실패");
  assert(withImage[2] === '<img src="https://img.example.com/1.jpg" alt="스틸컷">', `이미지 변환 실패 (${withImage[2]})`);
  console.log("✅ 규칙 4 - 이미지 아래 빈 줄 1개(위는 앞 문단 간격과 겹치지 않음)");

  // 규칙 5 - 마지막 문단과 해시태그 사이 빈 줄 2개, 해시태그 뒤에는 없음
  const tail = renderPublishBlocks("마무리 문단입니다.\n\n#한글날 #연휴", NAVER).split("\n");
  assert(tail.length === 4, `해시태그 앞 간격 실패 (${tail.join(" | ")})`);
  assert(tail[1] === SPACER_HTML && tail[2] === SPACER_HTML, "해시태그 앞 빈 줄 2개 실패");
  assert(tail[3] === '<p style="font-size:15px">#한글날 #연휴</p>', `해시태그 줄 실패 (${tail[3]})`);
  console.log("✅ 규칙 5 - 마지막 문단과 해시태그 사이 빈 줄 2개");

  // 해시태그 판정: 모든 토큰이 #으로 시작할 때만(본문에 # 하나 섞인 문단은 아니다)
  assert(isHashtagLine("#하나 #둘 #셋"), "해시태그 줄 판정 실패");
  assert(!isHashtagLine("#1번 질문에 대한 답입니다"), "본문을 해시태그로 오판");
  console.log("✅ 해시태그 줄 판정(모든 토큰이 #으로 시작)");

  // 글 끝에는 빈 문단이 남지 않는다(붙여넣었을 때 아래 공백이 생기지 않게)
  const trailing = renderPublishBlocks("문단 하나입니다.\n\n문단 둘입니다.", NAVER);
  assert(!trailing.endsWith(SPACER_HTML), `끝 빈 줄이 남았다 (${trailing})`);
  console.log("✅ 글 끝에 빈 문단이 남지 않는다");

  console.log("\n✅ 전체 테스트 통과");
}

main();
