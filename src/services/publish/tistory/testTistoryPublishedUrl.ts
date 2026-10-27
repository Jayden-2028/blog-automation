// 발행 글 실제 주소 찾기 테스트(2026-10-07 RSS 매칭, 2026-10-27 이중 이스케이프·슬러그 다듬기·검색). 실행: npm run test:tistory-url
// 네트워크를 쓰지 않는다 - fetch·HEAD는 가짜로 넣는다.
import { readFileSync } from "node:fs";

import { matchRssLink, sanitizeTistorySlug } from "./TistoryPublisher.js";
import {
  decodeEntities,
  extractCanonicalUrl,
  isTistoryPostUrl,
  matchSearchLink,
  resolveUrlFromRss,
  resolveUrlFromSlug,
  searchQueryFor,
  slugFromEntryUrl,
  tistoryEntryUrl,
  type FetchLike,
} from "./tistoryPublishedUrl.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const BLOG = "wooahpapa";

const RSS = `<rss><channel>
<item><title>어린이집聯 보육예산 정상화, 27억 빠진 추경에 2,000명 모였다</title><link>https://wooahpapa.tistory.com/entry/real-1</link></item>
<item><title>국방부 예술체육요원 병역특례 감축&middot;폐지 추진, 국방개혁 기본계획에 반영</title><link>https://wooahpapa.tistory.com/entry/real-2</link></item>
<item><title><![CDATA[노웨딩 예식장 줄폐업, 결혼식 대신 '빚 없는 시작' 고른 청년들]]></title><link>https://wooahpapa.tistory.com/entry/real-3</link></item>
<item><title>대법원 김건희 추가 구속영장 발부 인멸&amp;middot;도망 우려, 매관매직 사건</title><link>https://wooahpapa.tistory.com/entry/real-4</link></item>
</channel></rss>`;

// 1) RSS 제목 매칭
{
  // 聯은 한글·영숫자 밖이라 정규화에서 빠진다 - 그래도 나머지 글자로 유일하게 매칭돼야 한다.
  const r1 = matchRssLink(RSS, "어린이집聯 보육예산 정상화, 27억 빠진 추경에 2000명 모였다");
  assert(r1 === "https://wooahpapa.tistory.com/entry/real-1", `쉼표·한자 차이를 무시하고 매칭 (${r1})`);
  const r2 = matchRssLink(RSS, "국방부 예술체육요원 병역특례 감축·폐지 추진, 국방개혁 기본계획에 반영");
  assert(r2 === "https://wooahpapa.tistory.com/entry/real-2", `&middot; 엔티티 매칭 (${r2})`);
  const r3 = matchRssLink(RSS, "노웨딩 예식장 줄폐업, 결혼식 대신 '빚 없는 시작' 고른 청년들");
  assert(r3 === "https://wooahpapa.tistory.com/entry/real-3", `CDATA 매칭 (${r3})`);
  // 2026-10-27 실측: 티스토리 RSS는 ·을 &amp;middot;로 두 번 이스케이프한다. 옛 decodeEntities는 &middot;를 먼저 풀어 영원히 실패했다.
  const r4 = matchRssLink(RSS, "대법원 김건희 추가 구속영장 발부 인멸·도망 우려, 매관매직 사건");
  assert(r4 === "https://wooahpapa.tistory.com/entry/real-4", `이중 이스케이프 &amp;middot; 매칭 (${r4})`);
  assert(matchRssLink(RSS, "없는 글 제목") === null, "없으면 null");
  console.log("✅ matchRssLink - 엔티티·CDATA·이중 이스케이프·특수문자 차이 흡수");
}

