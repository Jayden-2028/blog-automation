// 검색어 넓히기 테스트. 실행: npm run test:broaden-query
//
// 고정 데이터는 2026-09-21 실측 검색어다 - 이 검색어들이 후보 0건으로 끝나 자리가 비었다.
import { broadenQuery } from "./broadenQuery.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

// --- 1. 실측 실패 검색어가 쓸 만하게 넓어진다 --------------------------------------------------
{
  // 사용자가 "지창욱 인스타 셀카로만 검색해도 충분하다"고 지적한 자리.
  assert(broadenQuery("지창욱 2022년 인스타그램 셀카 사진") === "지창욱 인스타그램 셀카", `${broadenQuery("지창욱 2022년 인스타그램 셀카 사진")}`);
  assert(broadenQuery("이현중 아시안게임 결승 슛 장면 사진") === "이현중 아시안게임 결승", `${broadenQuery("이현중 아시안게임 결승 슛 장면 사진")}`);
  assert(broadenQuery("지창욱 스캔들 제작발표회 2026년 9월 사진") === "지창욱 스캔들 제작발표회", `${broadenQuery("지창욱 스캔들 제작발표회 2026년 9월 사진")}`);
  console.log("✅ 연도·군더더기를 걷어내 고유명사만 남긴다");
}

// --- 2. 고유명사는 절대 잃지 않는다(넓히다가 대상을 잃으면 엉뚱한 걸 찾는다) --------------------
{
  for (const [input, must] of [
    ["지창욱 2022년 인스타그램 셀카 사진", "지창욱"],
    ["이현중 아시안게임 결승 슛 장면 사진", "이현중"],
    ["최두호 유주상 UFC 331 계체 통과 장면", "최두호"],
  ] as const) {
    const out = broadenQuery(input);
    assert(out !== null && out.includes(must), `"${must}"가 사라졌다: ${out}`);
  }
  console.log("✅ 인물·고유명사는 보존한다");
}

// --- 3. 이미 짧으면 재검색하지 않는다(같은 검색 두 번 = 호출 낭비) ------------------------------
{
  assert(broadenQuery("남자농구 아시안게임 우승") === null, "넓힐 게 없으면 null");
  assert(broadenQuery("지창욱 현봉식") === null, "이름만 있으면 null");
  assert(broadenQuery("사진 장면 모습") === null, "군더더기만 있으면 null(빈 검색어를 만들지 않는다)");
  console.log("✅ 넓힐 것이 없으면 null - 같은 검색을 두 번 하지 않는다");
}

console.log("\n🎉 검색어 넓히기 테스트 통과");
