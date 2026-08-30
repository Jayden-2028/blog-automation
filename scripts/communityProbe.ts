// communityRecon.ts로 저장한 원본 HTML에서 "이게 인기글 제목 목록인 것 같다"는 후보 구조를
// 찾아내는 1회성 진단 도구. 실제 사이트 원문(22KB+)을 통째로 옮기지 않고도, 어떤 CSS 선택자가
// 진짜 인기글 목록인지 판단할 수 있게 짧은 요약만 출력한다.
//
// 사용법(맥에서, communityRecon.ts로 HTML을 먼저 저장한 뒤):
//   npx tsx scripts/communityProbe.ts docs/ai-handoff/community-recon/theqoo.html
//
// 원리: <a> 태그 중 텍스트 길이가 사람이 쓴 게시글 제목다운 범위(8~60자)인 것만 추리고, 그
// <a>의 class(또는 부모 요소의 class)별로 묶어서 몇 개씩 나오는지 센다. 실제 목록은 같은
// class를 가진 <a>가 목록 길이만큼(보통 10~30개) 반복되므로, 그 그룹이 가장 유력한 후보다.
// 광고/네비게이션 링크는 대개 이 길이 범위를 벗어나거나 개수가 적어 자연히 걸러진다.

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

function main(): void {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error("사용법: npx tsx scripts/communityProbe.ts <저장된 HTML 경로>");
    process.exitCode = 1;
    return;
  }

  const html = readFileSync(filePath, "utf-8");
  const root = parse(html);
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
