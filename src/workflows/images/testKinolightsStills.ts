// 키노라이츠 공식 스틸 수집 테스트. 실행: npm run test:kinolights
//
// 지켜야 할 것: ① 미디어 섹션만 긁는다(추천작 스틸이 섞이면 안 된다)
// ② **틀린 작품이면 아무것도 안 준다** - 실측에서 `M 리부트`가 헬보이를 물어 왔다
// ③ 제목 후보는 긴 것부터 ④ 실패는 예외가 아니라 빈 배열
// ⑤ **검증에 떨어지면 다음 후보로 이어 간다**(2026-11-09) ⑥ 작품명이 키워드 중간·끝에 있어도 닿는다
// 라이브 Serper·키노라이츠 호출은 없다 - 전부 주입이다.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { collectWebImages } from "./collectWebImages.js";
import type { WebImageSlot } from "./collectWebImages.js";
import {
  buildSoloPrompt,
  collectPersonWorkStills,
  extractWorkTitle,
  inferGender,
  personNameOf,
  readCast,
} from "./kinolightsPersonStills.js";
import type { PersonSlot } from "./kinolightsPersonStills.js";
import {
  searchKinolightsLinks,
  searchKinolightsWorkUrls,
} from "./searchKinolightsStills.js";
import {
  cleanKeyword,
  extractStills,
  readWorkTitle,
  resolveGotoLinks,
  searchKinolightsStills,
  titleMatchesKeyword,
  toMediaUrl,
  workTitleCandidates,
} from "./searchKinolightsStills.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

/** 실제 페이지 구조를 줄인 것. 미디어 섹션 2장 + 추천작 1장. */
const HTML = `<html><head>
<meta property="og:title" content="연애박사 · 미디어"/>
</head><body>
<button aria-label="스틸컷 1 전체 화면으로 보기"><img src="https://file-dit.kinolights.com/fit-in/1920x0/original/content_still_cut/202609/14/a4953719-9bf2-4220-a218-249cf7dc300b.jpeg"/></button>
<button aria-label="스틸컷 2 전체 화면으로 보기"><img src="https://file-dit.kinolights.com/fit-in/640x0/original/content_still_cut/202609/14/9c64919b-9741-42a2-b48e-7baa6f33ff8c.jpeg"/></button>
<button aria-label="비슷한 작품 보기"><img src="https://file-dit.kinolights.com/fit-in/96x0/original/content_still_cut/202502/10/64e9d036-fd3f-4df9-8ad6-b2fa9a36fb72.jpeg"/></button>
<img src="https://file.kinolights.com/original/content_poster/202609/15/689d6167-e37d-4ec9-91db-b7ec92e563e4.jpeg"/>
</body></html>`;

console.log("▶ 키노라이츠 스틸 테스트 시작\n");

// 1) 미디어 섹션만. 추천작·포스터는 안 들어간다.
{
  const stills = extractStills(HTML, "https://m.kinolights.com/season/152343/media");
  assert(stills.length === 2, `미디어 섹션 2장만 (받은 값: ${stills.length})`);
  assert(stills.every((s) => s.imageUrl.startsWith("https://file.kinolights.com/original/")), "원본 URL로 복원해야 한다");
  assert(!stills.some((s) => s.imageUrl.includes("64e9d036")), "추천작 스틸이 섞이면 안 된다");
  assert(!stills.some((s) => s.imageUrl.includes("content_poster")), "포스터는 스틸이 아니다");
  assert(stills[0].sourcePage.includes("152343"), "출처 페이지를 남겨야 한다");
  console.log("✅ 미디어 섹션만 추출 - 추천작·포스터 제외");
}

// 2) 제목 읽기 - 페이지마다 형식이 다르다.
{
  assert(readWorkTitle(HTML) === "연애박사", "media 페이지 형식");
  assert(
    readWorkTitle('<meta property="og:title" content="연애박사 다시보기 | 키노라이츠 #리뷰"/>') === "연애박사",
    "season 페이지 형식"
  );
  assert(readWorkTitle("<html></html>") === null, "없으면 null");
  console.log("✅ 작품 제목 읽기 - 두 형식 모두");
}

// 3) **틀린 작품 차단.** 실측: `티빙 오리지널 M 리부트`가 헬보이(스틸 20장)를 물어 왔다.
{
  assert(titleMatchesKeyword("연애박사", "연애박사 안판석 감독 유작 추영우 김소현"), "앞머리가 맞으면 통과");
  assert(!titleMatchesKeyword("헬보이", "티빙 오리지널 M 리부트"), "헬보이는 막아야 한다");
  // 2026-11-09: 앞머리 일치 -> 구간 일치. `리부트`는 단어 경계에 정렬된 구간이라 이제 통과한다(작품명이 키워드
  // 끝에 오는 경우를 살리려는 대가). 엉뚱한 작품 차단은 위 헬보이처럼 **어느 구간도 아닌 제목**이 맡는다.
  assert(titleMatchesKeyword("리부트", "티빙 오리지널 M 리부트"), "'리부트'는 단어 경계 구간이다");
  assert(!titleMatchesKeyword("리부", "티빙 오리지널 M 리부트"), "단어 중간에서 걸리면 안 된다(includes 아님)");
  assert(!titleMatchesKeyword("시리즈M", "티빙 오리지널 M 리부트"), "시리즈M도 아니다");
  assert(titleMatchesKeyword("폭싹 속았수다", "폭싹 속았수다 결말"), "공백 차이는 무시");
  assert(!titleMatchesKeyword("M", "티빙 오리지널 M 리부트"), "한 글자 제목은 못 믿는다");
  console.log("✅ 틀린 작품 차단 - 헬보이 사고 재발 방지");
}

