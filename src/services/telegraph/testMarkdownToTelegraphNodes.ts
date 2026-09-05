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

  // 1) **소제목** 볼드 한 줄 -> h3, 바로 다음 줄(빈 줄 없음)은 이어지는 p.
  const withHeader = markdownToTelegraphNodes("**2026년 일정과 가격**\n본문 내용입니다.");
  assert(isTag(withHeader[0], "h3"), `첫 블록은 h3여야 한다 (실제: ${JSON.stringify(withHeader[0])})`);
  assert(withHeader[0].children?.[0] === "2026년 일정과 가격", "h3 텍스트가 정확해야 한다");
  assert(isTag(withHeader[1], "p"), "소제목 바로 다음 줄은 p로 이어져야 한다");
  console.log("✅ **소제목** -> h3(+바로 이어지는 p) 변환");

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

  // 3-1) *이탤릭* -> i (2026-08-28, 의학 원고 하단 고지를 "작은 글씨"로 근사하기 위해 추가).
  // 별표 뒤에 공백 없이 붙는 형태(buildMedicalDisclaimer가 만드는 형태)를 검증한다 - 공백이 있으면
  // "- 목록" 마커와 혼동될 수 있어 프롬프트/코드 양쪽이 공백 없는 형태로 맞춘다.
  const withItalic = markdownToTelegraphNodes("*의학적으로 사실 확인을 거친 정보가 아닙니다.*");
  const italicP = withItalic[0];
  assert(isTag(italicP, "p"), "이탤릭이 섞인 줄도 p 블록이어야 한다");
  const italicChild = italicP.children?.find((c) => isTag(c, "i"));
  assert(italicChild !== undefined, "*텍스트*가 i 태그로 변환돼야 한다");
  assert(
    (italicChild as { children?: TelegraphNode[] }).children?.[0] === "의학적으로 사실 확인을 거친 정보가 아닙니다.",
    "i 태그 내용이 정확해야 한다"
  );
  console.log("✅ *이탤릭* -> <i> 변환");

  // 3-2) **굵게**와 *이탤릭*이 같은 줄에 섞여도 굵게가 이탤릭으로 잘못 쪼개지지 않아야 한다.
  const mixedEmphasis = markdownToTelegraphNodes("**굵은 텍스트**와 *기울인 텍스트*가 섞여 있다.");
  const mixedP = mixedEmphasis[0];
  assert(isTag(mixedP, "p"), "혼합된 줄도 p 블록이어야 한다");
  const boldInMixed = mixedP.children?.find((c) => isTag(c, "b"));
  const italicInMixed = mixedP.children?.find((c) => isTag(c, "i"));
  assert(boldInMixed !== undefined, "**굵게**가 여전히 b로 인식돼야 한다");
  assert(italicInMixed !== undefined, "*이탤릭*이 i로 인식돼야 한다");
  assert(
    (boldInMixed as { children?: TelegraphNode[] }).children?.[0] === "굵은 텍스트",
    "굵게 태그 내용이 이탤릭 패턴에 오염되면 안 된다"
  );
  console.log("✅ **굵게**와 *이탤릭* 혼용 -> 서로 침범하지 않고 각각 b/i로 변환");

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

  // 5-1) 이미지(![alt](url)) -> figure > img + figcaption(2026-08-28, AI 생성 이미지 삽입 기능).
  const withImage = markdownToTelegraphNodes("![경복궁 야경 일러스트](https://storage.example.com/a.png)");
  const figureNode = withImage[0];
  assert(isTag(figureNode, "figure"), `이미지 블록은 figure여야 한다 (실제: ${JSON.stringify(figureNode)})`);
  const imgNode = figureNode.children?.find((c) => isTag(c, "img"));
  assert(imgNode !== undefined, "figure 안에 img가 있어야 한다");
  assert(
    (imgNode as { attrs?: Record<string, string> }).attrs?.src === "https://storage.example.com/a.png",
    "img의 src가 정확해야 한다"
  );
  const figcaptionNode = figureNode.children?.find((c) => isTag(c, "figcaption"));
  assert(figcaptionNode !== undefined, "alt 텍스트가 figcaption으로 함께 나와야 한다(검수 편의)");
  assert(
    (figcaptionNode as { children?: TelegraphNode[] }).children?.[0] === "경복궁 야경 일러스트",
    "figcaption 내용이 alt 텍스트와 일치해야 한다"
  );
  console.log("✅ ![alt](url) -> <figure><img/><figcaption> 변환");

  // 5-2) alt 텍스트가 빈 문자열이면 figcaption 없이 img만 나온다.
  const withoutAlt = markdownToTelegraphNodes("![](https://storage.example.com/b.png)");
  const bareFigure = withoutAlt[0];
  assert(isTag(bareFigure, "figure"), "alt 없어도 figure여야 한다");
  assert(
    !bareFigure.children?.some((c) => isTag(c, "figcaption")),
    "alt가 없으면 figcaption을 만들지 않아야 한다"
  );
  console.log("✅ alt 없는 이미지 -> figcaption 없이 img만");

  // 6) 회귀: 실제 원고 구조(헤더+문단 붙임 -> 목록 순서)를 그대로 변환했을 때 순서가 보존돼야 한다.
  const fullArticle = [
    "가을 저녁 경복궁을 걸으며 궁중음식을 맛보는 별빛야행이 올해도 열립니다.",
    "**경복궁 별빛야행은 어떤 프로그램인가**\n경복궁 별빛야행은 경복궁 북측 권역을 전문 해설과 함께 걷는 야간 탐방 프로그램입니다.",
    "**자주 묻는 질문**\n가격은 1인 6만 원이고 도슭수라상 체험이 포함됩니다.",
    "**참고 자료**\n- [경복궁 별빛야행](https://www.kh.or.kr/program/view/menu/527?idx=576)\n- [국가유산진흥원](https://www.kh.or.kr/)",
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

  // 8) 이미지 보류(2026-09-01): "[IMAGE: 설명]" 마커는 이미지 markdown(![](url))이 아니므로
  //    그대로 문단 텍스트로 통과해야 한다 - 사용자가 그 자리에 직접 이미지를 넣도록 안내한다.
  const withMarker = markdownToTelegraphNodes("도입 문단입니다.\n\n[IMAGE: 한강 불꽃축제 전경, 얼굴 없는 관람객 뒷모습]\n\n다음 문단.");
  const markerTags = withMarker.map((n) => (typeof n === "object" ? n.tag : "text"));
  assert(JSON.stringify(markerTags) === JSON.stringify(["p", "p", "p"]), `[IMAGE:] 마커는 문단으로 통과해야 한다 (실제: ${JSON.stringify(markerTags)})`);
  assert(JSON.stringify(withMarker).includes("[IMAGE: 한강 불꽃축제"), "마커 텍스트가 그대로 남아야 한다");
  assert(!JSON.stringify(withMarker).includes('"tag":"figure"'), "마커를 figure/img로 변환하면 안 된다");
  console.log("✅ [IMAGE: 설명] 마커 -> 문단 텍스트로 통과(figure 변환 안 함)");

  console.log("\n✅ markdownToTelegraphNodes 테스트 완료");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
