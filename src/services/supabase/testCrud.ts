import {
  createKeyword,
  getKeywordById,
  updateKeywordStatus,
} from "./repositories/keywordRepository.js";
import { createSource } from "./repositories/sourceRepository.js";
import { createArticle } from "./repositories/articleRepository.js";
import { createPublication } from "./repositories/publicationRepository.js";

async function main() {
  console.log("▶ Supabase CRUD 테스트 시작");

  // 1. 테스트 keyword 생성
  const keyword = await createKeyword({
    keyword: `테스트 키워드 ${Date.now()}`,
    category: "test",
    source: "testCrud script",
  });
  console.log("✅ keyword 생성:", keyword.id, keyword.status);

  // 2. 생성된 keyword 조회
  const fetchedKeyword = await getKeywordById(keyword.id);
  if (!fetchedKeyword) {
    throw new Error("생성된 keyword를 조회하지 못했습니다.");
  }
  console.log("✅ keyword 조회:", fetchedKeyword.id, fetchedKeyword.status);

  // 3. status 변경 discovered -> selected
  const updatedKeyword = await updateKeywordStatus(keyword.id, "selected");
  console.log("✅ keyword status 변경:", updatedKeyword.status);

  // 4. source 1건 생성
  const source = await createSource({
    keyword_id: keyword.id,
    title: "테스트 소스",
    url: "https://example.com/test-source",
    source_name: "testCrud script",
    content: "테스트용 소스 본문입니다.",
  });
  console.log("✅ source 생성:", source.id);

  // 5. article 1건 생성
  const article = await createArticle({
    keyword_id: keyword.id,
    title: "테스트 아티클",
    content: "테스트용 아티클 본문입니다.",
    ai_model: "testCrud script",
  });
  console.log("✅ article 생성:", article.id, article.status);

  // 6. publication 1건 생성
  const publication = await createPublication({
    article_id: article.id,
    platform: "test-platform",
  });
  console.log("✅ publication 생성:", publication.id, publication.status);

  // 7. 최종 결과 출력
  console.log("\n▶ 테스트 데이터 요약");
  console.log({
    keyword: { id: keyword.id, status: updatedKeyword.status },
    source: { id: source.id },
    article: { id: article.id, status: article.status },
    publication: { id: publication.id, status: publication.status },
  });

  console.log("\n✅ Supabase CRUD 테스트 완료");
}

if (process.env.ALLOW_SUPABASE_WRITE_TEST !== "1") {
  console.error(
    "❌ 이 스크립트는 실제 Supabase 프로젝트에 쓰기를 수행합니다. " +
      "ALLOW_SUPABASE_WRITE_TEST=1인 경우에만 실행됩니다."
  );
  process.exit(1);
}

main().catch((error) => {
  console.error("❌ CRUD 테스트 실패:", error.message ?? error);
  process.exit(1);
});