// 4) 제목 후보는 긴 것부터. 짧은 것부터 가면 한 글자가 엉뚱한 작품을 문다.
{
  const c = workTitleCandidates("티빙 오리지널 M 리부트");
  assert(c[0] === "티빙 오리지널 M 리부트", "원본 키워드가 먼저");
  assert(c.indexOf("M 리부트") < c.indexOf("M") || !c.includes("M"), "긴 후보가 먼저여야 한다");
  assert(cleanKeyword("넷플릭스 오리지널 아무거나") === "아무거나", "플랫폼·장르 수식을 걷어낸다");
  console.log("✅ 제목 후보 - 긴 것부터, 플랫폼 제거");
}

// 5) 실패는 예외가 아니라 빈 배열. 이미지 하나 때문에 원고가 막히면 안 된다.
{
  assert(toMediaUrl("https://example.com/x") === null, "키노라이츠가 아니면 null");
  assert(toMediaUrl("https://m.kinolights.com/season/1/reviews") === "https://m.kinolights.com/season/1/media", "media로 정규화");

  const none = await searchKinolightsStills("아무거나", { findWorkUrl: async () => null, fetchPage: async () => null });
  assert(none.length === 0, "작품을 못 찾으면 빈 배열");

  const failed = await searchKinolightsStills("아무거나", {
    findWorkUrl: async () => { throw new Error("네트워크"); },
    fetchPage: async () => HTML,
  });
  assert(failed.length === 0, "검색이 터져도 예외를 던지지 않는다");

  const wrongWork = await searchKinolightsStills("티빙 오리지널 M 리부트", {
    findWorkUrl: async () => "https://m.kinolights.com/season/69963",
    fetchPage: async () => HTML.replace("연애박사 · 미디어", "헬보이 · 미디어"),
  });
  assert(wrongWork.length === 0, "제목이 안 맞으면 스틸이 있어도 안 쓴다");
  console.log("✅ 실패·오매칭은 빈 배열(예외 없음)");
}

// 6) goto 링크 해제(2026-10-30 서퍼 변경). 4위부터는 실제 주소 대신 google.com/goto가 온다 -
//    풀지 않으면 작품 페이지가 상위 3개 밖일 때 조용히 못 찾는다.
{
  const GOTO = "https://www.google.com/goto?url=CAESZwHrOzAV";
  let sent: unknown = null;
  const fakeFetch = (async (_url: string, init?: RequestInit) => {
    sent = JSON.parse(String(init?.body ?? "{}"));
    return {
      ok: true,
      json: async () => ({ links: ["https://kinolights.com/season/118099"], credits: 0 }),
    } as unknown as Response;
  }) as unknown as typeof fetch;

  const out = await resolveGotoLinks([GOTO], "key", fakeFetch);
  assert(out[0] === "https://kinolights.com/season/118099", `실제 주소를 돌려줘야 한다: ${out[0]}`);
  assert(JSON.stringify(sent) === JSON.stringify({ links: [GOTO] }), `links 배열로 보낸다: ${JSON.stringify(sent)}`);

  const empty = await resolveGotoLinks([], "key", (async () => {
    throw new Error("불려선 안 된다");
  }) as unknown as typeof fetch);
  assert(empty.length === 0, "풀 링크가 없으면 호출하지 않는다");

  const failed = await resolveGotoLinks([GOTO], "key", (async () => {
    throw new Error("네트워크");
  }) as unknown as typeof fetch);
  assert(failed.length === 0, "해제가 실패해도 예외 없이 빈 배열(스틸 수집을 막지 않는다)");

  const notOk = await resolveGotoLinks([GOTO], "key", (async () =>
    ({ ok: false, json: async () => ({}) }) as unknown as Response) as unknown as typeof fetch);
  assert(notOk.length === 0, "비정상 응답도 빈 배열");
  console.log("✅ goto 링크 해제(0크레딧) - 요청 형식·실패 격리");
}

// 7) 작품명이 키워드 중간·끝에 있어도 후보에 오른다(헤드라인형 키워드, 10/20 이후 작품 원고 11건 중 4건만 성공).
{
  const K_END = "연애는 달달 현실은 씁쓸 청춘의 반짝거림 그린 연애박사";
  const K_MID = "19.5% 닥터X 제쳤다 공개 단 하루만에 넷플릭스 1위";
  const K_CN = "중드 가금채 줄거리 및 몇부작 편성 정보 첫방";
  const K_ACTOR = "주상욱 90분 줄거리 보니 묘하게 겹친다 차예련 학폭";
  const NOISE_EDGE = ["줄거리", "결말", "몇부작", "공개", "첫방", "중드", "넷플릭스", "정보", "편성", "및"];

  assert(workTitleCandidates(K_END).includes("연애박사"), `끝에 있는 작품명: ${workTitleCandidates(K_END).join(" | ")}`);
  assert(workTitleCandidates(K_MID).includes("닥터X"), `중간에 있는 작품명: ${workTitleCandidates(K_MID).join(" | ")}`);
  assert(workTitleCandidates(K_CN).includes("가금채"), `중드 접두 뒤 작품명: ${workTitleCandidates(K_CN).join(" | ")}`);
  assert(workTitleCandidates(K_ACTOR).includes("90분"), `배우명 뒤 작품명: ${workTitleCandidates(K_ACTOR).join(" | ")}`);

  for (const keyword of [K_END, K_MID, K_CN, K_ACTOR, "100일의 거짓말 왜 빠져들 수밖에 없나 쉴 틈", "시한부 1년 남자를 사다"]) {
    const c = workTitleCandidates(keyword);
    assert(c.length <= 6, `후보는 6개를 넘지 않는다(${c.length}): ${keyword}`);
    assert(c[0] === keyword, `키워드 전체가 맨 앞: ${keyword}`);
    const sizes = c.map((x) => x.split(/\s+/).length);
    assert(sizes[0] >= sizes[sizes.length - 1], `긴 것 먼저: ${sizes.join(",")}`);
    assert(sizes.every((size, i) => i === 0 || size <= sizes[i - 1]), `단어 수가 줄어드는 순서: ${sizes.join(",")}`);
    assert(new Set(c).size === c.length, "중복 없음");
    // 경계 노이즈는 전체 키워드 후보(c[0])를 뺀 구간에서만 따진다.
    for (const span of c.slice(1)) {
      const w = span.split(/\s+/);
      assert(!NOISE_EDGE.includes(w[0]) && !NOISE_EDGE.includes(w[w.length - 1]), `경계 노이즈 구간: "${span}"`);
    }
  }
  const cn = workTitleCandidates(K_CN);
  assert(!cn.some((x) => x.startsWith("줄거리") || x.endsWith("줄거리")), "줄거리로 시작·끝나는 구간 없음");
  // 100일의 거짓말이 거짓말보다 먼저 시도돼야 동명 영화를 먼저 물지 않는다.
  const lie = workTitleCandidates("100일의 거짓말 왜 빠져들 수밖에 없나 쉴 틈");
  assert(lie.includes("100일의 거짓말"), "두 단어 작품명이 후보에 있다");
  assert(!lie.includes("거짓말") || lie.indexOf("100일의 거짓말") < lie.indexOf("거짓말"), "긴 후보가 짧은 후보보다 먼저");
  assert(workTitleCandidates("M").includes("M"), "후보가 그것뿐이면 한 글자도 쓴다");
  assert(workTitleCandidates("   ").length === 0, "빈 키워드는 후보 없음");
  console.log("✅ 후보 생성 - 중간·끝 작품명 포함, 상한 6, 긴 것 먼저, 경계 노이즈 제거");
}

