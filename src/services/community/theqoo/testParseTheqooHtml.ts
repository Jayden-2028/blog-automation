// 더쿠 핫게시판 파서 테스트. 외부 호출 없이 fixture만 사용한다(testGoogleTrends.ts와 같은 원칙).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { parseTheqooHotHtml } from "./parseTheqooHtml.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

function ok(message: string): void {
  console.log(`  ✅ ${message}`);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, "fixtures", "theqooHot.sample.html");

function testParser(): void {
  console.log("▶ 더쿠 핫게시판 파서 테스트");

  const html = readFileSync(FIXTURE_PATH, "utf-8");
  const posts = parseTheqooHotHtml(html);

  assert(posts.length === 3, `공지 2건 + 빈 row 1건을 제외한 3건이어야 한다 (실제: ${posts.length}건)`);
  ok("공지(tr.notice)와 빈 row는 제외되고 일반 인기글 3건만 남음");

  assert(
    posts.every((post) => !/^\d+$/.test(post.title)),
    "추천수(숫자만) anchor가 제목으로 잘못 뽑히면 안 된다"
  );
  ok("숫자만 있는 추천수 anchor는 제목으로 뽑히지 않음");

  assert(posts[0].title === "예시 제목 하나 - 여행 다녀온 후기 공유", "첫 항목 제목이 정확해야 한다");
  assert(posts[0].siteRank === 1, "siteRank는 공지를 건너뛴 뒤 1부터 다시 매겨야 한다");
  assert(posts[1].siteRank === 2 && posts[2].siteRank === 3, "siteRank는 등장 순서대로 연속이어야 한다");
  ok("제목/siteRank 매핑 정확");

  console.log("✅ 더쿠 핫게시판 파서 테스트 통과\n");
}

function testNeverThrowsOnBrokenInput(): void {
  console.log("▶ 깨진 입력 방어 테스트");

  assert(parseTheqooHotHtml("").length === 0, "빈 문자열은 0건이어야 한다");
  assert(parseTheqooHotHtml("<html><body>이건 그냥 텍스트</body></html>").length === 0, "목록이 없는 HTML은 0건이어야 한다");
  assert(parseTheqooHotHtml("<<<not even html").length === 0, "깨진 마크업도 예외 없이 0건이어야 한다");
  assert(
    parseTheqooHotHtml('<table><tr><td class="title"></td></tr></table>').length === 0,
    "제목 anchor가 아예 없는 row는 0건이어야 한다"
  );
  ok("빈 입력/깨진 마크업/목록 없음 전부 예외 없이 0건");

  console.log("✅ 깨진 입력 방어 테스트 통과\n");
}

function main(): void {
  console.log("▶ 더쿠 파서 테스트 시작\n");
  testParser();
  testNeverThrowsOnBrokenInput();
  console.log("✅ 전체 통과");
}

main();
