// articleContentParts / pickFinalArticle 테스트. 실행: npm run test:article-parts
import { removeReferencesBlock, splitTrailingHashtags } from "./articleContentParts.js";
import { pickFinalArticle } from "./pickFinalArticle.js";
import type { ArticleRow } from "../../types/database.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`❌ ${msg}`);
}
const row = (id: number, platform: string | null): ArticleRow => ({ id, platform }) as ArticleRow;

{
  const r = splitTrailingHashtags("본문\n\n**참고 자료**\n- [a](https://a)\n\n#가 #나\n\n고지 문장");
  assert(r.tags.join(",") === "가,나", "태그 추출");
  assert(!r.body.includes("#가") && r.body.includes("참고 자료") && r.body.includes("고지 문장"), "해시태그 줄만 뗀다");
  console.log("✅ 해시태그 줄 분리");
}
{
  const out = removeReferencesBlock("본문\n\n**참고 자료**\n- [a](https://a)\n- [b](https://b)\n\n#가 #나\n\n고지");
  assert(!out.includes("https://") && !out.includes("참고 자료"), "참고 자료 목록 제거");
  assert(out.includes("#가 #나") && out.includes("고지") && out.includes("본문"), "해시태그·고지·본문은 남긴다");
  assert(removeReferencesBlock("본문만") === "본문만", "참고 자료가 없으면 그대로");
  console.log("✅ 참고 자료 블록만 제거");
}
{
  assert(pickFinalArticle([]) === null, "원고 없음");
  assert(pickFinalArticle([row(1, null)])?.final.id === 1, "기준 원고만 있으면 그것");
  assert(pickFinalArticle([row(1, null), row(2, "blogspot")])?.final.id === 2, "기준보다 새 과거 배리에이션은 그것");
  assert(pickFinalArticle([row(2, "blogspot"), row(30, null)])?.final.id === 30, "수정 반영으로 기준이 더 새것이면 기준");
  console.log("✅ 최종 원고 선택");
}
console.log("\n🎉 통과");
