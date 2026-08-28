// recordArticleImage 테스트. copyright_status 검증은 DB 접근 전에 일어나므로(recordArticleImage.ts
// 참고) 이 경로만 네트워크 없이 검증한다. 실제 insert 경로(images.id가 identity인지 포함)는
// Supabase 접근이 필요해 job:image CLI로 라이브 검증한다(SPRINT_3_DESIGN.md 14절 6번).

import { recordArticleImage } from "./recordArticleImage.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

async function main(): Promise<void> {
  console.log("▶ recordArticleImage 테스트 시작(copyright 검증만, DB 접근 없음)\n");

  // 1) 형식에 안 맞는 copyright_status는 DB를 건드리기 전에 거부돼야 한다.
  const invalid = await recordArticleImage({
    jobId: "753d9af8-9d2d-4179-bf3f-139fa62ba813",
    imageUrl: "https://example.com/a.png",
    copyrightStatus: "found-on-google",
  });
  assert(invalid.status === "invalid_copyright", `형식이 안 맞으면 invalid_copyright여야 한다 (실제: ${invalid.status})`);
  if (invalid.status === "invalid_copyright") {
    assert(invalid.reason.includes("ai-generated"), "허용 형식 안내가 사유에 포함돼야 한다");
  }
  console.log("✅ 잘못된 copyright_status -> invalid_copyright(DB 접근 전 차단)");

  // 2) 빈 문자열도 마찬가지로 거부된다.
  const empty = await recordArticleImage({
    jobId: "753d9af8-9d2d-4179-bf3f-139fa62ba813",
    imageUrl: "https://example.com/a.png",
    copyrightStatus: "",
  });
  assert(empty.status === "invalid_copyright", "빈 문자열도 invalid_copyright여야 한다");
  console.log("✅ 빈 copyright_status -> invalid_copyright");

  console.log("\n✅ recordArticleImage 테스트 완료(DB 접근 경로는 job:image로 라이브 검증)");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
