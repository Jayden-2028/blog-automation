// 인물 백과 소스팩 테스트(B-1, 2026-10-15). 실행: npm run test:person-source-pack
// 전부 주입 기반이다 - 네트워크·DB·대기 없음. HTML 픽스처는 실측 구조(차정원·김지원, 2026-10-15)를 줄여 옮겼다.
import { buildResearchPrompt } from "./buildResearchPrompt.js";
import { collectPersonSourcePacks } from "./collectPersonSourcePack.js";
import type { CollectPersonSourcePackDeps } from "./collectPersonSourcePack.js";
import {
  PERSON_SOURCE_PACK_MAX_BYTES,
  SOURCE_PACK_USER_AGENT,
  capUtf8,
  extractNamuwikiText,
  extractNaverPersonDb,
  fetchPersonSourcePack,
  fitSections,
  readPersonSourcePack,
} from "./personSourcePack.js";
import type { FetchLike, PersonSourcePack } from "./personSourcePack.js";
import { SOURCE_PACK_WAIT_MS, resolvePersonSourcePack, waitForPersonSourcePack } from "./personSourcePackWait.js";
import type { ArticleJobRow } from "../../types/database.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`❌ ${msg}`);
}

const NAVER_HTML = `<!doctype html><html><head><title>차정원 : 네이버 검색</title><script>var x="차정원 펴고 접기 가짜"</script></head><body>
<a>메뉴 영역으로 바로가기</a><div>NAVER 검색 한글 입력기</div>
<div><h2>차정원 펴고 접기</h2><span>Jungwon Cha 영화배우, 탤런트</span>
<button>문서 저장하기</button>
<ul><li>전체</li><li>프로필</li></ul>
<dl><dt>소속사</dt><dd>사람엔터테인먼트</dd><dt>수상</dt><dd>2018년 올해의 브랜드 대상 올해의 뷰티아이콘</dd></dl>
<p>본 인물정보는 일반에 공개된 자료, 당사자 본인이 제공한 자료를 토대로 구성됩니다.</p>
<p>본인참여 수정신청, 정보오류 수정요청</p>
<div>필모그래피 무법 변호사 강연희 조연 2018.05.12.~2018.07.01.</div>
<div>같은 이름 다른 인물 카더가든 가수</div><div>동명이인 노출기준 이 정보가 표시된 이유</div></div>
<div>뉴스 하정우·차정원, 12월 결혼 발표 (뉴스 스니펫 - 이건 baseline이 맡는다)</div></body></html>`;

const NAMU_HTML = `<!doctype html><html><head><title>차정원 - 나무위키</title></head><body>
<div>최근 변경최근 토론</div><div>차정원</div><div>최근 수정 시각: 2026-10-14 09:10:57</div>
<div>편집 요청</div><div>편집 권한이 부족합니다. 로그인된 사용자여야 합니다.</div>
<div>분류</div><ul><li>한국 여배우</li><li>사람엔터테인먼트 소속 아티스트</li></ul>
<table><tr><th>본명</th><td>차미영</td></tr><tr><th>출생</th><td>1989년 10월 18일</td></tr><tr><th>소속사</th><td>사람엔터테인먼트</td></tr></table>
<h2><a href="#toc">1.</a> <span>개요<span><a href="/edit">[편집]</a></span></span></h2><p>대한민국의 배우.<sup>[1]</sup></p>
<h2>2. 출연 작품</h2><h3>2.1. 영화</h3>
<table><tr><th>연도</th><th>제목</th><th>배역</th></tr><tr><td>2012년</td><td>무서운 이야기</td><td>민주</td></tr><tr><td>2025년</td><td>폭락</td><td>경진</td></tr></table>
<h2>3. 기타</h2><h3>3.1. 인터뷰</h3><p>"정말 멋지신 선생님들과 함께 작품을 하게 되어 영광" [23]</p>
<h2>4. 둘러보기</h2><p>둘러보기 틀 - 다른 배우 목록 가나다</p>
<h2>5. 각주</h2><p>각주 본문 1 2 3</p></body></html>`;