// 8) 구간 정렬 제목 검증.
{
  assert(titleMatchesKeyword("닥터X", "19.5% 닥터X 제쳤다 공개 단 하루만에 넷플릭스 1위"), "중간 단어");
  assert(titleMatchesKeyword("가금채", "중드 가금채 줄거리 및 몇부작 편성 정보 첫방"), "두 번째 단어");
  assert(titleMatchesKeyword("연애박사", "연애는 달달 현실은 씁쓸 청춘의 반짝거림 그린 연애박사"), "마지막 단어");
  assert(titleMatchesKeyword("100일의 거짓말", "100일의 거짓말 왜 빠져들 수밖에 없나 쉴 틈"), "앞머리 일치는 그대로 통과");
  assert(titleMatchesKeyword("90분", "주상욱 90분 줄거리 보니 묘하게 겹친다 차예련 학폭"), "숫자 포함 제목");
  assert(titleMatchesKeyword("시한부 1년 남자를 사다", "시한부 1년 남자를 사다"), "키워드 전체가 제목");
  assert(!titleMatchesKeyword("헬보이", "티빙 오리지널 M 리부트"), "2026-09-24 헬보이 사고 방어선");
  assert(!titleMatchesKeyword("여친, 빌리겠습니다 3기", "영화 거짓말 4K 무삭제 재개봉 27년 만에 완전판"), "라이브 실측 오매칭 1");
  assert(!titleMatchesKeyword("감각의 제국", "시한부 1년 남자를 사다"), "라이브 실측 오매칭 2");
  assert(!titleMatchesKeyword("닥터", "19.5% 닥터X 제쳤다 공개 단 하루만에 넷플릭스 1위"), "단어 중간 일치는 오탐");
  assert(!titleMatchesKeyword("가", "가 나 다"), "한 글자 제목은 못 믿는다");
  console.log("✅ 제목 검증 - 구간 일치, 단어 경계, 사고 방어선 유지");
}

// 9) 재시도(이번 수정의 핵심). 첫 후보가 엉뚱한 작품이어도 뒤 후보로 이어 가 올바른 스틸을 가져온다.
//    전에는 첫 URL이 틀리면 남은 후보를 시도하지 않고 0장으로 끝났다.
{
  const KEYWORD = "시한부 1년 남자를 사다 뒤에 숨은 연애박사"; // 앞 후보 -> 틀린 작품(감각의 제국), 연애박사 -> 맞는 작품
  const WRONG = "https://m.kinolights.com/season/15784";
  const RIGHT = "https://m.kinolights.com/season/152343";
  const finds: string[] = [];
  const fetched: string[] = [];
  const stills = await searchKinolightsStills(KEYWORD, {
    findWorkUrl: async (candidate) => {
      finds.push(candidate);
      return candidate === "연애박사" ? RIGHT : WRONG;
    },
    fetchPage: async (url) => {
      fetched.push(url);
      return url.includes("15784") ? HTML.replace("연애박사 · 미디어", "감각의 제국 · 미디어") : HTML;
    },
  });
  assert(stills.length === 2, `올바른 작품 스틸이 돌아와야 한다(받은 값: ${stills.length}, 호출 ${finds.join(" | ")})`);
  assert(stills[0].sourcePage.includes("152343"), "맞는 작품의 출처 페이지");
  assert(fetched.length <= 5, `페이지 받기 5건 이하(${fetched.length})`);
  assert(fetched.filter((u) => u.includes("15784")).length === 1, "같은 틀린 페이지는 한 번만 받는다");
  console.log("✅ 재시도 - 틀린 작품 탈락 뒤 다음 후보로 이어서 올바른 스틸 확보");
}

