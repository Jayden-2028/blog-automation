// 카테고리별 서치풀 테스트. 실행: npm run test:image-search-pools
//
// 지켜야 할 것: ① 작품 카테고리는 공식 -> 키노라이츠 순서 ② 모르는 카테고리는 예전 동작(빈 배열)
// ③ 질의 확장은 원고 검색어를 **먼저** 두고 중복을 없앤다
import { describeSearchPools, expandQueriesForPools, searchPoolsFor } from "./imageSearchPools.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

console.log("▶ 서치풀 테스트 시작\n");

// 1) 작품은 공식이 1순위, 키노라이츠가 2순위다. 순서가 곧 규칙이다.
{
  for (const category of ["entertainment", "ott"]) {
    const pools = searchPoolsFor(category);
    assert(pools.length >= 2, `${category}에 서치풀이 있어야 한다`);
    assert(pools[0].label.includes("공식"), `${category} 1순위는 공식 채널 (${pools[0].label})`);
    assert(pools[1].label.includes("키노라이츠"), `${category} 2순위는 키노라이츠 (${pools[1].label})`);
  }
  console.log("✅ 작품 - 공식 채널 -> 키노라이츠 순서");
}

// 2) 모르는 카테고리는 빈 배열 - 프롬프트가 예전과 같아진다.
{
  assert(searchPoolsFor(null).length === 0, "null은 빈 배열");
  assert(searchPoolsFor("parenting").length === 0, "규칙 없는 카테고리는 빈 배열");
  assert(describeSearchPools("키워드", null).length === 0, "풀이 없으면 프롬프트 블록도 없다");
  console.log("✅ 규칙 없는 카테고리는 예전 동작");
}

// 3) 프롬프트 블록에 실제 검색어가 키워드로 치환돼 들어간다.
{
  const lines = describeSearchPools("연애박사", "ott").join("\n");
  assert(lines.includes("연애박사 키노라이츠"), "키워드가 치환돼야 한다");
  assert(lines.includes("연애박사 스틸컷"), "스틸컷 질의가 있어야 한다");
  assert(!lines.includes("{키워드}"), "치환되지 않은 자리표시자가 남으면 안 된다");
  assert(!lines.includes("{인물}"), "{인물}도 치환돼야 한다 - 프롬프트에 그대로 나가면 안 된다");
  console.log("✅ 프롬프트 블록 - 키워드 치환");
}

// 4) 질의 확장 - 원고 검색어가 먼저, 중복 없음.
{
  const queries = expandQueriesForPools("추영우 김소현", "연애박사", "entertainment");
  assert(queries[0] === "추영우 김소현", "원고 검색어가 맨 앞이어야 한다");
  assert(queries.includes("연애박사 키노라이츠"), "서치풀 질의가 붙어야 한다");
  assert(new Set(queries).size === queries.length, "중복이 없어야 한다");

  const plain = expandQueriesForPools("아무거나", "키워드", null);
  assert(plain.length === 1 && plain[0] === "아무거나", "풀이 없으면 원래 검색어 하나만");
  console.log("✅ 질의 확장 - 원고 검색어 우선, 중복 없음");
}

console.log("\n🎉 서치풀 테스트 통과");