// 1) 네이버 인물DB 카드 추출
{
  const card = extractNaverPersonDb(NAVER_HTML, "차정원");
  assert(card.startsWith("차정원 펴고 접기"), `카드는 "<이름> 펴고 접기"로 시작한다 (실제: ${card.slice(0, 30)})`);
  assert(card.includes("사람엔터테인먼트") && card.includes("올해의 뷰티아이콘") && card.includes("무법 변호사 강연희"), "소속사·수상·필모그래피가 들어 있다");
  assert(card.includes("같은 이름 다른 인물 카더가든"), "동명이인 목록(가드 재료)이 들어 있다");
  assert(!card.includes("동명이인 노출기준"), "카드는 동명이인 노출기준 앞에서 끝난다");
  assert(!card.includes("뉴스 스니펫") && !card.includes("메뉴 영역"), "뉴스·사이트 머리글은 싣지 않는다");
  assert(!card.includes("문서 저장하기") && !card.includes("본 인물정보는 일반에 공개된") && !card.includes("본인참여 수정신청"), "UI·면책 고정 문구는 뺀다");
  assert(!card.includes("가짜"), "script 안의 문자열은 쓰지 않는다");
  assert(extractNaverPersonDb(NAVER_HTML, "다른이름") === "", "카드가 없으면(등재 안 된 이름) 빈 문자열");
  console.log("✅ 인물DB 카드: 소속사·수상·필모·동명이인 포함, 뉴스·UI·면책 제외, 카드 없으면 빈 문자열");
}

// 2) 나무위키 본문 추출
{
  const text = extractNamuwikiText(NAMU_HTML);
  assert(text.includes("최근 수정 시각: 2026-10-14"), "문서 수정 시각을 남긴다");
  assert(text.includes("본명 | 차미영") && text.includes("소속사 | 사람엔터테인먼트"), "인포박스(분류 이후)가 한 줄씩 남는다");
  assert(!text.includes("편집 권한이 부족") && !text.includes("최근 변경최근 토론"), "편집 UI 머리글은 버린다");
  assert(text.includes("## 1. 개요") && !text.includes("[편집]"), "절 제목은 ##, [편집]은 제거");
  assert(text.includes("2012년 | 무서운 이야기 | 민주") && text.includes("연도 | 제목 | 배역"), "표는 행 하나가 한 줄");
  assert(!/\[\d+\]/.test(text), "각주 번호 [1]·[23]은 제거");
  assert(text.includes("정말 멋지신 선생님들과 함께") && text.includes("### 3.1. 인터뷰"), "기타·인터뷰 절은 유지");
  assert(!text.includes("둘러보기 틀") && !text.includes("각주 본문"), "둘러보기·각주 절은 제외");
  console.log("✅ 나무위키: 머리글·편집UI·각주번호·둘러보기·각주 절 제거, 인포박스·표 행·기타 유지");
}

// 3) 분량 상한 - 40KB, 문자 경계, 절 단위 안배
{
  const big = "가".repeat(20_000); // 60,000바이트
  const capped = capUtf8(big);
  assert(Buffer.byteLength(capped, "utf8") <= PERSON_SOURCE_PACK_MAX_BYTES && capped.includes("분량 상한"), "capUtf8은 40KB 이하 + 생략 표시");
  assert(!capped.includes("�"), "문자 경계에서 자른다(깨진 글자 없음)");
  assert(capUtf8("짧은 글") === "짧은 글", "상한 안이면 그대로");

  const line = (n: number) => `항목 ${n} 가나다라마바사아자차카타파하`;
  const section = (title: string, lines: number) => [`## ${title}`, ...Array.from({ length: lines }, (_, i) => line(i))].join("\n");
  const fitted = fitSections([section("출연 작품", 3000), section("수상", 40), section("기타", 400)], 8 * 1024);
  assert(Buffer.byteLength(fitted, "utf8") <= 8 * 1024, `fitSections는 상한 이하 (${Buffer.byteLength(fitted, "utf8")})`);
  assert(fitted.includes("## 수상") && fitted.includes("## 기타") && fitted.includes("항목 39 "), "큰 절만 줄고 작은 절(수상)은 그대로, 뒤 절(기타)도 남는다");
  assert(fitted.includes("절 분량 상한으로 이하 생략"), "잘린 절에는 생략 표시");
  const small = [section("개요", 3)];
  assert(fitSections(small, 8 * 1024) === small[0], "상한 안이면 변경 없음");
  const hugeHtml = `<h2>1. 개요</h2>${"<p>가나다라마바사아자차카타</p>".repeat(8000)}<h2>2. 기타</h2><p>마지막 절 여담</p>`;
  const namu = extractNamuwikiText(hugeHtml);
  assert(Buffer.byteLength(namu, "utf8") <= PERSON_SOURCE_PACK_MAX_BYTES && namu.includes("마지막 절 여담"), "거대 문서도 40KB 이하이며 마지막 절이 남는다");
  console.log("✅ 분량 상한: 40KB 이하·문자 경계·절 단위 안배(수상·기타 보존)");
}