// 10) 라이브 실측 재현: 검증 탈락 -> 다음 후보. 전부 탈락하면 빈 배열이고 예외가 없다. 받기 상한 5.
{
  const KEYWORD = "시한부 1년 남자를 사다";
  const urls = new Map<string, string>([
    ["시한부 1년 남자를 사다", "https://m.kinolights.com/season/15784"], // 감각의 제국
    ["시한부 1년", "https://m.kinolights.com/season/20001"],
    ["1년 남자를", "https://m.kinolights.com/season/20002"],
    ["남자를 사다", "https://m.kinolights.com/season/20003"],
    ["시한부", "https://m.kinolights.com/season/20004"],
    ["사다", "https://m.kinolights.com/season/20005"],
  ]);
  let fetchCalls = 0;
  let findCalls = 0;
  const out = await searchKinolightsStills(KEYWORD, {
    findWorkUrl: async (candidate) => {
      findCalls += 1;
      return urls.get(candidate) ?? "https://m.kinolights.com/season/29999";
    },
    fetchPage: async () => {
      fetchCalls += 1;
      return HTML.replace("연애박사 · 미디어", "감각의 제국 · 미디어");
    },
  });
  assert(out.length === 0, "전부 탈락하면 빈 배열");
  assert(fetchCalls === 5, `받기 상한 5에서 멈춘다(받기 ${fetchCalls}회, 찾기 ${findCalls}회)`);

  const thrown = await searchKinolightsStills(KEYWORD, {
    findWorkUrl: async (candidate) => {
      if (candidate.length % 2 === 0) throw new Error("검색 터짐");
      return "https://m.kinolights.com/season/1";
    },
    fetchPage: async () => {
      throw new Error("페이지 터짐");
    },
  });
  assert(thrown.length === 0, "찾기·받기가 번갈아 터져도 예외 없이 빈 배열");

  const noPage = await searchKinolightsStills(KEYWORD, { findWorkUrl: async () => "https://example.com/x", fetchPage: async () => HTML });
  assert(noPage.length === 0, "키노라이츠 주소가 아니면 받지 않고 넘어간다");
  console.log("✅ 전부 탈락·예외·받기 상한(5)");
}

// ═══ 인물 글(category=person) 작품별 수집 - 2026-11-19 ═══════════════════════════════════
// 사고: job 키워드가 인물 이름이라 문가영·한효주·신민아 0장, 수지는 동명 작품 「수지」의 다른 배우 스틸이
// '안나' 공식 스틸로 발행됐다. 이제 자리의 작품명으로 `작품명 배우명 키노`를 검색한다.

const stillHtml = (title: string, n: number, tag = "a") =>
  `<html><head><meta property="og:title" content="${title} · 미디어"/></head><body>` +
  Array.from(
    { length: n },
    (_, i) =>
      `<button aria-label="스틸컷 ${i + 1} 전체 화면으로 보기"><img src="https://file-dit.kinolights.com/fit-in/640x0/original/content_still_cut/202601/01/${tag}${String(i).padStart(7, "0")}-0000-4000-8000-000000000000.jpeg"/></button>`
  ).join("") +
  "</body></html>";

const seasonHtml = (title: string, cast: { name: string; character: string }[]) =>
  `<html><head><meta property="og:title" content="${title} 평점·다시보기"/></head><body><script type="application/ld+json">${JSON.stringify({
    "@type": "Movie",
    name: title,
    actor: cast.map((c) => ({ "@type": "PerformanceRole", actor: { "@type": "Person", name: c.name }, characterName: c.character })),
  })}</script></body></html>`;

const slot = (index: number, description: string, query: string | null = null): PersonSlot => ({ index, description, query, context: "" });

// P1) 작품명 추출 - 인용부호 여러 종류, 검색어 폴백, **인물명은 작품명이 아니다**.
{
  assert(extractWorkTitle(slot(1, "'다 이루어질지니'에서 가영을 연기한 수지 — 웹 검색", "수지 다 이루어질지니 스틸컷"), "수지") === "다 이루어질지니", "작은따옴표");
  assert(extractWorkTitle(slot(1, "‘안나’ 속 수지"), "수지") === "안나", "‘ ’");
  assert(extractWorkTitle(slot(1, "「건축학개론」 서연 역"), "수지") === "건축학개론", "「 」");
  assert(extractWorkTitle(slot(1, "<재혼 황후>의 나비에"), "신민아") === "재혼 황후", "< >");
  assert(extractWorkTitle(slot(1, "《백일의 낭군님》 도경수"), "도경수") === "백일의 낭군님", "《 》");
  assert(extractWorkTitle(slot(1, "수지의 근황 사진", "수지 건축학개론 스틸컷"), "수지") === "건축학개론", "인용부호가 없으면 `인물명 작품명 스틸컷` 검색어에서");
  assert(extractWorkTitle(slot(1, "수지 프로필 사진", "수지 프로필"), "수지") === null, "작품명이 없으면 null");
  assert(extractWorkTitle(slot(1, "'수지'의 화보 컷", "수지 화보"), "수지") === null, "**인물명과 같은 인용어는 작품명이 아니다**(수지 사고)");
  assert(extractWorkTitle(slot(1, "'수지' 와 '안나' 장면"), "수지") === "안나", "인물명을 건너뛰고 다음 인용어");
  assert(personNameOf("수지") === "수지" && personNameOf("배우 서현진의 모든 것") === "서현진", "키워드에서 인물명을 뽑는다");
  assert(inferGender("그녀는 데뷔했다. 그녀의 연기. 여배우") === "여성", "성별 추정(분명할 때)");
  assert(inferGender("배우가 출연했다") === null, "근거가 없으면 null");
  const prompt = buildSoloPrompt({ workTitle: "안나", personName: "수지", gender: "여성", role: "유미", slotDescriptions: ["안나"], files: ["/t/a.jpg"] });
  assert(prompt.includes("얼굴로 누구인지 알아보지 않는다") && prompt.includes("애매하면 뺀다"), "비전 프롬프트가 얼굴 인식을 금지하고 모호하면 제외시킨다");
  assert(readCast(seasonHtml("건축학개론", [{ name: "수지", character: "과거 서연" }]))[0].character === "과거 서연", "출연진 JSON-LD 읽기");
  console.log("✅ [인물] 작품명 추출 - 인용부호 6종·검색어 폴백·인물명 제외");
}

