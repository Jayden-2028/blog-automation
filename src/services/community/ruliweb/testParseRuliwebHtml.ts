// 루리웹 베스트 파서 테스트. 외부 호출 없이 fixture만 사용한다(testParseTheqooHtml.ts와 같은 원칙).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { parseRuliwebBestHtml, extractRuliwebTitle } from "./parseRuliwebHtml.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

function ok(message: string): void {
  console.log(`  ✅ ${message}`);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, "fixtures", "ruliwebBest.sample.html");

function testParser(): void {
  console.log("▶ 루리웹 베스트 파서 테스트");

  const html = readFileSync(FIXTURE_PATH, "utf-8");
  const posts = parseRuliwebBestHtml(html);
  const titles = posts.map((post) => post.title);

  // fixture 8행 = 상위 2 + 핫딜 1 + 일반 4(그중 1건은 중복) + 제목 없는 행 1.
  assert(posts.length === 5, `광고/중복/빈 행을 뺀 5건이어야 한다 (실제: ${posts.length}건)`);
  ok("핫딜 광고·중복 제목·제목 없는 행 제외");

  assert(
    !titles.some((title) => title.startsWith("핫딜")),
    "핫딜(제휴 광고) 행은 제목으로 들어오면 안 된다"
  );
  assert(
    !titles.some((title) => /\(\d[\d,]*\)$/.test(title)),
    "끝의 댓글 수는 제거돼야 한다"
  );
  ok("광고 제외 + 댓글 수 제거");

  assert(
    posts[0].title === "예시 제목 하나 - 요즘 중고차 값이 이상하다는 글",
    `상위 행의 순위 숫자가 제거돼야 한다 (실제: ${posts[0].title})`
  );
  ok("상위 행(best_top_row)의 앞 순위 숫자 제거");

  // 이 파서에서 가장 깨지기 쉬운 지점: 순위 제거를 모든 행에 적용하면 이 제목이 "예시 대회 일정
  // 정리"로 잘린다. 순위가 실제로 붙는 행에서만 떼기 때문에 살아남아야 한다.
  assert(
    titles.includes("2026 예시 대회 일정 정리"),
    "숫자로 시작하는 일반 행 제목의 앞 숫자는 제목의 일부이므로 잘리면 안 된다"
  );
  ok("일반 행(mode_list)에서 숫자로 시작하는 제목이 온전히 보존됨");

  assert(
    titles.includes("예시 제목 다섯 - 암살자(들) 감상 후기"),
    "제목 안의 괄호는 댓글 수가 아니므로 남아야 한다"
  );
  ok("제목 안의 괄호 보존");

  assert(
    posts.every((post, index) => post.siteRank === index + 1),
    "siteRank는 제외된 행을 건너뛴 뒤 1부터 연속이어야 한다"
  );
  ok("siteRank 1부터 연속");

  console.log("✅ 루리웹 베스트 파서 테스트 통과\n");
}

function testTitleExtraction(): void {
  console.log("▶ 제목 정규화 단위 테스트");

  assert(extractRuliwebTitle("1 제목 (160)", true) === "제목", "상위 행: 순위+댓글수 제거");
  assert(extractRuliwebTitle("10 제목 (1,024)", true) === "제목", "쉼표가 들어간 댓글 수도 제거");
  assert(extractRuliwebTitle("2026 제목", false) === "2026 제목", "일반 행: 앞 숫자 유지");
  assert(extractRuliwebTitle("  제목\n  (3) ", false) === "제목", "개행/공백 정규화");
  assert(extractRuliwebTitle("핫딜 뭔가 판매 (7)", false) === null, "핫딜은 null");
  assert(extractRuliwebTitle("   ", false) === null, "공백뿐이면 null");
  assert(extractRuliwebTitle("1 (160)", true) === null, "순위·댓글수를 빼고 남는 게 없으면 null");
  ok("순위/댓글수/광고/공백 처리 정확");

  console.log("✅ 제목 정규화 단위 테스트 통과\n");
}

function testNeverThrowsOnBrokenInput(): void {
  console.log("▶ 깨진 입력 방어 테스트");

  assert(parseRuliwebBestHtml("").length === 0, "빈 문자열은 0건이어야 한다");
  assert(
    parseRuliwebBestHtml("<html><body>이건 그냥 텍스트</body></html>").length === 0,
    "목록이 없는 HTML은 0건이어야 한다"
  );
  assert(parseRuliwebBestHtml("<<<not even html").length === 0, "깨진 마크업도 예외 없이 0건이어야 한다");
  assert(
    parseRuliwebBestHtml('<a class="subject_link"></a>').length === 0,
    "tr 밖에 있는 빈 anchor도 예외 없이 0건이어야 한다"
  );
  ok("빈 입력/깨진 마크업/목록 없음/tr 없는 anchor 전부 예외 없이 0건");

  console.log("✅ 깨진 입력 방어 테스트 통과\n");
}

function main(): void {
  console.log("▶ 루리웹 파서 테스트 시작\n");
  testParser();
  testTitleExtraction();
  testNeverThrowsOnBrokenInput();
  console.log("✅ 전체 통과");
}

main();
