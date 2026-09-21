// 검색어 재정렬 테스트. 실행: npm run test:align-prompts
//
// 고정 데이터는 2026-09-21 지창욱 원고 실물이다 - 6자리 중 5자리가 어긋나 웹 검색이 전부
// 실패했던 그 사례. 이 케이스가 깨지면 같은 사고가 재발한다.
import { alignImagePrompts, markerDescriptions, similarity } from "./alignImagePrompts.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const BASE = [
  "문단 A",
  "[IMAGE: 넷플릭스 '스캔들' 제작발표회에 참석한 지창욱 — 웹 검색]",
  "문단 B",
  "[IMAGE: 2012년 SBS '좋은아침'에서 성형 상담 경험을 밝히는 지창욱 — 웹 검색]",
  "문단 C",
  "[IMAGE: 2022년 인스타그램에 셀카를 올린 지창욱 — 웹 검색]",
  "문단 D",
  "[IMAGE: '웃어라 동해야'(2010)와 '힐러'(2014) 시절 지창욱 얼굴 비교 — 웹 검색]",
  "문단 E",
  "[IMAGE: 톰포드 화보 촬영 현장에 선 지창욱 — 웹 검색]",
  "문단 F",
  "[IMAGE: 넷플릭스 '스캔들' 포스터 속 지창욱 — 웹 검색]",
].join("\n\n");

// 실제 배리에이션이 만든 순서(재배열됨). 5번은 표현까지 살짝 바뀌었다.
const VARIANT = [
  "[IMAGE: 톰포드 화보 촬영장에서 포즈를 취한 지창욱 — 웹 검색]",
  "[IMAGE: 넷플릭스 '스캔들' 포스터 속 지창욱 — 웹 검색]",
  "[IMAGE: 2012년 SBS '좋은아침'에서 성형 상담 경험을 밝히는 지창욱 — 웹 검색]",
  "[IMAGE: '웃어라 동해야'(2010)와 '힐러'(2014) 시절 지창욱 얼굴 비교 — 웹 검색]",
  "[IMAGE: 2022년 인스타그램에 셀카를 올린 지창욱 — 웹 검색]",
  "[IMAGE: 넷플릭스 '스캔들' 제작발표회에 참석한 지창욱 — 웹 검색]",
].join("\n\n");

const PROMPTS = [
  "넷플릭스 스캔들 지창욱 제작발표회",
  "지창욱 좋은아침 2012년 성형 발언 방송 사진",
  "지창욱 2022년 인스타그램 셀카 사진",
  "지창욱 웃어라 동해야 힐러 얼굴 비교 사진",
  "지창욱 톰포드 화보",
  "넷플릭스 스캔들 지창욱 포스터 사진",
];

// --- 1. 마커 설명 추출 - 획득 방식 접미사를 뗀다 ------------------------------------------------
{
  const got = markerDescriptions(BASE);
  assert(got.length === 6, `마커 6개를 뽑아야 한다 (${got.length})`);
  assert(!got[0].includes("웹 검색"), `획득 방식이 남으면 안 된다 (${got[0]})`);
  assert(got[0] === "넷플릭스 '스캔들' 제작발표회에 참석한 지창욱", `설명이 정확해야 한다 (${got[0]})`);
  console.log("✅ 마커 설명 추출");
}

// --- 2. 실제 사고 재현 - 재배열된 배리에이션에 검색어가 따라붙는다 -------------------------------
{
  const result = alignImagePrompts(BASE, VARIANT, PROMPTS);
  assert(result !== null, "정렬 결과가 있어야 한다");
  assert(result.reordered, "재배열을 감지해야 한다");
  assert(result.unmatched.length === 0, `짝을 못 지은 자리가 없어야 한다 (${result.unmatched})`);

  // 배리에이션 1번은 "톰포드" 자리 -> 톰포드 검색어가 와야 한다(사고 당시엔 제작발표회가 왔다).
  assert(result.prompts[0] === "지창욱 톰포드 화보", `자리 1이 틀렸다: ${result.prompts[0]}`);
  assert(result.prompts[1] === "넷플릭스 스캔들 지창욱 포스터 사진", `자리 2가 틀렸다: ${result.prompts[1]}`);
  assert(result.prompts[2] === "지창욱 좋은아침 2012년 성형 발언 방송 사진", `자리 3이 틀렸다: ${result.prompts[2]}`);
  assert(result.prompts[3] === "지창욱 웃어라 동해야 힐러 얼굴 비교 사진", `자리 4가 틀렸다: ${result.prompts[3]}`);
  assert(result.prompts[4] === "지창욱 2022년 인스타그램 셀카 사진", `자리 5가 틀렸다: ${result.prompts[4]}`);
  assert(result.prompts[5] === "넷플릭스 스캔들 지창욱 제작발표회", `자리 6이 틀렸다: ${result.prompts[5]}`);
  console.log("✅ 실제 사고 재현 - 재배열돼도 검색어가 제 마커를 따라간다");
}

// --- 3. 표현이 바뀌어도 같은 대상이면 붙는다 ----------------------------------------------------
{
  // "촬영 현장에 선" -> "촬영장에서 포즈를 취한"으로 바뀐 실제 케이스.
  assert(similarity("톰포드 화보 촬영 현장에 선 지창욱", "톰포드 화보 촬영장에서 포즈를 취한 지창욱") > 0.3, "같은 대상은 높은 점수");
  assert(similarity("톰포드 화보 속 지창욱", "넷플릭스 스캔들 포스터 속 지창욱") < 0.5, "다른 대상은 낮은 점수");
  console.log("✅ 표현이 달라도 같은 대상이면 매칭");
}

