// 원고 파이프라인 파일 산출물 경로. 헤드리스 에이전트(researcher.md / writer.md)가 여기에
// 파일을 쓰고, Node는 그 경로를 읽어 DB에 반영한다.
//
// 왜 Node가 경로를 정하는가: researcher.md §7 / writer.md §9는 "이미 있으면 -YYYY-MM-DD를 붙인다"
// 같은 충돌 규칙을 두지만, Node가 정확한 경로를 지정하고 프롬프트에 박아 넘기면 에이전트가 어디에
// 썼는지 되짚어 찾을 필요가 없다. job 재실행 시에는 같은 경로에 덮어쓴다(job 1건 = 파일 1개).

import { resolve } from "node:path";

/** 파이프라인 파일이 놓이는 repo 루트. 헤드리스 호출의 cwd로도 쓴다. */
export const PIPELINE_ROOT = process.env.PIPELINE_ROOT || process.cwd();

/**
 * 키워드 → 파일명 슬러그. researcher.md §7 규칙: 공백 → `-`, 경로/제어 문자 제거, 한글 유지.
 * 파일시스템에서 문제되는 문자(`/ \ : * ? " < > |`)와 앞뒤 공백·점을 걷어낸다.
 */
export function keywordSlug(keyword: string): string {
  const cleaned = keyword
    .trim()
    .replace(/[/\\:*?"<>|]/g, "")
    .replace(/\s+/g, "-")
    .replace(/^[.\-]+|[.\-]+$/g, "");
  return cleaned || "keyword";
}

export function researchFilePath(keyword: string): string {
  return resolve(PIPELINE_ROOT, "research", `${keywordSlug(keyword)}.md`);
}

export function draftFilePath(keyword: string, suffix?: string): string {
  const base = keywordSlug(keyword);
  const name = suffix ? `${base}-${suffix}` : base;
  return resolve(PIPELINE_ROOT, "drafts", `${name}.md`);
}
