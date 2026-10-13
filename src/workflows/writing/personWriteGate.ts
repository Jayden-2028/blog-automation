// 인물 백과(category=person) write 차단 게이트(발주서 A-8, 회신 D-3-(d), 2026-10-13).
//
// 인물 실명 글이라 자료조사 verdict가 blocked(official+news 0건)인데도 자동 집필로 넘어가면 근거 없는 실명 원고가
// 나올 수 있다. 다른 카테고리는 verdict와 무관하게 진행한다(runResearchStageCli.ts의 기존 결정) - 이 게이트는
// person에만 걸린다.
//
// 실패 문구에 "blocked"를 넣는 이유: notifyWriteFailed.describeWriteFailure가 /blocked/로 자료 부족을 알아보고
// 기존 실패 알림(자료가 부족해서 글을 쓰지 않았어요 + [🔍 자료조사 다시 하기]/[🗑 반려])을 그대로 낸다.

import { parseResearchFile } from "../research/parseResearchFile.js";

/**
 * person이고 research frontmatter의 verdict가 blocked면 실패 사유 문자열, 아니면 null.
 * researchText가 없으면(읽지 못함) 판정할 근거가 없으므로 막지 않는다 - 파일이 없는 경우는 앞 단계가 이미 처리한다.
 */
export function personBlockedWriteError(category: string | null | undefined, researchText: string | null | undefined): string | null {
  if (category !== "person" || !researchText) return null;
  const { verdict } = parseResearchFile(researchText);
  if (verdict !== "blocked") return null;
  return "인물 백과(person) 자료조사 verdict가 blocked(official+news 0건)라 집필하지 않았습니다 - 인물 실명 글은 근거 없이 쓰지 않습니다";
}
