// buildPublishReadyMessage 테스트. 실제 Telegram 발송은 하지 않는다 - 메시지 조립만 검증한다.

import { buildPublishReadyMessage } from "./notifyPublishReady.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

function main(): void {
  console.log("▶ buildPublishReadyMessage 테스트 시작\n");

  // 1) 기본 메시지 - 제목/초안 버튼이 포함된다
  const basic = buildPublishReadyMessage({
    keyword: "테스트 키워드",
    title: "테스트 원고 제목",
    draftUrl: "https://blog.naver.com/bj2028/postwrite?categoryNo=32",
    imageCount: 0,
  });
  assert(basic.text.includes("테스트 원고 제목"), "제목이 메시지에 포함돼야 한다");
  assert(basic.replyMarkup?.inline_keyboard[0][0].url === "https://blog.naver.com/bj2028/postwrite?categoryNo=32", "초안 URL 버튼이 있어야 한다");
  assert(!("callback_data" in basic.replyMarkup!.inline_keyboard[0][0]), "결정 버튼(callback_data)이 없어야 한다 - 여기서 할 결정이 없다");
  console.log("✅ 기본 메시지: 제목 + 초안 확인 버튼(URL, callback_data 없음)");

  // 2) 이미지 개수가 0이면 이미지 줄을 안 붙인다
  assert(!basic.text.includes("이미지"), "이미지 0장이면 이미지 줄이 없어야 한다");
  console.log("✅ 이미지 0장 -> 이미지 줄 생략");

  // 3) 이미지 개수가 있으면 줄이 붙는다
  const withImages = buildPublishReadyMessage({
    keyword: "테스트 키워드",
    title: "테스트 원고 제목",
    draftUrl: "https://blog.naver.com/bj2028/postwrite?categoryNo=32",
    imageCount: 3,
  });
  assert(withImages.text.includes("이미지 3장"), `이미지 개수가 표시돼야 한다 (실제: ${withImages.text})`);
  console.log("✅ 이미지 3장 -> 이미지 줄 포함");

  // 4) title이 없으면 keyword로 대체한다
  const noTitle = buildPublishReadyMessage({
    keyword: "대체용 키워드",
    title: null,
    draftUrl: "https://blog.naver.com/bj2028/postwrite?categoryNo=32",
    imageCount: 0,
  });
  assert(noTitle.text.includes("대체용 키워드"), "title이 없으면 keyword로 대체돼야 한다");
  console.log("✅ title 없음 -> keyword로 대체");

  // 5) HTML 특수문자 이스케이프 (제목에 <, >, & 등이 있으면 Telegram이 400을 낼 수 있다)
  const withSpecialChars = buildPublishReadyMessage({
    keyword: "키워드",
    title: "5<10 & 후기",
    draftUrl: "https://blog.naver.com/bj2028/postwrite?categoryNo=32",
    imageCount: 0,
  });
  assert(withSpecialChars.text.includes("5&lt;10 &amp; 후기"), `특수문자 이스케이프 실패 (실제: ${withSpecialChars.text})`);
  console.log("✅ 제목 HTML 특수문자 이스케이프");

  console.log("\n✅ 전체 테스트 통과");
}

main();