// 2) 엔티티 풀기
{
  assert(decodeEntities("인멸&amp;middot;도망") === "인멸·도망", "&amp;middot; -> ·");
  assert(decodeEntities("A&amp;amp;B") === "A&B", "&amp;amp; 두 번 중첩");
  assert(decodeEntities("&lsquo;빚&rsquo; &ldquo;끝&rdquo;&hellip;&nbsp;&apos;x&apos; &quot;y&quot; &lt;b&gt;") === "‘빚’ “끝”… 'x' \"y\" <b>", "이름 엔티티");
  assert(decodeEntities("&#183;&#xB7;&#x00b7;") === "···", "10진·16진 숫자 참조");
  assert(decodeEntities("&unknown;") === "&unknown;", "모르는 엔티티는 그대로");
  console.log("✅ decodeEntities - &amp; 먼저, 이름·숫자 참조");
}

// 3) 슬러그 다듬기 - 실측 18쌍(logs/tistory-url-audit.json, 저장 주소 -> 실제 주소). id 245는 퍼센트 제거(30% -> 30).
{
  const pairs = JSON.parse(
    readFileSync(new URL("./fixtures/tistoryUrlAudit-2026-10-27.json", import.meta.url), "utf-8")
  ) as { id: number; stored: string; fix: string }[];
  assert(pairs.length === 18, `픽스처 18쌍 (${pairs.length})`);
  for (const pair of pairs) {
    const storedSlug = slugFromEntryUrl(pair.stored);
    assert(storedSlug, `저장 주소에서 슬러그 추출 (id ${pair.id})`);
    const fixed = tistoryEntryUrl(BLOG, sanitizeTistorySlug(storedSlug));
    assert(fixed === pair.fix, `id ${pair.id} 슬러그 다듬기\n   got  ${decodeURIComponent(fixed)}\n   want ${decodeURIComponent(pair.fix)}`);
  }
  // 제목(공백 구분)으로도 같은 규칙. 가운뎃점·한자 유지, 연속 하이픈 정리.
  assert(sanitizeTistorySlug("나고야 밥이 별로라고? 그럼 (우리가): 준비하지!") === "나고야-밥이-별로라고-그럼-우리가-준비하지", "제목 입력");
  assert(sanitizeTistorySlug("감금·갈취, 3명 “구속” - 聯") === "감금·갈취-3명-구속-聯", "·/한자 유지, 둥근 따옴표 제거, 하이픈 정리");
  console.log(`✅ sanitizeTistorySlug - 실측 ${pairs.length}쌍 일치`);
}

// 4) 저장 주소 슬러그 추출 - 인코딩 안 된 %·? 가 섞인 옛 주소
{
  assert(slugFromEntryUrl("https://x.tistory.com/entry/%ED%95%99%EC%83%9D-30%") === "학생-30%", "끝의 날 % 보존");
  assert(slugFromEntryUrl("https://x.tistory.com/entry/a-b?-c") === "a-b?-c", "인코딩 안 된 ? 보존");
  assert(slugFromEntryUrl("https://x.tistory.com/manage/posts/") === null, "글 주소가 아니면 null");
  console.log("✅ slugFromEntryUrl");
}

// 5) 발행 후 페이지가 글 주소인가 / canonical
{
  assert(isTistoryPostUrl("https://wooahpapa.tistory.com/entry/abc", BLOG), "/entry/ 주소");
  assert(isTistoryPostUrl("https://wooahpapa.tistory.com/120", BLOG), "/<숫자> 주소");
  assert(!isTistoryPostUrl("https://wooahpapa.tistory.com/manage/posts/", BLOG), "관리 화면은 아니다");
  assert(!isTistoryPostUrl("https://other.tistory.com/entry/abc", BLOG), "다른 블로그는 아니다");
  const canonical = extractCanonicalUrl('<head><link rel="canonical" href="https://wooahpapa.tistory.com/entry/토스-행운퀴즈-10월"/></head>');
  assert(canonical === "https://wooahpapa.tistory.com/entry/%ED%86%A0%EC%8A%A4-%ED%96%89%EC%9A%B4%ED%80%B4%EC%A6%88-10%EC%9B%94", `canonical 퍼센트 인코딩 통일 (${canonical})`);
  console.log("✅ isTistoryPostUrl·extractCanonicalUrl");
}