// P2) 검색 질의 문자열 + og:title을 **작품명과** 맞춘다 + 캐시 + 20장 폴백(브라우저 불가)
{
  const queries: string[] = [];
  const fetched: string[] = [];
  let browserCalls = 0;
  let visionCalls = 0;
  let visionInput: { stills: unknown[]; role: string } | null = null;
  const MEDIA = stillHtml("건축학개론", 20);
  const result = await collectPersonWorkStills(
    {
      keyword: "수지",
      slots: [
        slot(1, "'건축학개론'에서 서연을 연기한 수지 — 웹 검색", "수지 건축학개론 스틸컷"),
        slot(2, "「건축학개론」 첫사랑 장면의 수지 — 웹 검색", "수지 건축학개론 장면"),
        slot(3, "수지 프로필 — 웹 검색", "수지 프로필"),
      ],
    },
    {
      searchWorkUrls: async (q) => {
        queries.push(q);
        return ["https://kinolights.com/season/8595"];
      },
      fetchPage: async (url) => {
        fetched.push(url);
        return url.endsWith("/media") ? MEDIA : seasonHtml("건축학개론", [{ name: "엄태웅", character: "현재 승민" }, { name: "수지", character: "과거 서연" }]);
      },
      loadFullStills: async () => {
        browserCalls += 1;
        return null; // Playwright·Chromium 없음
      },
      pickSoloStills: async (input) => {
        visionCalls += 1;
        visionInput = { stills: input.stills, role: input.role };
        return { ok: true, picks: input.stills.slice(2, 4) };
      },
    }
  );
  assert(queries[0] === "건축학개론 수지 키노", `첫 질의는 \`작품명 배우명 키노\`다: ${queries[0]}`);
  assert(queries.length === 1, `같은 작품 두 자리는 검색 한 번이다(캐시): ${queries.length}회`);
  assert(browserCalls === 1 && visionCalls === 1, `브라우저·비전도 작품당 한 번이다: ${browserCalls}/${visionCalls}`);
  assert(fetched.filter((u) => u.endsWith("/media")).length === 1, "미디어 페이지도 한 번만 받는다");
  assert(visionInput && (visionInput as { stills: unknown[] }).stills.length === 20, "브라우저를 못 쓰면 서버 렌더 20장으로 폴백");
  assert((visionInput as { role: string }).role === "과거 서연", "출연진의 배역을 비전에 준다");
  assert(result.bySlot.get(1)?.length === 2 && result.bySlot.get(2)?.length === 2, "두 자리 모두 단독컷을 받는다");
  assert(result.bySlot.get(1)?.[0] === result.bySlot.get(2)?.[0], "같은 작품 = 같은 결과");
  assert(!result.bySlot.has(3) && result.titleless.join() === "3", "작품명 없는 자리는 기존 경로로 남긴다");
  assert(result.failures.some((f) => f.includes("건축학개론") && f.includes("20장") && f.includes("자리 1, 2")), `진단 줄: ${result.failures.join(" | ")}`);
  console.log("✅ [인물] 질의 `작품명 배우명 키노`·작품당 1회 캐시·브라우저 불가 시 20장 폴백");
}

// P3) **수지 사고 재현** - 「수지」(season/81768)가 걸려도 인물명은 작품명이 아니다.
{
  const queries: string[] = [];
  let vision = 0;
  const result = await collectPersonWorkStills(
    { keyword: "수지", slots: [slot(1, "'안나'에서 유미를 연기한 수지 — 웹 검색", "수지 안나 스틸컷")] },
    {
      searchWorkUrls: async (q) => {
        queries.push(q);
        return ["https://kinolights.com/season/81768"]; // 작품명이 「수지」인 다른 작품
      },
      fetchPage: async (url) => (url.endsWith("/media") ? stillHtml("수지", 4) : seasonHtml("수지", [{ name: "다른배우", character: "수지" }])),
      loadFullStills: async () => null,
      pickSoloStills: async (input) => {
        vision += 1;
        return { ok: true, picks: input.stills };
      },
    }
  );
  assert(result.bySlot.size === 0 && vision === 0, "동명 작품 「수지」의 스틸은 쓰지 않는다");
  assert(queries.length === 3 && queries[1] === "키노라이츠 안나" && queries[2] === "site:kinolights.com 안나", `질의 순서(플랫폼 언급 없음): ${queries.join(" | ")}`);
  assert(result.failures.some((f) => f.includes("제목 불일치(수지)")), `탈락 사유가 남는다: ${result.failures.join(" | ")}`);

  // job 단위 옛 경로도 인물명을 작품으로 인정하지 않는다.
  const jobLevel = await searchKinolightsStills("수지", {
    findWorkUrl: async () => "https://m.kinolights.com/season/81768",
    fetchPage: async () => stillHtml("수지", 4),
    excludeWorkTitles: ["수지"],
  });
  assert(jobLevel.length === 0, "excludeWorkTitles에 든 제목은 og:title이 맞아도 버린다");
  const jobLevelOld = await searchKinolightsStills("수지", {
    findWorkUrl: async () => "https://m.kinolights.com/season/81768",
    fetchPage: async () => stillHtml("수지", 4),
  });
  assert(jobLevelOld.length === 4, "옵션이 없으면 기존 동작 그대로(비인물 경로 불변)");
  console.log("✅ [인물] 수지 사고 재현 - 인물명과 같은 제목의 작품은 매칭되지 않는다");
}