// 4) 수집 - 주입 fetch. 실패는 비치명이다.
{
  const calls: Array<{ url: string; ua: string }> = [];
  const ok: FetchLike = async (url, init) => {
    calls.push({ url, ua: init.headers["User-Agent"] ?? "" });
    return { ok: true, status: 200, text: async () => (url.includes("namu.wiki") ? NAMU_HTML : NAVER_HTML) };
  };
  const now = () => new Date("2026-10-15T12:00:00Z");
  const pack = await fetchPersonSourcePack("차정원", { fetchImpl: ok, now });
  assert(pack.errors.length === 0 && pack.personDb.includes("사람엔터테인먼트") && pack.namuwiki.includes("본명 | 차미영"), "둘 다 성공");
  assert(pack.fetchedAt === "2026-10-15T12:00:00.000Z", "fetchedAt 기록");
  assert(calls.length === 2 && calls[0].url === `https://search.naver.com/search.naver?query=${encodeURIComponent("차정원")}` && calls[1].url === `https://namu.wiki/w/${encodeURIComponent("차정원")}`, "URL은 인코딩된 이름");
  assert(calls.every((c) => c.ua === SOURCE_PACK_USER_AGENT && /Chrome\//.test(c.ua)), "크롬 UA를 단다");

  const namuBlocked: FetchLike = async (url) =>
    url.includes("namu.wiki") ? { ok: false, status: 403, text: async () => "" } : { ok: true, status: 200, text: async () => NAVER_HTML };
  const partial = await fetchPersonSourcePack("차정원", { fetchImpl: namuBlocked, now });
  assert(partial.personDb !== "" && partial.namuwiki === "" && partial.errors.length === 1 && partial.errors[0] === "namuwiki: HTTP 403", `나무위키 403은 errors에만 남고 인물DB는 유지 (${JSON.stringify(partial.errors)})`);

  const allThrow: FetchLike = async () => {
    throw new Error("fetch failed");
  };
  const none = await fetchPersonSourcePack("차정원", { fetchImpl: allThrow, now });
  assert(none.personDb === "" && none.namuwiki === "" && none.errors.length === 2 && none.errors.every((e) => e.includes("fetch failed")), "네트워크 예외도 던지지 않는다");

  const noCard: FetchLike = async (url) => ({ ok: true, status: 200, text: async () => (url.includes("namu.wiki") ? NAMU_HTML : "<html><body>검색 결과 없음</body></html>") });
  const cardless = await fetchPersonSourcePack("차정원", { fetchImpl: noCard, now });
  assert(cardless.personDb === "" && cardless.errors.some((e) => e.startsWith("personDb: 인물DB 카드 없음")), "카드 없음은 사유를 남긴다");

  let aborted = false;
  const hang: FetchLike = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        aborted = true;
        reject(new Error("aborted"));
      });
    });
  const timedOut = await fetchPersonSourcePack("차정원", { fetchImpl: hang, now, timeoutMs: 20 });
  assert(aborted && timedOut.errors.length === 2, "타임아웃이면 요청을 끊고 비치명 처리");
  console.log("✅ 수집: 성공/나무위키 403/네트워크 예외/카드 없음/타임아웃 모두 비치명, 크롬 UA·URL 인코딩");
}

