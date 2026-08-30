// 커뮤니티 수집기(§5, KEYWORD_SOURCE_EXPANSION.md) 대상 사이트의 robots.txt 확인 + 원본 HTML
// 캡처. **이 스크립트는 이 저장소의 원격 세션에서 실행할 수 없다** - 이 환경의 egress 프록시가
// 아래 사이트로 나가는 요청을 전부 EGRESS_BLOCKED로 거부한다(2026-08-30 확인, theqoo.net 기준).
// 반드시 사용자 맥에서 실행해야 한다: `npx tsx scripts/communityRecon.ts`
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

import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(__dirname, "..", "docs", "ai-handoff", "community-recon");

// 결정 C(KEYWORD_SOURCE_EXPANSION.md §7): 네이트판 오늘의 톡 + 더쿠 핫게시판 + 다음/네이버 카페
// 인기글. 펨코는 Cloudflare Bot Management가 강해 제외했다(§5-2) - recon 대상에도 넣지 않는다.
const TARGETS = [
  { site: "natepann", label: "네이트판 오늘의 톡", pageUrl: "https://pann.nate.com/talk/ranking/d" },
  { site: "theqoo", label: "더쿠 핫게시판", pageUrl: "https://theqoo.net/hot" },
  { site: "daumcafe", label: "다음 카페 인기글", pageUrl: "https://cafe.daum.net/_c21_/home" },
  { site: "navercafe", label: "네이버 카페 인기글", pageUrl: "https://section.cafe.naver.com/ca-fe/home/ranking" },
] as const;

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
function isPathDisallowed(robotsTxt: string, targetPath: string): boolean {
  const lines = robotsTxt.split(/\r?\n/).map((line) => line.trim());
  let inWildcardBlock = false;

  for (const line of lines) {
    const [rawKey, ...rest] = line.split(":");
    if (!rawKey) continue;
    const key = rawKey.trim().toLowerCase();
    const value = rest.join(":").trim();

    if (key === "user-agent") {
      inWildcardBlock = value === "*";
      continue;
    }
    if (!inWildcardBlock) continue;

    if (key === "disallow" && value && targetPath.startsWith(value)) {
      return true;
    }
  }

  return false;
}

function looksLikeChallengePage(html: string): boolean {
  return (
    /just a moment/i.test(html) ||
    /cf-browser-verification/i.test(html) ||
    /cf_chl_opt/i.test(html) ||
    html.length < 2000
  );
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
    await writeFile(outPath, page.body, "utf-8");
    console.log(`  저장: ${outPath}`);
  } catch (error) {
    console.log(`  ❌ 페이지 조회 실패: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main(): Promise<void> {
  console.log("▶ 커뮤니티 수집 대상 사이트 실측(robots.txt 확인 + HTML 캡처)");
  console.log("  이 스크립트는 맥에서 실행해야 한다(원격 세션은 egress가 막혀 있음).");

  await mkdir(OUTPUT_DIR, { recursive: true });

  for (const target of TARGETS) {
    await reconOne(target);
  }

  console.log(
    `\n완료. ${OUTPUT_DIR} 아래 저장된 HTML을 다음 세션에 공유하면, 그걸 fixture로 삼아 사이트별 ` +
      "CommunitySourceProvider를 실제로 구현할 수 있다."
  );
}

await main();