// P4) 동명 작품(출연진에 배우가 없음)은 건너뛰고 다음 후보 페이지로. 출연진을 못 읽으면 제목만으로 통과(기록).
{
  const result = await collectPersonWorkStills(
    { keyword: "수지", slots: [slot(1, "'건축학개론'의 수지")] },
    {
      searchWorkUrls: async () => ["https://kinolights.com/season/114107", "https://kinolights.com/season/8595"],
      fetchPage: async (url) => {
        if (url.includes("114107")) return url.endsWith("/media") ? stillHtml("건축학개론", 3, "b") : seasonHtml("건축학개론", [{ name: "다큐출연자", character: "" }]);
        return url.endsWith("/media") ? stillHtml("건축학개론", 5, "c") : seasonHtml("건축학개론", [{ name: "수지", character: "과거 서연" }]);
      },
      loadFullStills: async () => null,
      pickSoloStills: async (input) => ({ ok: true, picks: input.stills.slice(0, 1) }),
    }
  );
  assert(result.bySlot.get(1)?.[0].sourcePage.includes("8595"), "동명 작품 114107은 건너뛰고 8595를 쓴다");

  const unchecked = await collectPersonWorkStills(
    { keyword: "수지", slots: [slot(1, "'건축학개론'의 수지")] },
    {
      searchWorkUrls: async () => ["https://kinolights.com/season/8595"],
      fetchPage: async (url) => (url.endsWith("/media") ? stillHtml("건축학개론", 5) : null),
      loadFullStills: async () => null,
      pickSoloStills: async (input) => ({ ok: true, picks: input.stills.slice(0, 1) }),
    }
  );
  assert(unchecked.bySlot.size === 1 && unchecked.failures.some((f) => f.includes("제목만으로 통과")), "출연진을 못 읽으면 제목 검증만으로 통과하고 그 사실을 남긴다");
  console.log("✅ [인물] 동명 작품은 출연진으로 거른다");
}

// P5) 비전 실패 = 아무것도 넣지 않는다 / 0장 선택 / 브라우저 전체 목록 사용 / 작품 상한 8 / 예외 없음
{
  const base = {
    searchWorkUrls: async () => ["https://kinolights.com/season/8595"],
    fetchPage: async (url: string) => (url.endsWith("/media") ? stillHtml("건축학개론", 20) : seasonHtml("건축학개론", [{ name: "수지", character: "서연" }])),
    loadFullStills: async () => null,
  };
  const failed = await collectPersonWorkStills(
    { keyword: "수지", slots: [slot(1, "'건축학개론'의 수지")] },
    { ...base, pickSoloStills: async () => ({ ok: false, error: "claude 시간 초과" }) }
  );
  assert(failed.bySlot.size === 0, "비전이 실패하면 필터 없는 스틸을 넣지 않는다");
  assert(failed.failures.some((f) => f.includes("단독컷 선별에 실패") && f.includes("claude 시간 초과")), "실패 사유를 ℹ️ 줄로 남긴다");

  const thrown = await collectPersonWorkStills(
    { keyword: "수지", slots: [slot(1, "'건축학개론'의 수지")] },
    { ...base, pickSoloStills: async () => { throw new Error("펑"); } }
  );
  assert(thrown.bySlot.size === 0 && thrown.failures.length === 1, "비전이 던져도 예외 없이 기록만");

  const none = await collectPersonWorkStills(
    { keyword: "수지", slots: [slot(1, "'건축학개론'의 수지")] },
    { ...base, pickSoloStills: async () => ({ ok: true, picks: [] }) }
  );
  assert(none.bySlot.size === 0 && none.failures.some((f) => f.includes("단독컷으로 볼 만한 것이 없어")), "0장 선택도 기록한다");

  let seen = 0;
  await collectPersonWorkStills(
    { keyword: "수지", slots: [slot(1, "'건축학개론'의 수지")] },
    {
      ...base,
      loadFullStills: async () => extractStills(stillHtml("건축학개론", 26, "d"), "https://m.kinolights.com/season/8595/media"),
      pickSoloStills: async (input) => {
        seen = input.stills.length;
        return { ok: true, picks: [] };
      },
    }
  );
  assert(seen === 26, `브라우저가 불러온 전체 목록(26장)을 비전에 준다: ${seen}`);

  // 작품 상한 8 - Serper 비용 가드.
  const slots = Array.from({ length: 10 }, (_, i) => slot(i + 1, `'작품${i}번'에서의 수지`));
  const queries: string[] = [];
  const capped = await collectPersonWorkStills(
    { keyword: "수지", slots },
    { ...base, searchWorkUrls: async (q) => { queries.push(q); return []; } }
  );
  const firstQueries = queries.filter((q) => q.endsWith("수지 키노"));
  assert(firstQueries.length === 8, `작품 8개까지만 검색한다: ${firstQueries.length}`);
  assert(queries.length === 24, `작품당 3회(플랫폼 언급 없음) = 24회: ${queries.length}`);
  assert(capped.failures.filter((f) => f.includes("작품 수 상한")).length === 2, "넘친 작품은 사유를 남긴다");

  const boom = await collectPersonWorkStills(
    { keyword: "수지", slots: [slot(1, "'건축학개론'의 수지")] },
    { searchWorkUrls: async () => { throw new Error("네트워크"); } }
  );
  assert(boom.bySlot.size === 0, "검색이 터져도 예외 없음");
  console.log("✅ [인물] 비전 실패·0장·예외는 빈 결과, 전체 목록 사용, 작품 8개 상한(Serper 최악 24~32회)");
}

