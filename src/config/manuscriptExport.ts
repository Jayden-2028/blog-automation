// 승인된 원고를 맥 로컬 보관함으로 내보낼 때 쓰는 경로 규칙.
//
// 왜 저장소 밖인가(2026-09-16 사용자 결정): 이 보관함은 파이프라인 산출물이 아니라 사용자가
// 발행 작업을 하는 자리다. 구조는 <날짜>/<주제>/NN-slug.ext + image-metadata.md.
// 저장소의 manuscripts/<날짜>/<영문슬러그>/(npm run sync:images가 쓰는 미러)와는 목적이 다르다 -
// 그쪽은 뷰어·발행 코드가 읽는 작업 사본이고, 이쪽은 사람이 여는 최종 보관함이다.
//
// 위치(2026-09-20 사용자가 옮김): 워크트리(prod·repo·kw)의 **부모 디렉터리** 아래,
// `<부모>/blog-manuscripts/whyissuenow`. 원래는 ~/Documents 아래였는데 블로그 관련 폴더를
// `~/blog-automation/` 한곳으로 모으기로 한 결정(BLOGSPOT_ONLY_DESIGN.md)을 마무리한 것이다.
// 홈 디렉터리 절대경로를 박지 않고 PIPELINE_ROOT 기준 상대경로로 잡는 이유는, 워크트리가 여럿이라
// 어느 창에서 실행해도 같은 보관함을 가리켜야 하기 때문이다(전부 같은 부모를 공유한다).
//
// GitHub Actions에서는 이 경로가 존재하지 않는다. 내보내기는 맥 로컬 전용 단계다.

import { resolve } from "node:path";

import { PIPELINE_ROOT } from "./pipelinePaths.js";

export const MANUSCRIPT_EXPORT_ROOT =
  process.env.MANUSCRIPT_EXPORT_ROOT || resolve(PIPELINE_ROOT, "..", "blog-manuscripts", "whyissuenow");

/**
 * 주제 폴더 이름. 사용자가 폴더를 눈으로 훑는 자리라 한글 키워드를 그대로 쓴다(저장소 미러의
 * 영문 슬러그와 다른 이유). 경로에서 문제가 되는 문자만 걷어내고 길이를 자른다.
 */
export function exportFolderName(keyword: string): string {
  const cleaned = keyword
    .replace(/[/\\:*?"<>|]/g, " ")
    // 파일명 앞뒤의 점과 공백은 macOS/Finder에서 숨김 파일이나 잘린 이름으로 보인다.
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .trim();
  return cleaned.slice(0, 50).trim() || "제목없음";
}

export function exportTopicDir(date: string, keyword: string, shortName?: string | null): string {
  // shortName(배리에이션이 만든 짧은 한글 키워드)이 있으면 그것을 쓴다 - 제목 전체를 폴더명으로
  // 쓰면 너무 길어 훑어보기 나쁘다(사용자 요청, 2026-09-18). 옛 원고엔 없어 키워드로 폴백한다.
  return resolve(MANUSCRIPT_EXPORT_ROOT, date, exportFolderName(shortName || keyword));
}
