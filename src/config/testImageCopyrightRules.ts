// imageCopyrightRules 테스트. SPRINT_3_DESIGN.md 11절이 정한 세 형식만 통과해야 한다.

import { isValidImageCopyright, parseImageCopyright } from "./imageCopyrightRules.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

function main(): void {
  console.log("▶ imageCopyrightRules 테스트 시작\n");

  // 1) 세 형식이 각각 통과하고 필드가 정확히 파싱돼야 한다.
  const ai = parseImageCopyright("ai-generated:chatgpt");
  assert(ai?.kind === "ai-generated" && ai.tool === "chatgpt", `ai-generated 파싱 실패: ${JSON.stringify(ai)}`);

  const press = parseImageCopyright("press-release:kh.or.kr");
  assert(press?.kind === "press-release" && press.domain === "kh.or.kr", `press-release 파싱 실패: ${JSON.stringify(press)}`);

  const stock = parseImageCopyright("stock:unsplash:license-free");
  assert(
    stock?.kind === "stock" && stock.service === "unsplash" && stock.license === "license-free",
    `stock 파싱 실패: ${JSON.stringify(stock)}`
  );
  console.log("✅ 세 형식(ai-generated/press-release/stock) 정확히 파싱됨");

  // 2) 세 형식이 아니면 거부한다 - "검색으로 찾은 마음에 드는 이미지"류의 자유 문자열이 핵심 타깃이다.
  const rejected = [
    null,
    undefined,
    "",
    "google-images",
    "found-on-blog",
    "아마 괜찮을듯",
    "ai-generated", // 도구 이름 없음
    "press-release", // 도메인 없음
    "press-release:notadomain", // 도메인처럼 안 보임(TLD 없음)
    "stock:unsplash", // 라이선스 없음
    "AI-GENERATED:chatgpt", // 대소문자
  ];
  for (const value of rejected) {
    assert(!isValidImageCopyright(value), `거부돼야 할 값이 통과했다: ${JSON.stringify(value)}`);
  }
  console.log(`✅ 형식에 안 맞는 값 ${rejected.length}종 전부 거부`);

  // 3) 도구/도메인/서비스/라이선스 이름에 흔한 문자(점, 하이픈, 언더스코어)가 있어도 통과해야 한다.
  assert(isValidImageCopyright("ai-generated:gpt-image-2"), "하이픈이 든 도구명도 통과해야 한다");
  assert(isValidImageCopyright("stock:my_service:cc-by-4.0"), "언더스코어/점이 든 라이선스명도 통과해야 한다");
  console.log("✅ 하이픈/언더스코어/점이 포함된 값도 정상 통과");

  console.log("\n✅ imageCopyrightRules 테스트 완료");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