// P6) Serper 호출: 작품 URL 전부 돌려주고, 원장에 jobId로 기록한다.
{
  const prevKey = process.env.SERPER_API_KEY;
  const prevFetch = globalThis.fetch;
  process.env.SERPER_API_KEY = "dummy-not-a-real-key";
  const recorded: { jobId?: string | null }[] = [];
  globalThis.fetch = (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({ organic: [{ link: "https://kinolights.com/season/8595/media" }, { link: "https://example.com/x" }, { link: "https://m.kinolights.com/movie/77" }] }),
    }) as unknown as Response) as typeof fetch;
  try {
    const urls = await searchKinolightsWorkUrls("건축학개론 수지 키노", {
      jobId: "job-1",
      record: (async (row: { jobId?: string | null }) => {
        recorded.push(row);
      }) as never,
    });
    assert(urls.length === 2 && urls[0].includes("8595"), `작품 URL만 순서대로: ${urls.join(",")}`);
    assert(recorded.length === 1 && recorded[0].jobId === "job-1", "Serper 사용량을 jobId로 기록한다");
  } finally {
    globalThis.fetch = prevFetch;
    if (prevKey === undefined) delete process.env.SERPER_API_KEY;
    else process.env.SERPER_API_KEY = prevKey;
  }
  console.log("✅ [인물] Serper 호출 기록(jobId)");
}

// P8) 2026-11-19 실측 후속: 리뷰 페이지 따라가기 · 질의 순서 · 동명 작품 출연진 가르기 · 감독판 후순위.
{
  // 리뷰 페이지가 1위로 오면 거기서 작품 주소를 되찾는다.
  const fetchedReview: string[] = [];
  const review = await collectPersonWorkStills(
    { keyword: "수지", slots: [slot(1, "'안나'에서 유미를 연기한 수지")] },
    {
      searchWorkUrls: async () => ["https://kinolights.com/review/137306"],
      fetchPage: async (url) => {
        if (url.includes("/review/")) {
          fetchedReview.push(url);
          return '<html><a href="https://kinolights.com/season/76275">안나</a></html>';
        }
        return url.endsWith("/media") ? stillHtml("안나", 5) : seasonHtml("안나", [{ name: "수지", character: "유미" }]);
      },
      loadFullStills: async () => null,
      pickSoloStills: async (i) => ({ ok: true, picks: i.stills.slice(0, 1) }),
    }
  );
  assert(fetchedReview.length === 1 && review.bySlot.get(1)?.[0].sourcePage.includes("76275"), "리뷰 페이지에서 작품 주소를 되찾아 쓴다");

  // 같은 제목 두 작품(76765 vs 76275)은 출연진으로 가른다. 첫 질의에서 찾으면 다음 질의는 안 쓴다.
  const queries: string[] = [];
  const multi = await collectPersonWorkStills(
    { keyword: "수지", slots: [slot(1, "'안나'에서 유미를 연기한 수지 — 웹 검색")] },
    {
      searchWorkUrls: async (q) => {
        queries.push(q);
        return ["https://kinolights.com/season/76765", "https://kinolights.com/season/66321/media", "https://kinolights.com/season/76275"];
      },
      fetchPage: async (url) => {
        const other = url.includes("76765") || url.includes("66321");
        if (url.endsWith("/media")) return stillHtml("안나", 3, other ? "e" : "f");
        return seasonHtml("안나", [{ name: other ? "다른배우" : "수지", character: "유미" }]);
      },
      loadFullStills: async () => null,
      pickSoloStills: async (i) => ({ ok: true, picks: i.stills.slice(0, 1) }),
    }
  );
  assert(multi.bySlot.get(1)?.[0].sourcePage.includes("76275"), "동명 작품 셋 중 출연진에 수지가 있는 76275를 고른다");
  assert(queries.length === 1, "통과하면 다음 질의를 쓰지 않는다");

  // 질의 순서(플랫폼 언급 시 4개) - 전부 실패하는 경우.
  const order: string[] = [];
  await collectPersonWorkStills(
    { keyword: "수지", slots: [slot(1, "쿠팡플레이 '안나'의 수지")] },
    { searchWorkUrls: async (q) => { order.push(q); return []; } }
  );
  assert(
    order.join("|") === "안나 수지 키노|키노라이츠 안나|안나 쿠팡플레이 키노라이츠|site:kinolights.com 안나",
    `질의 순서: ${order.join(" | ")}`
  );

  // 감독판은 일반판이 있으면 뒤로 미룬다(설명이 감독판을 말하지 않는 한).
  const dc = (wants: boolean) =>
    collectPersonWorkStills(
      { keyword: "수지", slots: [slot(1, wants ? "'안나 (감독판)'의 수지" : "'안나'의 수지")] },
      {
        searchWorkUrls: async () => ["https://kinolights.com/season/112050", "https://kinolights.com/season/76275"],
        fetchPage: async (url) => {
          const cut = url.includes("112050");
          if (url.endsWith("/media")) return stillHtml(cut ? "안나 (감독판)" : "안나", 3);
          return seasonHtml("안나", [{ name: "수지", character: "유미" }]);
        },
        loadFullStills: async () => null,
        pickSoloStills: async (i) => ({ ok: true, picks: i.stills.slice(0, 1) }),
      }
    );
  assert((await dc(true)).bySlot.get(1)?.[0].sourcePage.includes("112050"), "설명이 감독판이면 감독판을 쓴다");

  // 직접 링크 + goto 링크를 모두 모은다.
  const prevKey = process.env.SERPER_API_KEY;
  const prevFetch = globalThis.fetch;
  process.env.SERPER_API_KEY = "dummy-not-a-real-key";
  globalThis.fetch = (async (url: string) =>
    String(url).includes("resolve")
      ? ({ ok: true, json: async () => ({ links: ["https://kinolights.com/season/76275"] }) } as unknown as Response)
      : ({
          ok: true,
          status: 200,
          json: async () => ({
            organic: [{ link: "https://kinolights.com/review/137306" }, { link: "https://kinolights.com/season/76765" }, { link: "https://www.google.com/goto?url=x" }, { link: "https://namu.wiki/a" }],
          }),
        } as unknown as Response)) as typeof fetch;
  try {
    const links = await searchKinolightsLinks("안나 수지 키노", { record: (async () => {}) as never });
    assert(links.length === 3 && links[0].includes("review") && links[2].includes("76275"), `리뷰·작품·goto 해제 링크를 모두 모은다: ${links.join(",")}`);
  } finally {
    globalThis.fetch = prevFetch;
    if (prevKey === undefined) delete process.env.SERPER_API_KEY;
    else process.env.SERPER_API_KEY = prevKey;
  }
  console.log("✅ [인물] 리뷰 따라가기·질의 순서(≤4)·동명 작품 출연진 가르기·감독판 후순위");
}

