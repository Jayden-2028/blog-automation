// 키노라이츠 공식 스틸 수집 테스트. 실행: npm run test:kinolights
//
// 지켜야 할 것: ① 미디어 섹션만 긁는다(추천작 스틸이 섞이면 안 된다)
// ② **틀린 작품이면 아무것도 안 준다** - 실측에서 `M 리부트`가 헬보이를 물어 왔다
// ③ 제목 후보는 긴 것부터 ④ 실패는 예외가 아니라 빈 배열
// ⑤ **검증에 떨어지면 다음 후보로 이어 간다**(2026-11-09) ⑥ 작품명이 키워드 중간·끝에 있어도 닿는다
// 라이브 Serper·키노라이츠 호출은 없다 - 전부 주입이다.
import { readFileSync } from "node:fs";
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
  assert(fetched.length <= 3, `페이지 받기 3건 이하(${fetched.length})`);
  assert(fetched.filter((u) => u.includes("15784")).length === 1, "같은 틀린 페이지는 한 번만 받는다");
  console.log("✅ 재시도 - 틀린 작품 탈락 뒤 다음 후보로 이어서 올바른 스틸 확보");
}

// 10) 라이브 실측 재현: 검증 탈락 -> 다음 후보. 전부 탈락하면 빈 배열이고 예외가 없다. 받기 상한 3.
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
  assert(fetchCalls === 3, `받기 상한 3에서 멈춘다(받기 ${fetchCalls}회, 찾기 ${findCalls}회)`);

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
  console.log("✅ 전부 탈락·예외·받기 상한(3)");
}

console.log("\n🎉 키노라이츠 스틸 테스트 통과");
