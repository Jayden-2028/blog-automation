// communityRecon.ts로 저장한 원본 HTML에서 "이게 인기글 제목 목록인 것 같다"는 후보 구조를
// 찾아내는 1회성 진단 도구. 실제 사이트 원문(22KB+)을 통째로 옮기지 않고도, 어떤 CSS 선택자가
// 진짜 인기글 목록인지 판단할 수 있게 짧은 요약만 출력한다.
//
// 사용법(맥에서, communityRecon.ts로 HTML을 먼저 저장한 뒤):
//   1) 후보 그룹 찾기: npx tsx scripts/communityProbe.ts <파일>
//   2) 후보 그룹 하나를 골라 상세(상위 tr class 포함) 보기:
//      npx tsx scripts/communityProbe.ts <파일> "<CSS 선택자>"
//      예: npx tsx scripts/communityProbe.ts docs/ai-handoff/community-recon/theqoo.html "td.title > a"
//
// 원리(1단계): <a> 태그 중 텍스트 길이가 사람이 쓴 게시글 제목다운 범위(8~60자)인 것만 추리고,
// 그 <a>의 class(또는 부모 요소의 class)별로 묶어서 몇 개씩 나오는지 센다. 실제 목록은 같은
// class를 가진 <a>가 목록 길이만큼(보통 10~30개) 반복되므로, 그 그룹이 가장 유력한 후보다.
// 광고/네비게이션 링크는 대개 이 길이 범위를 벗어나거나 개수가 적어 자연히 걸러진다.
//
// 2단계가 필요한 이유: 1단계로 찾은 그룹 안에 상단 고정 공지(운영 공지, 이용 규칙 등)가 진짜
// 인기글과 같은 태그 구조로 섞여 나오는 사이트가 있다. 공지는 보통 상위 행(tr 등)에 별도
// class(notice/pinned 등)가 붙거나 조회수/댓글수 같은 형식이 다르므로, 2단계는 각 항목의 상위
// tr(또는 li) class와 텍스트를 나란히 보여줘 사람이 눈으로 공지/일반글을 구분할 수 있게 한다.

import { readFileSync } from "node:fs";
import { parse, type HTMLElement } from "node-html-parser";

const MIN_TITLE_LENGTH = 8;
const MAX_TITLE_LENGTH = 60;
const TOP_GROUPS_TO_SHOW = 5;
const SAMPLE_TITLES_PER_GROUP = 8;

function classifyGroup(anchor: HTMLElement): string {
  const anchorClass = anchor.getAttribute("class")?.trim();
  if (anchorClass) return `a.${anchorClass.split(/\s+/).join(".")}`;

  const parent = anchor.parentNode as HTMLElement | null;
  const parentClass = parent?.getAttribute?.("class")?.trim();
  const parentTag = parent?.tagName?.toLowerCase();
  if (parentClass) return `${parentTag}.${parentClass.split(/\s+/).join(".")} > a`;
  return `${parentTag ?? "?"} > a (class 없음)`;
}

/** anchor에서 위로 올라가며 처음 만나는 tr 또는 li를 찾는다(둘 다 없으면 null). */
function findRowAncestor(anchor: HTMLElement): HTMLElement | null {
  let node: HTMLElement | null = anchor.parentNode as HTMLElement | null;
  while (node) {
    const tag = node.tagName?.toLowerCase();
    if (tag === "tr" || tag === "li") return node;
    node = node.parentNode as HTMLElement | null;
  }
  return null;
}

function printDetail(root: HTMLElement, selector: string): void {
  const matches = root.querySelectorAll(selector);
  if (matches.length === 0) {
    console.log(`선택자 "${selector}"에 매칭되는 요소가 없다. 1단계 출력의 선택자를 그대로 따옴표로 감싸서 넣었는지 확인할 것.`);
    return;
  }

  console.log(`▶ 선택자 "${selector}" 매칭 ${matches.length}건 - 각 항목의 상위 행(tr/li) class + 텍스트\n`);

  matches.forEach((anchor, index) => {
    const text = anchor.text.replace(/\s+/g, " ").trim();
    const row = findRowAncestor(anchor);
    const rowTag = row?.tagName?.toLowerCase() ?? "?";
    const rowClass = row?.getAttribute("class")?.trim() || "(class 없음)";
    console.log(`${String(index + 1).padStart(2)}. [${rowTag}.${rowClass}] ${text}`);
  });
}

function main(): void {
  const filePath = process.argv[2];
  const selector = process.argv[3];
  if (!filePath) {
    console.error('사용법: npx tsx scripts/communityProbe.ts <저장된 HTML 경로> ["<CSS 선택자>"]');
    process.exitCode = 1;
    return;
  }

  const html = readFileSync(filePath, "utf-8");
  const root = parse(html);

  if (selector) {
    printDetail(root, selector);
    return;
  }

  const anchors = root.querySelectorAll("a");

  const groups = new Map<string, string[]>();
  for (const anchor of anchors) {
    const text = anchor.text.replace(/\s+/g, " ").trim();
    if (text.length < MIN_TITLE_LENGTH || text.length > MAX_TITLE_LENGTH) continue;

    const key = classifyGroup(anchor);
    const list = groups.get(key) ?? [];
    list.push(text);
    groups.set(key, list);
  }

  const ranked = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);

  console.log(`▶ ${filePath}: <a> 총 ${anchors.length}개 중 제목 길이(${MIN_TITLE_LENGTH}~${MAX_TITLE_LENGTH}자) 후보 그룹 상위 ${TOP_GROUPS_TO_SHOW}개\n`);

  for (const [key, titles] of ranked.slice(0, TOP_GROUPS_TO_SHOW)) {
    console.log(`[${titles.length}건] ${key}`);
    for (const title of titles.slice(0, SAMPLE_TITLES_PER_GROUP)) {
      console.log(`  - ${title}`);
    }
    if (titles.length > SAMPLE_TITLES_PER_GROUP) {
      console.log(`  ... 외 ${titles.length - SAMPLE_TITLES_PER_GROUP}건`);
    }
    console.log();
  }

  if (ranked.length === 0) {
    console.log("후보를 하나도 못 찾았다 - 페이지가 JS로 목록을 그려서(SSR 아님) 정적 HTML에 목록이 없거나, 차단/로그인 페이지일 수 있다.");
  }
}

main();
