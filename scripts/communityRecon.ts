// 커뮤니티 수집기(§5, KEYWORD_SOURCE_EXPANSION.md) 대상 사이트의 robots.txt 확인 + 원본 HTML
// 캡처. **이 스크립트는 이 저장소의 원격 세션에서 실행할 수 없다** - 이 환경의 egress 프록시가
// 아래 사이트로 나가는 요청을 전부 EGRESS_BLOCKED로 거부한다(2026-08-30 확인, theqoo.net 기준).
// 반드시 사용자 맥에서 실행해야 한다:
//   npx tsx scripts/communityRecon.ts                # 전체
//   npx tsx scripts/communityRecon.ts fmkorea        # 한 사이트만(재확인용)
// 같은 사이트를 다시 찍으면 직전 캡처가 <site>.prev.html로 남는다 - 클래스명이 날마다 바뀌는지
// diff로 바로 볼 수 있다.
//
// 이 스크립트가 하는 일과 하지 않는 일:
// - 목록 페이지 1개만 가져온다(§5-3 "하루 1회만, 목록 페이지 1~2개만"과 같은 절제 원칙).
// - robots.txt를 먼저 확인하고, User-agent: * 기준으로 대상 경로가 금지돼 있으면 그 사이트는
//   건너뛰고 이유를 출력한다(§5-3 "robots.txt를 먼저 확인하고, 금지면 그 소스는 제외한다").
// - User-Agent를 위장하지 않는다(§5-3). 이 스크립트의 실제 UA를 그대로 쓴다.
// - 받은 HTML을 이 저장소의 docs/ai-handoff/community-recon/<site>.html로 저장한다.
//   그 뒤 다음 세션이 이 파일들을 fixture 삼아 진짜 파서(theqooProvider.ts 등)를 쓸 수 있다 -
//   구글 트렌드 RSS가 trendingRss.sample.xml을 먼저 확보한 뒤 파서를 쓴 것과 같은 순서다.
// - Cloudflare 차단으로 추정되는 응답(짧은 챌린지 페이지)은 저장은 하되 경고를 함께 출력한다 -
//   §5-2가 우려한 상황이 실제로 발생했는지 사람이 판단할 근거가 된다.
//
// 이 스크립트는 daily job의 일부가 아니다. 1회성 실측 도구다.

