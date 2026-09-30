// 에펨코리아 베스트 파서 테스트. 외부 호출 없이 fixture만 사용한다.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { parseFmkoreaBestHtml } from "./parseFmkoreaHtml.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

function ok(message: string): void {
  console.log(`  ✅ ${message}`);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, "fixtures", "fmkoreaBest.sample.html");

function testParser(): void {
  console.log("▶ 에펨코리아 베스트 파서 테스트");

  const html = readFileSync(FIXTURE_PATH, "utf-8");
  const posts = parseFmkoreaBestHtml(html);
  const titles = posts.map((post) => post.title);

  // fixture 7행 = 일반 3 + 광고 1 + 정치 1 + 중복 1 + 제목 없음 1.
  assert(posts.length === 3, `광고·정치·중복·빈 행을 뺀 3건이어야 한다 (실제: ${posts.length}건)`);
  ok("광고(hotdeal1)·정치글(politics1)·중복 제목·제목 없는 행 제외");

  assert(
    !titles.some((title) => title.includes("예시몰")),
    "li_best2_hotdeal1 행(제휴 딜)은 제외돼야 한다"
  );
  assert(
    !titles.some((title) => title.includes("정치글")),
    "li_best2_politics1 행은 제외돼야 한다 - 이 프로젝트는 정치 키워드를 수집하지 않는다"
  );
  ok("사이트가 붙인 의미 플래그로 광고·정치글을 수집 단계에서 차단");

  assert(
    titles[0] === "예시 제목 하나 - 어제 경기 마지막 장면 이야기",
    `제목에 추천수·댓글수가 섞이면 안 된다 (실제: ${titles[0]})`
  );
  assert(
    !titles.some((title) => /\[\d+\]$/.test(title)),
    "댓글 수 [350]이 제목 끝에 남으면 안 된다"
  );
  ok("제목만 정확히 추출(추천수·댓글수·작성자 제외)");

  // 제목 자체의 대괄호는 댓글 수가 아니므로 남아야 한다.
  assert(
    titles.includes("예시 제목 넷 - 암살자(들) 감상 후기 [스포]"),
    "제목 안의 괄호·대괄호는 보존돼야 한다"
  );
  ok("제목 안의 괄호·대괄호 보존");

  // 난독화 의심 클래스(hotdeal_var8)에 의존하지 않는다는 것의 실질 검증:
  // 이 행의 anchor class는 전혀 다른 값인데도 파싱돼야 한다.
  assert(
    titles.includes("예시 제목 다섯 - ellipsis span이 없는 행"),
    "anchor class가 달라도, ellipsis span이 없어도 폴백 경로로 제목을 얻어야 한다"
  );
  ok("anchor class에 의존하지 않음 + ellipsis span 없을 때 폴백 동작");

  assert(
    posts.every((post, index) => post.siteRank === index + 1),
    "siteRank는 제외된 행을 건너뛴 뒤 1부터 연속이어야 한다"
  );
  ok("siteRank 1부터 연속");

  console.log("✅ 에펨코리아 베스트 파서 테스트 통과\n");
}

function testNeverThrowsOnBrokenInput(): void {
  console.log("▶ 깨진 입력 방어 테스트");

  assert(parseFmkoreaBestHtml("").length === 0, "빈 문자열은 0건이어야 한다");
  assert(
    parseFmkoreaBestHtml("<html><body>이건 그냥 텍스트</body></html>").length === 0,
    "목록이 없는 HTML은 0건이어야 한다"
  );
  assert(parseFmkoreaBestHtml("<<<not even html").length === 0, "깨진 마크업도 예외 없이 0건이어야 한다");
  assert(
    parseFmkoreaBestHtml('<li class="li"><h3 class="title"></h3></li>').length === 0,
    "제목 anchor가 없는 행은 0건이어야 한다"
  );
  // Cloudflare 챌린지 페이지를 받았을 때의 모습에 가깝다 - 조용히 0건이어야 한다.
  assert(
    parseFmkoreaBestHtml("<html><head><title>Just a moment...</title></head><body></body></html>").length === 0,
    "차단 페이지도 예외 없이 0건이어야 한다"
  );
  ok("빈 입력/깨진 마크업/목록 없음/차단 페이지 전부 예외 없이 0건");

  console.log("✅ 깨진 입력 방어 테스트 통과\n");
}

function main(): void {
  console.log("▶ 에펨코리아 파서 테스트 시작\n");
  testParser();
  testNeverThrowsOnBrokenInput();
  console.log("✅ 전체 통과");
}

main();