// P7) collectWebImages 배선 - 인물 글은 자리별, 그 외 카테고리는 기존 job 단위 호출 그대로.
{
  const PNG = (() => {
    const b = Buffer.alloc(24);
    b.write("\x89PNG\r\n\x1a\n", 0, "binary");
    b.writeUInt32BE(1600, 16);
    b.writeUInt32BE(900, 20);
    return b;
  })();
  const STILL_A = "https://file.kinolights.com/original/content_still_cut/202601/01/a0000000-0000-4000-8000-000000000000.jpeg";
  const slots: WebImageSlot[] = [
    { index: 1, description: "'건축학개론'에서 서연을 연기한 수지 — 웹 검색", query: "수지 건축학개론 스틸컷", context: "문단1" },
    { index: 2, description: "수지 근황 사진 — 웹 검색", query: "수지 근황", context: "문단2" },
  ];
  const dir = await mkdtemp(resolve(tmpdir(), "kino-person-"));
  try {
    const run = async (category: string, onlyTitled = false) => {
      const jobCalls: { keyword: string; excluded?: readonly string[] }[] = [];
      let personCalls = 0;
      let prompt = "";
      const choose: { number: number; official?: boolean; sourcePage: string }[][] = [];
      await collectWebImages(
        { keyword: "수지", dir, slots: onlyTitled ? [slots[0]] : slots },
        {
          category,
          jobId: "job-x",
          searchImages: async () => [],
          cropTall: false,
          searchKinolights: async (keyword, opts) => {
            jobCalls.push({ keyword, excluded: opts?.excludeWorkTitles });
            return [];
          },
          collectPersonStills: async (input) => {
            personCalls += 1;
            return {
              bySlot: new Map([[1, [{ imageUrl: STILL_A, sourcePage: "https://m.kinolights.com/season/8595/media" }]]]),
              titleless: input.slots.filter((s) => s.index !== 1).map((s) => s.index),
              failures: ["ℹ️ 키노라이츠 「건축학개론」(수지): 테스트 줄"],
            };
          },
          runCodex: async (req: { prompt: string }) => {
            prompt = req.prompt;
            return { ok: true as const, durationMs: 1, data: { slots: [] } };
          },
          fetchImage: async () => ({ ok: true as const, buffer: PNG, contentType: "image/png" }),
          chooseImage: async (i) => {
            choose.push(i.candidates.map((c) => ({ number: c.number, official: c.official, sourcePage: c.sourcePage })));
            return { picked: 1, reason: "" };
          },
        }
      ).catch(() => null);
      return { jobCalls, personCalls, prompt, choose };
    };

    const person = await run("person");
    assert(person.personCalls === 1, "person이면 작품별 수집을 부른다");
    assert(person.jobCalls.length === 1 && person.jobCalls[0].excluded?.[0] === "수지", "작품명 없는 자리가 있으면 job 단위도 부르되 인물명을 작품에서 제외한다");
    assert(person.prompt.includes(STILL_A), "단독컷이 자리 1의 후보로 에이전트 프롬프트에 보인다");
    const slot1 = person.prompt.split("### 자리 2")[0];
    assert(slot1.includes(STILL_A) && slot1.indexOf(STILL_A) > -1, "자리 1 블록 안에 있다");
    assert(!person.prompt.split("### 자리 2")[1].includes(STILL_A), "자리 2(작품명 없음)에는 이 스틸이 섞이지 않는다");

    const titledOnly = await run("person", true);
    assert(titledOnly.jobCalls.length === 0, "모든 자리에 작품명이 있으면 job 단위 호출(Serper)을 아낀다");

    const ott = await run("ott");
    assert(ott.personCalls === 0, "ott는 작품별 수집을 부르지 않는다");
    assert(ott.jobCalls.length === 1 && ott.jobCalls[0].keyword === "수지" && ott.jobCalls[0].excluded === undefined, "ott는 기존 job 단위 호출 그대로(제외어 없음)");
    const ent = await run("entertainment");
    assert(ent.personCalls === 0 && ent.jobCalls.length === 1 && ent.jobCalls[0].excluded === undefined, "entertainment도 불변");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  console.log("✅ [인물] collectWebImages 배선 - person만 자리별, ott·entertainment 불변");
}

console.log("\n🎉 키노라이츠 스틸 테스트 통과");

// 비전 표본은 목록 전체에서 고르게(2026-11-19, 「무빙」 155장 중 앞 30장만 보던 문제).
{
  const { sampleEvenly } = await import("./kinolightsPersonStills.js");
  const list = Array.from({ length: 155 }, (_, i) => i);
  const picked = sampleEvenly(list, 30);
  if (picked.length !== 30 || picked[0] !== 0 || picked[29] < 140 || new Set(picked).size !== 30) {
    throw new Error(`❌ sampleEvenly가 전체에 고르게 퍼지지 않는다: ${picked.join(",")}`);
  }
  if (sampleEvenly([1, 2, 3], 30).length !== 3) throw new Error("❌ sampleEvenly가 짧은 목록을 그대로 두지 않는다");
  console.log("✅ 비전 표본이 스틸 목록 전체에 고르게 퍼진다");
}