// 6) 블로그 검색 결과 매칭(2026-10-27 실측 스킨 마크업 축약)
{
  const html = `
    <li><a href="/entry/other-post" class="link_thumb"><strong class="txt_title">평택 고덕국제신도시 다른 글</strong></a></li>
    <li><a href="/entry/%ED%8F%89%ED%83%9D-real" class="link_thumb"><div class="cont_thumb">
      <strong class="txt_title">평택 고덕국제신도시 애니 라이트 스쿨 2030년 개교, 평택 학생 30% 배정</strong></div></a></li>
    <a href="/entry/%EB%8C%80-real" data-tiara-name="대법원 김건희 추가 구속영장 발부 인멸&amp;middot;도망 우려, 매관매직 사건">`;
  const s1 = matchSearchLink(html, "평택 고덕국제신도시 애니 라이트 스쿨 2030년 개교, 평택 학생 30% 배정", BLOG);
  assert(s1 === "https://wooahpapa.tistory.com/entry/%ED%8F%89%ED%83%9D-real", `txt_title 매칭 (${s1})`);
  const s2 = matchSearchLink(html, "대법원 김건희 추가 구속영장 발부 인멸·도망 우려, 매관매직 사건", BLOG);
  assert(s2 === "https://wooahpapa.tistory.com/entry/%EB%8C%80-real", `data-tiara-name 매칭 (${s2})`);
  assert(matchSearchLink(html, "평택 고덕국제신도시", BLOG) === null, "부분 제목은 매칭하지 않는다");
  assert(searchQueryFor("출근 대란 예상! 경기도 버스 총파업") === "출근 대란 예상 경기도", `검색어 앞 4단어 (${searchQueryFor("출근 대란 예상! 경기도 버스 총파업")})`);
  console.log("✅ matchSearchLink·searchQueryFor");
}

async function main(): Promise<void> {
  // 7) RSS 재시도 - 지수 백오프, 뒤늦게 반영돼도 찾는다
  {
    const waits: number[] = [];
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return { ok: true, status: 200, text: async () => (calls >= 4 ? RSS : "<rss></rss>") };
    };
    const link = await resolveUrlFromRss(BLOG, "국방부 예술체육요원 병역특례 감축·폐지 추진, 국방개혁 기본계획에 반영", {
      fetchImpl,
      wait: async (ms) => waits.push(ms),
    });
    assert(link === "https://wooahpapa.tistory.com/entry/real-2", `4번째 시도에서 찾음 (${link})`);
    assert(JSON.stringify(waits) === "[2000,4000,8000]", `백오프 2·4·8초 (${JSON.stringify(waits)})`);

    const allWaits: number[] = [];
    const never = await resolveUrlFromRss(BLOG, "없는 글", { fetchImpl: async () => ({ ok: true, status: 200, text: async () => RSS }), wait: async (ms) => allWaits.push(ms) });
    assert(never === null && allWaits.reduce((a, b) => a + b, 0) === 60_000, `못 찾으면 대기 합 60초 후 null (${JSON.stringify(allWaits)})`);
    console.log("✅ resolveUrlFromRss - 지수 백오프(최대 60초)");
  }

  // 8) 슬러그 추정 + HEAD 검증
  {
    const headed: string[] = [];
    const ok = await resolveUrlFromSlug(BLOG, "평택-학생-30%", async (url) => (headed.push(url), 200));
    assert(ok?.verified && ok.url === tistoryEntryUrl(BLOG, "평택-학생-30"), `HEAD 200이면 verified (${JSON.stringify(ok)})`);
    const ng = await resolveUrlFromSlug(BLOG, "없는,-글", async () => 404);
    assert(ng && !ng.verified && ng.url === tistoryEntryUrl(BLOG, "없는-글"), `HEAD 404면 unverified (${JSON.stringify(ng)})`);
    assert((await resolveUrlFromSlug(BLOG, ",?!", async () => 200)) === null, "다듬고 남는 게 없으면 null");
    console.log("✅ resolveUrlFromSlug - HEAD 200만 verified");
  }

  console.log("\n✅ testTistoryPublishedUrl 전체 통과");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
