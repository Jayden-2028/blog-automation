// 출처 신뢰 등급 분류 규칙 테스트.
// 외부 호출/DB 접근 없이 순수 함수만 검증한다.
//
// 케이스는 2026-08-27 실제 검색 결과를 근거로 한다("2026 근로장려금 지급일" 웹문서 10건 중
// 9건이 hometax.go.kr 등 공공 도메인, "아기 셔더링어택 증상"은 전부 in.naver.com/clien.net).

import { classifySourceAuthority } from "./sourceAuthorityRules.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

function main(): void {
  console.log("▶ 출처 신뢰 등급 분류 테스트 시작\n");

  // 1) 실제 수집된 official 도메인들 (2026-08-27 "근로장려금" 웹문서 검색 실측).
  const officialCases: [string, string][] = [
    ["https://hometax.go.kr/websquare/websquare.wq?w2xPath=/ui/pp/index.xml", "국세청 홈택스"],
    ["https://www.awoo.or.kr/notice/123", "or.kr 공익법인"],
    ["https://health.kdca.go.kr/healthinfo/some-page", "질병관리청(go.kr 서브도메인)"],
    ["https://www.kribb.re.kr/notice", "re.kr 연구기관"],
  ];
  for (const [url, label] of officialCases) {
    const result = classifySourceAuthority({ url, searchSource: "naver_web" });
    assert(result === "official", `${label}(${url})은 official이어야 한다 (실제: ${result})`);
  }
  console.log(`✅ official 도메인 ${officialCases.length}건 정확히 분류`);

  // 2) 실측 확인된 의료기관 화이트리스트 도메인(2026-08-27 WebSearch로 확인).
  const medicalCases: [string, string][] = [
    ["https://www.amc.seoul.kr/asan/main.do", "서울아산병원"],
    ["https://www.snuh.org/intro.do", "서울대학교병원"],
  ];
  for (const [url, label] of medicalCases) {
    const result = classifySourceAuthority({ url, searchSource: "naver_web" });
    assert(result === "medical", `${label}(${url})은 medical이어야 한다 (실제: ${result})`);
  }
  console.log(`✅ 의료기관 화이트리스트 ${medicalCases.length}건 정확히 분류`);

  // 3) 뉴스 검색 결과는 URL이 official/medical에 안 걸려도 news로 분류한다.
  const newsCases: [string, string][] = [
    ["https://wikitree.co.kr/articles/12345", "위키트리"],
    ["https://ggilbo.com/news/67890", "일반 지역 매체"],
  ];
  for (const [url, label] of newsCases) {
    const result = classifySourceAuthority({ url, searchSource: "naver_news" });
    assert(result === "news", `${label}(${url})은 news여야 한다 (실제: ${result})`);
  }
  console.log(`✅ 뉴스 검색 결과 ${newsCases.length}건 정확히 분류`);

  // 4) "아기 셔더링어택 증상" 실측 결과: 네이버 인플루언서 블로그·커뮤니티는 community다.
  const communityCases: [string, string][] = [
    ["https://in.naver.com/somechannel/contents/123", "네이버 인플루언서 블로그"],
    ["https://www.clien.net/service/board/park/456", "커뮤니티"],
  ];
  for (const [url, label] of communityCases) {
    const result = classifySourceAuthority({ url, searchSource: "naver_web" });
    assert(result === "community", `${label}(${url})은 community여야 한다 (실제: ${result})`);
  }
  console.log(`✅ 커뮤니티/블로그 ${communityCases.length}건 정확히 분류`);

  // 5) URL을 파싱할 수 없으면 가장 낮은 등급(community)으로 취급한다 - "판정 불가"를
  //    "신뢰할 수 있음"으로 오인하면 안 된다.
  for (const bad of [null, undefined, "", "not-a-url", "/relative/path"]) {
    const result = classifySourceAuthority({ url: bad as string, searchSource: "naver_web" });
    assert(result === "community", `URL 파싱 불가(${JSON.stringify(bad)})는 community여야 한다 (실제: ${result})`);
  }
  console.log("✅ URL 파싱 불가 -> community (신뢰 상향 없음)");

  // 6) blog 검색 소스는 official/medical에 안 걸리면 community다(news 아님 - naver_blog는
  //    news 검색이 아니므로 3)의 news 특례를 타지 않는다).
  const blogResult = classifySourceAuthority({ url: "https://blog.naver.com/someone/1", searchSource: "naver_blog" });
  assert(blogResult === "community", `일반 블로그(naver_blog 소스)는 community여야 한다 (실제: ${blogResult})`);
  console.log("✅ naver_blog 소스는 official/medical 미매칭 시 community (news 아님)");

  // 7) www. 접두사와 서브도메인은 같은 결과를 내야 한다.
  const withWww = classifySourceAuthority({ url: "https://www.hometax.go.kr/x", searchSource: "naver_web" });
  const withoutWww = classifySourceAuthority({ url: "https://hometax.go.kr/x", searchSource: "naver_web" });
  assert(withWww === "official" && withoutWww === "official", "www. 유무와 무관하게 같은 등급이어야 한다");
  console.log("✅ www. 접두사 유무 무관 동일 분류");

  console.log("\n✅ 출처 신뢰 등급 분류 테스트 완료");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
