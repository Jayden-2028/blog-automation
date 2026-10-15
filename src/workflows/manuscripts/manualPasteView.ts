// 수동 복붙 트랙(person)의 뷰어 원고에서 잉여 블록을 뺀다(2026-10-15, WRITING-HUMANIZE B-2).
//
// person은 네이버 발행 경로(publishJobToNaver의 removeRelatedPosts + removeReferencesBlock)를 타지 않는다 - 사용자가 뷰어에서
// 복사해 직접 붙여넣는다. 그래서 뷰어 본문에 "함께 보면 좋은 글"(Blogspot 주소 내부 링크)과 "참고 자료"(바깥 링크아웃)가
// 남아 붙여넣을 때마다 손으로 지워야 했다(차정원 원고 실측). 발행 경로가 쓰는 두 함수를 그대로 재사용해 같은 기준으로 뺀다.
//
// 뷰어(manifest) 쪽 본문에서만 뺀다. DB 원문(articles.content)에는 블록을 남긴다(감사·내부 링크 자산 유지) -
// 뷰어 수정 반영(applyViewerEdits)은 블록 번호가 아니라 원문 텍스트로 DB 본문의 같은 블록을 찾으므로
// 꼬리 블록이 한쪽에만 있어도 안전하다.
import { isManualPublishOnly } from "../publish/manualPublishOnly.js";
import { removeRelatedPosts } from "./appendRelatedPosts.js";
import { removeReferencesBlock } from "./articleContentParts.js";

/** category가 수동 복붙 트랙이면 뷰어용 본문에서 내부 링크·참고 자료를 뺀다. 그 외에는 그대로 돌려준다. */
export function viewerBodyForCategory(category: string | null | undefined, body: string): string {
  if (!isManualPublishOnly({ category })) return body;
  return removeReferencesBlock(removeRelatedPosts(body));
}