// --- 4. 순서가 그대로면 아무것도 바꾸지 않는다 --------------------------------------------------
{
  const result = alignImagePrompts(BASE, BASE, PROMPTS);
  assert(result !== null && !result.reordered, "재배열이 없으면 reordered=false");
  assert(JSON.stringify(result.prompts) === JSON.stringify(PROMPTS), "순서가 같으면 검색어도 그대로");
  console.log("✅ 재배열이 없으면 기존과 동일");
}

// --- 5. 못 고칠 상황에서는 손대지 않는다(기존 동작 유지) ----------------------------------------
{
  assert(alignImagePrompts(BASE, VARIANT, PROMPTS.slice(0, 3)) === null, "검색어 수가 안 맞으면 null");
  assert(alignImagePrompts("마커 없는 본문", VARIANT, []) === null, "기준에 마커가 없으면 null");
  assert(alignImagePrompts(BASE, "마커 없는 본문", PROMPTS) === null, "배리에이션에 마커가 없으면 null");
  console.log("✅ 못 고칠 상황에서는 null - 기존 동작을 유지한다");
}

// --- 6. 전혀 다른 마커가 새로 생기면 그 자리만 빈다(엉뚱한 검색어를 붙이지 않는다) ---------------
{
  const withNew = VARIANT.replace(
    "[IMAGE: 넷플릭스 '스캔들' 포스터 속 지창욱 — 웹 검색]",
    "[IMAGE: 전혀 관계없는 풍경 사진 — 웹 검색]"
  );
  const result = alignImagePrompts(BASE, withNew, PROMPTS);
  assert(result !== null, "결과가 있어야 한다");
  assert(result.unmatched.includes(2), `못 지은 자리를 알려야 한다 (${result.unmatched})`);
  assert(result.prompts[1] === "", "짝이 없으면 빈 검색어 - 엉뚱한 것을 붙이지 않는다");
  assert(result.prompts[0] === "지창욱 톰포드 화보", "나머지는 정상적으로 붙어야 한다");
  console.log("✅ 짝 없는 자리는 비운다 - 엉뚱한 검색어를 붙이지 않는다");
}

// --- 7. 조사가 달라도 같은 대상으로 본다(2026-09-21 안은진 원고 실측) ---------------------------
// 순서는 그대로인데 배리에이션이 표현만 바꿔 쓴 경우다. 정확 일치로 세던 때는 조사 하나 때문에
// 6자리 중 4자리가 "대응 없음"으로 떨어져 검색어 없이 수집했고, 그만큼 자리가 비었다.
{
  const base = [
    "[IMAGE: 1회에서 안은진이 착용한 에르에르 라글란 스웨트셔츠 — 웹 검색]",
    "[IMAGE: 2회에서 안은진이 착용한 폴뉴아 니트 — 웹 검색]",
  ].join("\n\n");
  const variant = [
    "[IMAGE: 에르에르 라글란 스웨트셔츠를 입은 1회 안은진 — 웹 검색]",
    "[IMAGE: 폴뉴아 아이보리 니트를 입은 2회 안은진 — 웹 검색]",
  ].join("\n\n");
  const result = alignImagePrompts(base, variant, ["에르에르 라글란", "폴뉴아 니트"]);
  assert(result !== null, "결과가 있어야 한다");
  assert(result.unmatched.length === 0, `조사 차이로 떨어지면 안 된다 (${result.unmatched})`);
  assert(result.prompts[0] === "에르에르 라글란" && result.prompts[1] === "폴뉴아 니트", "제 검색어가 붙어야 한다");
  console.log("✅ 조사만 다른 설명도 같은 대상으로 본다");
}

// --- 8. 고유명사가 조사와 같은 글자로 끝나도 망가지지 않는다 -------------------------------------
// "이미도"(극중 인물)의 끝 글자는 조사 "도"와 같다. 조사를 떼는 방식이었다면 "이미"가 돼
// 엉뚱하게 매칭된다.
{
  const base = "[IMAGE: 이미도 역을 연기하는 안은진 — 웹 검색]\n\n[IMAGE: 회차별 시청률 변화 — 표 생성]";
  const variant = "[IMAGE: 영화감독 이미도로 분한 안은진의 극중 스틸 — 웹 검색]\n\n[IMAGE: 회차별 시청률 변화 — 표 생성]";
  const result = alignImagePrompts(base, variant, ["안은진 이미도", ""]);
  assert(result !== null, "결과가 있어야 한다");
  assert(result.prompts[0] === "안은진 이미도", `인물 자리가 어긋났다 (${result.prompts[0]})`);
  console.log("✅ 조사와 같은 글자로 끝나는 고유명사도 안전하다");
}

// --- 9. 순서가 그대로면 짝을 못 지어도 번호순으로 되돌린다 ---------------------------------------
// 비우면 검색어 없이 수집하게 돼 그 자리가 통째로 빈다. 재배열이 없다고 확인된 원고라면
// 번호순이 맞을 가능성이 높다. **재배열된 원고에서는 쓰지 않는다**(6번 테스트가 그것을 지킨다).
{
  const base = "[IMAGE: 첫 번째 설명 — 웹 검색]\n\n[IMAGE: 두 번째 설명 — 웹 검색]";
  const variant = "[IMAGE: 첫 번째 설명 — 웹 검색]\n\n[IMAGE: 완전히 딴판인 무언가 — 웹 검색]";
  const result = alignImagePrompts(base, variant, ["검색어 1", "검색어 2"]);
  assert(result !== null, "결과가 있어야 한다");
  assert(result.reordered === false, "재배열은 없다");
  assert(result.prompts[1] === "검색어 2", `번호순으로 되돌려야 한다 (${result.prompts[1]})`);
  console.log("✅ 순서가 그대로면 짝을 못 지어도 번호순으로 되돌린다");
}

console.log("\n🎉 검색어 재정렬 테스트 통과");
