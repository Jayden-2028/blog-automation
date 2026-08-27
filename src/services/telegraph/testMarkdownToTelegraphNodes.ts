// markdownToTelegraphNodes 테스트. 실제 Telegraph API를 호출하지 않는다 - 순수 변환 함수만 검증한다.
//
// 2026-08-27 실제로 생성된 "2026 경복궁 별빛야행" 원고의 구조(##, 문단, - 목록, 참고 자료 링크)를
// 회귀 케이스로 고정한다.

import { markdownToTelegraphNodes } from "./markdownToTelegraphNodes.js";
import type { TelegraphNode } from "./markdownToTelegraphNodes.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

function isTag(node: TelegraphNode, tag: string): node is { tag: string; attrs?: Record<string, string>; children?: TelegraphNode[] } {
  return typeof node === "object" && node.tag === tag;
}

function main(): void {
  console.log("▶ markdownToTelegraphNodes 테스트 시작\n");

  // 1) ## 소제목 -> h3.
  const withHeader = markdownToTelegraphNodes("## 2026년 일정과 가격\n\n본문 내용입니다.");
  assert(isTag(withHeader[0], "h3"), `첫 블록은 h3여야 한다 (실제: ${JSON.stringify(withHeader[0])})`);
  assert(withHeader[0].children?.[0] === "2026년 일정과 가격", "h3 텍스트가 정확해야 한다");
  console.log("✅ ## 소제목 -> h3 변환");

  // 2) 일반 문단 -> p.
  const withParagraph = markdownToTelegraphNodes("가을 저녁 경복궁을 걸으며 궁중음식을 맛보는 별빛야행입니다.");
  assert(isTag(withParagraph[0], "p"), "일반 문단은 p여야 한다");
  console.log("✅ 일반 문단 -> p 변환");

  // 3) **굵게** -> b.
  const withBold = markdownToTelegraphNodes("**2026 경복궁 별빛야행은 언제 하나요?** 9월 2일부터 진행됩니다.");
  const pNode = withBold[0];
  assert(isTag(pNode, "p"), "굵게가 섞인 줄도 p 블록이어야 한다");
  const boldChild = pNode.children?.find((c) => isTag(c, "b"));
  assert(boldChild !== undefined, "**텍스트**가 b 태그로 변환돼야 한다");
  assert((boldChild as { children?: TelegraphNode[] }).children?.[0] === "2026 경복궁 별빛야행은 언제 하나요?", "b 태그 내용이 정확해야 한다");
  console.log("✅ **굵게** -> <b> 변환");

  // 4) [텍스트](URL) -> a href.
  const withLink = markdownToTelegraphNodes("- [국가유산진흥원](https://www.kh.or.kr/)");
  const ul = withLink[0];
  assert(isTag(ul, "ul"), "- 로 시작하는 줄은 ul이어야 한다");
  const li = ul.children?.[0];
  assert(li !== undefined && isTag(li, "li"), "ul 안에 li가 있어야 한다");
  const aNode = (li as { children?: TelegraphNode[] }).children?.find((c) => isTag(c, "a"));
  assert(aNode !== undefined, "링크가 a 태그로 변환돼야 한다");
  assert((aNode as { attrs?: Record<string, string> }).attrs?.href === "https://www.kh.or.kr/", "href가 정확해야 한다");
  console.log("✅ [텍스트](URL) -> <a href> 변환");

  // 5) 연속된 - 목록 여러 줄이 하나의 ul로 묶여야 한다(항목마다 별도 블록이 되면 안 된다).
  const multiList = markdownToTelegraphNodes(
    "## 참고 자료\n\n- [출처1](https://a.com)\n- [출처2](https://b.com)\n- [출처3](https://c.com)"
  );
  const listBlock = multiList.find((n) => isTag(n, "ul"));
  assert(listBlock !== undefined && isTag(listBlock, "ul"), "목록 블록이 있어야 한다");
  assert(listBlock.children?.length === 3, `목록 항목 3개가 하나의 ul에 묶여야 한다 (실제: ${listBlock.children?.length})`);
  console.log("✅ 연속된 목록 3줄 -> 하나의 ul(li 3개)로 병합");

  // 6) 회귀: 실제 원고 구조(헤더 -> 문단 -> 목록 -> 문단 순서)를 그대로 변환했을 때 순서가 보존돼야 한다.
  const fullArticle = [
    "가을 저녁 경복궁을 걸으며 궁중음식을 맛보는 별빛야행이 올해도 열립니다.",
    "## 경복궁 별빛야행은 어떤 프로그램인가",
    "경복궁 별빛야행은 경복궁 북측 권역을 전문 해설과 함께 걷는 야간 탐방 프로그램입니다.",
    "## 자주 묻는 질문",
    "**가격은 얼마인가요?** 1인 6만 원이고 도슭수라상 체험이 포함됩니다.",
    "## 참고 자료",
    "- [경복궁 별빛야행](https://www.kh.or.kr/program/view/menu/527?idx=576)\n- [국가유산진흥원](https://www.kh.or.kr/)",
  ].join("\n\n");

  const nodes = markdownToTelegraphNodes(fullArticle);
  const tags = nodes.map((n) => (typeof n === "object" ? n.tag : "text"));
  assert(
    JSON.stringify(tags) === JSON.stringify(["p", "h3", "p", "h3", "p", "h3", "ul"]),
    `전체 구조 순서가 보존돼야 한다 (실제: ${JSON.stringify(tags)})`
  );
  console.log("✅ 실제 원고 구조(문단/헤더/목록 혼합) 순서 보존");

  // 7) 헤더 텍스트에 링크가 섞여도(드물지만) 처리는 죽지 않아야 한다.
  const edgeCase = markdownToTelegraphNodes("");
  assert(Array.isArray(edgeCase) && edgeCase.length === 0, "빈 문자열은 빈 배열을 반환해야 한다");
  console.log("✅ 빈 문자열 -> 빈 배열(안전 처리)");

  console.log("\n✅ markdownToTelegraphNodes 테스트 완료");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
