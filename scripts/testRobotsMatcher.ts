// communityRecon.ts의 robots.txt 판정 테스트.
//
// 왜 필요한가(2026-09-30 실측): 이 판정이 Disallow만 보고 Allow를 무시해서 에펨코리아를 잘못
// 제외했다. 그 사이트는 `Disallow: /`와 `Allow: /best`를 함께 두어 베스트 목록만 열어뒀는데
// `Disallow: /`에 걸려버렸다. 판정이 틀리면 두 방향으로 손해다 - 허용된 소스를 놓치거나(이번
// 경우), 반대로 금지된 곳을 긁는다(훨씬 위험).
//
// 아래 fixture는 전부 실제로 조회한 robots.txt에서 가져왔다. 외부 호출 없이 판정만 검증한다.
// 실행: npx tsx scripts/testRobotsMatcher.ts

import { isPathDisallowed } from "./robotsMatcher.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

// 에펨코리아(2026-09-30 실측 요약): AI 크롤러 40여 개를 막고, 기본 UA에는 세 경로만 연다.
const FMKOREA = `
User-agent: ClaudeBot
Disallow: /

User-agent: GPTBot
Disallow: /

User-agent: *
Disallow: /
Allow: /
Allow: /best
Allow: /best2
Disallow: /*listStyle=
Disallow: /*search_keyword=
`;

// 네이버 엔터(2026-09-30 실측, 원문 그대로): 루트와 /home만 정확히 일치할 때 허용.
const NAVER_ENTERTAIN = `
User-agent: *
Disallow: /
Disallow: /*/article
Disallow: /article
Allow: /$
Allow: /home$
`;

// 네이트판(실측): 목록 경로를 직접 금지.
const NATEPANN = `
User-agent: *
Disallow: /talk/ranking
Disallow: /mypann
`;

// 빈 Disallow는 "금지 없음"이다.
const EMPTY_DISALLOW = `
User-agent: *
Disallow:
`;

function main(): void {
  console.log("▶ robots.txt 판정 테스트");

  // ---------- 1. Allow가 Disallow를 덮는다(이번 버그) ----------
  console.log("\n[1] Allow 우선순위 - 에펨코리아");
  assert(
    !isPathDisallowed(FMKOREA, "/best"),
    "`Allow: /best`(6자)가 `Disallow: /`(1자)를 이겨야 한다 - 이게 이번에 틀렸던 판정이다"
  );
  assert(!isPathDisallowed(FMKOREA, "/best2"), "/best2도 허용이어야 한다");
  assert(
    isPathDisallowed(FMKOREA, "/best?listStyle=webzine"),
    "더 구체적인 `Disallow: /*listStyle=`이 `Allow: /best`를 이겨야 한다"
  );
  console.log("   /best 허용 · /best?listStyle= 금지");

  // ---------- 2. $ 앵커 ----------
  console.log("\n[2] $ 앵커 - 네이버 엔터");
  assert(!isPathDisallowed(NAVER_ENTERTAIN, "/"), "`Allow: /$`로 루트만 허용");
  assert(!isPathDisallowed(NAVER_ENTERTAIN, "/home"), "`Allow: /home$`로 /home 허용");
  assert(
    isPathDisallowed(NAVER_ENTERTAIN, "/ranking"),
    "/ranking은 `Disallow: /`에만 걸리므로 금지여야 한다"
  );
  assert(
    isPathDisallowed(NAVER_ENTERTAIN, "/home/sub"),
    "`Allow: /home$`는 정확히 /home만 - 하위 경로까지 열면 안 된다"
  );
  console.log("   / 와 /home만 허용 · /ranking, /home/sub 금지");

  // ---------- 3. 단순 금지 ----------
  console.log("\n[3] 단순 금지 - 네이트판");
  assert(isPathDisallowed(NATEPANN, "/talk/ranking/d"), "prefix 매칭으로 금지");
  assert(!isPathDisallowed(NATEPANN, "/talk/today"), "금지 목록에 없으면 허용");

  // ---------- 4. 경계 ----------
  console.log("\n[4] 경계 조건");
  assert(!isPathDisallowed(EMPTY_DISALLOW, "/any"), "빈 Disallow는 금지 없음");
  assert(!isPathDisallowed("", "/any"), "robots.txt가 비면(404 등) 금지 없음");
  assert(
    !isPathDisallowed("User-agent: ClaudeBot\nDisallow: /", "/any"),
    "다른 user-agent 블록의 규칙은 적용하지 않는다"
  );
  assert(
    !isPathDisallowed("# Disallow: /\nUser-agent: *\nAllow: /", "/any"),
    "주석은 규칙이 아니다"
  );
  console.log("   빈 규칙 / 빈 파일 / 다른 UA / 주석 처리 확인");

  console.log("\n✅ 전체 통과");
}

main();