import { writeFile, mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(__dirname, "..", "docs", "ai-handoff", "community-recon");

// 결정 C(KEYWORD_SOURCE_EXPANSION.md §7): 네이트판 오늘의 톡 + 더쿠 핫게시판 + 다음/네이버 카페
// 인기글. 펨코는 Cloudflare Bot Management가 강해 제외했다(§5-2) - recon 대상에도 넣지 않는다.
// 2026-09-30 추가 후보(사용자 요청). robots.txt는 원격 세션에서 먼저 읽어 1차 선별했고,
// 아래 두 곳만 남겼다 - 나머지는 사이트가 명시적으로 막고 있어 대상에서 뺐다:
//   - 클리앙:      anthropic-ai / Claude-Web 차단 + `Disallow: /*?*`
//   - 인스티즈:    anthropic-ai / ClaudeBot 차단
//   - 디시인사이드: ClaudeBot / anthropic-ai / Claude-Web 차단
// 에펨코리아는 40여 개 AI 크롤러를 막으면서도 기본 UA(`*`)에 대해 `/best`, `/best2`를
// 명시적으로 Allow한다 - 사이트가 의도적으로 구분해 열어둔 경로라 대상에 넣는다. 다만
// §5-2가 지적한 Cloudflare Bot Management가 실제로 막는지는 맥에서 확인해야 한다.
// MLB파크는 이 환경에서 robots.txt 조회 자체가 막혀(EGRESS_BLOCKED) 확인하지 못했다 -
// 이 스크립트가 맥에서 robots를 먼저 읽고 금지면 알아서 건너뛴다.
const TARGETS = [
  { site: "natepann", label: "네이트판 오늘의 톡", pageUrl: "https://pann.nate.com/talk/ranking/d" },
  { site: "theqoo", label: "더쿠 핫게시판", pageUrl: "https://theqoo.net/hot" },
  { site: "daumcafe", label: "다음 카페 인기글", pageUrl: "https://cafe.daum.net/_c21_/home" },
  { site: "navercafe", label: "네이버 카페 인기글", pageUrl: "https://section.cafe.naver.com/ca-fe/home/ranking" },
  { site: "fmkorea", label: "에펨코리아 베스트", pageUrl: "https://www.fmkorea.com/best" },
  { site: "ruliweb", label: "루리웹 베스트", pageUrl: "https://bbs.ruliweb.com/best" },
  { site: "mlbpark", label: "MLB파크 불펜", pageUrl: "https://mlbpark.donga.com/mp/best.php" },
] as const;

import { isPathDisallowed } from "./robotsMatcher.js";

const REQUEST_TIMEOUT_MS = 15_000;

async function fetchText(url: string): Promise<{ status: number; body: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return { status: response.status, body: await response.text() };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * robots.txt를 최소한으로 해석한다: User-agent: * 블록 안의 Disallow 규칙 중 targetPath가
 * 그 prefix로 시작하면 금지로 본다. 완전한 robots.txt 파서가 아니라 "이 경로를 긁어도 되는가"
 * 하나만 보수적으로 답한다 - 애매하면(파싱 실패 등) 금지 쪽으로 fail-safe하지 않고, 사람이 원본
 * robots.txt를 직접 보고 판단하도록 원문도 함께 출력한다.
 */

function looksLikeChallengePage(html: string): boolean {
  return (
    /just a moment/i.test(html) ||
    /cf-browser-verification/i.test(html) ||
    /cf_chl_opt/i.test(html) ||
    html.length < 2000
  );
}

/**
 * 직전 캡처를 <site>.prev.html로 옮긴다. 같은 사이트를 다시 찍을 때 "클래스명이 날마다 바뀌는가"
 * (에펨코리아의 `a.hotdeal_var8` 같은 난독화 의심)를 diff로 바로 확인하기 위해서다 - 덮어써
 * 버리면 비교 대상이 사라진다. 직전 캡처가 없으면 조용히 넘어간다.
 */
async function keepPreviousCapture(outPath: string): Promise<void> {
  try {
    await rename(outPath, outPath.replace(/\.html$/, ".prev.html"));
  } catch {
    // 첫 실행이라 파일이 없는 경우가 대부분이다. recon 자체를 막을 이유는 없다.
  }
}

async function reconOne(target: (typeof TARGETS)[number]): Promise<void> {
  console.log(`\n▶ ${target.label} (${target.site})`);

  const pageUrl = new URL(target.pageUrl);
  const robotsUrl = `${pageUrl.origin}/robots.txt`;

  let robotsTxt = "";
  try {
    const robots = await fetchText(robotsUrl);
    robotsTxt = robots.body;
    console.log(`  robots.txt: HTTP ${robots.status}, ${robots.body.length}자`);
  } catch (error) {
    console.log(`  robots.txt 조회 실패(계속 진행, 원인: ${error instanceof Error ? error.message : String(error)})`);
  }

  if (robotsTxt && isPathDisallowed(robotsTxt, pageUrl.pathname)) {
    console.log(`  ⛔ robots.txt가 ${pageUrl.pathname}을 금지함 - 이 사이트는 제외한다(§5-3).`);
    return;
  }

  try {
    const page = await fetchText(target.pageUrl);
    console.log(`  페이지: HTTP ${page.status}, ${page.body.length}자`);

    if (looksLikeChallengePage(page.body)) {
      console.log("  ⚠️ Cloudflare 챌린지 또는 비정상적으로 짧은 응답으로 보인다. 저장은 하되 내용을 직접 확인할 것.");
    }

    const outPath = join(OUTPUT_DIR, `${target.site}.html`);
    await keepPreviousCapture(outPath);
    await writeFile(outPath, page.body, "utf-8");
    console.log(`  저장: ${outPath} (직전 캡처가 있었으면 ${target.site}.prev.html로 남겨 둠)`);
  } catch (error) {
    console.log(`  ❌ 페이지 조회 실패: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main(): Promise<void> {
  console.log("▶ 커뮤니티 수집 대상 사이트 실측(robots.txt 확인 + HTML 캡처)");
  console.log("  이 스크립트는 맥에서 실행해야 한다(원격 세션은 egress가 막혀 있음).");

  // 사이트 이름을 인자로 주면 그 사이트만 찍는다. 한 사이트를 다시 확인할 때(구조가 바뀌었나,
  // 클래스명이 도는가) 나머지 6곳까지 긁을 이유가 없다 - §5-3의 절제 원칙이 그대로 적용된다.
  const requested = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
  const targets =
    requested.length > 0 ? TARGETS.filter((target) => requested.includes(target.site)) : TARGETS;

  if (targets.length === 0) {
    console.log(
      `\n대상 없음. 쓸 수 있는 이름: ${TARGETS.map((t) => t.site).join(", ")}\n` +
        "예: npx tsx scripts/communityRecon.ts fmkorea"
    );
    process.exitCode = 1;
    return;
  }
  if (requested.length > 0) console.log(`  대상 한정: ${targets.map((t) => t.site).join(", ")}`);

  await mkdir(OUTPUT_DIR, { recursive: true });

  for (const target of targets) {
    await reconOne(target);
  }

  console.log(
    `\n완료. ${OUTPUT_DIR} 아래 저장된 HTML을 다음 세션에 공유하면, 그걸 fixture로 삼아 사이트별 ` +
      "CommunitySourceProvider를 실제로 구현할 수 있다."
  );
}

await main();