// 5) metadata 읽기
{
  assert(readPersonSourcePack(null) === null && readPersonSourcePack({}) === null && readPersonSourcePack({ researchSourcePack: "x" }) === null, "없으면 null");
  assert(readPersonSourcePack({ researchSourcePack: { personDb: "a" } }) === null, "fetchedAt이 없으면 수집 흔적이 아니다");
  const failed = readPersonSourcePack({ researchSourcePack: { personDb: "", namuwiki: "", fetchedAt: "2026-10-15T00:00:00Z", errors: ["namuwiki: HTTP 403", 7] } });
  assert(failed !== null && failed.errors.length === 1, "실패 팩도 '채워진 것'으로 읽는다(러너가 기다리지 않게)");
  console.log("✅ metadata 읽기: 없음/불완전/실패 팩 구분");
}

// 6) 러너 대기 - 가짜 시계
{
  const base: PersonSourcePack = { personDb: "카드", namuwiki: "문서", fetchedAt: "2026-10-15T00:00:00Z", errors: [] };
  const clock = () => {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => void (t += ms), sleeps: () => t };
  };

  const immediate = clock();
  const r1 = await waitForPersonSourcePack({ readMetadata: async () => ({ researchSourcePack: base }), now: immediate.now, sleep: immediate.sleep, log: () => {} });
  assert(r1.pack !== null && r1.waitedMs === 0 && !r1.timedOut, "이미 있으면 기다리지 않는다");

  const later = clock();
  let reads = 0;
  const r2 = await waitForPersonSourcePack({
    readMetadata: async () => (++reads >= 4 ? { researchSourcePack: base } : {}),
    now: later.now,
    sleep: later.sleep,
    log: () => {},
  });
  assert(r2.pack !== null && r2.waitedMs === 90_000 && reads === 4, `30초 간격으로 4번째에 채워짐 (waited ${r2.waitedMs}, reads ${reads})`);

  const never = clock();
  let neverReads = 0;
  const r3 = await waitForPersonSourcePack({ readMetadata: async () => (neverReads++, {}), now: never.now, sleep: never.sleep, log: () => {} });
  assert(r3.pack === null && r3.timedOut && r3.waitedMs === SOURCE_PACK_WAIT_MS && neverReads === 17, `8분 만료 후 재료 없이 진행 (waited ${r3.waitedMs}, reads ${neverReads})`);

  const flaky = clock();
  let flakyReads = 0;
  const r4 = await waitForPersonSourcePack({
    readMetadata: async () => {
      if (++flakyReads === 1) throw new Error("db down");
      return { researchSourcePack: base };
    },
    now: flaky.now,
    sleep: flaky.sleep,
    log: () => {},
  });
  assert(r4.pack !== null && r4.waitedMs === 30_000, "읽기 실패는 대기를 멈추지 않는다");

  let waitCalls = 0;
  const calls = (): number => waitCalls;
  const wait = async () => {
    waitCalls++;
    return base;
  };
  assert((await resolvePersonSourcePack({ category: "entertainment", metadata: {}, jobId: "j", wait })) === null && calls() === 0, "비person은 대기도 조회도 없다");
  assert((await resolvePersonSourcePack({ category: null, metadata: null, jobId: "j", wait })) === null && calls() === 0, "category 없음도 동일");
  assert((await resolvePersonSourcePack({ category: "person", metadata: { researchSourcePack: base }, jobId: "j", wait })) !== null && calls() === 0, "person이어도 이미 있으면 대기하지 않는다");
  assert((await resolvePersonSourcePack({ category: "person", metadata: {}, jobId: "j", wait })) === base && calls() === 1, "person이고 없으면 기다린다");
  console.log("✅ 러너 대기: 즉시/30초 간격/8분 타임아웃(재료 없이 진행)/읽기 실패 내성, 비person 무영향");
}

// 7) 프롬프트 주입
{
  const job = { keyword: "차정원", headline: "차정원", category: "person", seed_query: null } as unknown as ArticleJobRow;
  const prompt = (category: string, pack: PersonSourcePack | null) =>
    buildResearchPrompt({ job: { ...job, category } as ArticleJobRow, baselineSources: [], outputPath: "/tmp/r.md", today: "2026-10-15", brief: null, sourceContext: null, personSourcePack: pack });
  const pack: PersonSourcePack = { personDb: "차정원 펴고 접기\n소속사\n사람엔터테인먼트", namuwiki: "## 1. 개요\n대한민국의 배우.", fetchedAt: "2026-10-15T12:00:00Z", errors: [] };
  const withPack = prompt("person", pack);
  assert(withPack.includes("맥이 수집한 네이버 인물DB 카드와 나무위키 원문"), "소스팩 절 머리");
  assert(withPack.includes("§2-1의 이 두 고정 출처 열람은 아래 원문으로 갈음할 수 있다"), "§2-1 갈음 안내");
  assert(withPack.includes("인물DB = official, 나무위키 = community"), "등급 규칙은 동일 적용");
  assert(withPack.includes("사람엔터테인먼트") && withPack.includes("대한민국의 배우."), "원문이 실린다");
  assert(withPack.indexOf("맥이 수집한") < withPack.indexOf("파이프라인 오버라이드"), "오버라이드 절 앞에 놓인다");

  const failedPack: PersonSourcePack = { personDb: "", namuwiki: "문서 있음", fetchedAt: "2026-10-15T12:00:00Z", errors: ["personDb: HTTP 403"] };
  const failedPrompt = prompt("person", failedPack);
  assert(failedPrompt.includes("네이버 인물DB: 맥 수집 실패 - HTTP 403") && failedPrompt.includes("대조 미완으로 기록한다"), "수집 실패 항목은 사유와 대체 지시");
  assert(failedPrompt.includes("문서 있음"), "성공한 항목은 그대로 싣는다");

  const without = prompt("person", null);
  assert(!without.includes("맥이 수집한") && !without.includes("소스팩"), "소스팩이 없으면(대기 만료) 아무것도 싣지 않는다 - 지금과 동일");
  const other = prompt("entertainment", pack);
  assert(!other.includes("맥이 수집한") && !other.includes("사람엔터테인먼트"), "person이 아니면 소스팩이 와도 싣지 않는다");
  console.log("✅ 프롬프트: person만 소스팩 절 주입(§2-1 갈음·등급 동일), 실패 항목 사유, 없으면 무변경, 비person 무영향");
}

// 8) 맥 수집기 - 주입 의존성
{
  const saved: Array<{ jobId: string; pack: PersonSourcePack }> = [];
  const logs: string[] = [];
  const pack: PersonSourcePack = { personDb: "카드", namuwiki: "", fetchedAt: "2026-10-15T00:00:00Z", errors: ["namuwiki: HTTP 403"] };
  let since = "";
  let hasCalls = 0 as number;
  const deps: CollectPersonSourcePackDeps = {
    listCandidates: async (s, limit) => {
      since = s;
      return [{ id: "j1", keyword: "차정원" }, { id: "j2", keyword: "김지원" }].slice(0, limit);
    },
    fetchPack: async () => pack,
    savePack: async (jobId, p) => void saved.push({ jobId, pack: p }),
    hasPack: async () => {
      hasCalls += 1;
      return hasCalls !== 1; // 첫 확인은 덮여 사라진 상황
    },
    now: () => new Date("2026-10-15T12:00:00Z"),
    log: (m) => void logs.push(m),
  };
  const result = await collectPersonSourcePacks(deps);
  assert(since === "2026-10-15T00:00:00.000Z", `최근 12시간만 본다 (${since})`);
  assert(result.processed.length === 2 && result.processed.every((p) => p.saved), "후보를 처리하고 저장 확인");
  assert(saved.filter((s) => s.jobId === "j1").length === 2 && saved.filter((s) => s.jobId === "j2").length === 1, "저장이 덮였으면 한 번 더 쓴다(j1 2회, j2 1회)");
  assert(logs.some((l) => l.includes("차정원") && l.includes("namuwiki: HTTP 403")), "실패 사유를 로그에 남긴다");
  assert(result.processed[0].errors.length === 1, "실패 팩도 저장된다(러너가 불필요하게 기다리지 않게)");
  const empty = await collectPersonSourcePacks({ ...deps, listCandidates: async () => [] });
  assert(empty.processed.length === 0, "대기열이 없으면 아무것도 하지 않는다");
  console.log("✅ 수집기: 12시간 창·저장 확인·덮임 재시도·실패 팩 저장·빈 대기열");
}

console.log("\n🎉 인물 소스팩 테스트 통과");
