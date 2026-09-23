// 인포그래픽 픽토그램·막대그래프 선택 테스트. 실행: npm run test:table-visuals
//
// 지켜야 할 것: ① 라벨 성격에 맞는 아이콘 ② 못 고르면 null(점으로 떨어진다)
// ③ 막대는 **전부 같은 단위의 숫자**일 때만 - 단위가 섞이면 길이 비교가 거짓말이 된다
// ④ 만·억을 곱해 크기를 맞춘다
import { barPercents, pickPictogram, toNumericRows } from "./tableVisuals.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const rows = (...pairs: [string, string][]) => pairs.map(([label, value]) => ({ label, value }));

console.log("▶ 인포그래픽 시각 요소 테스트 시작\n");

// 1) 라벨 → 아이콘.
{
  assert(pickPictogram("신청 기간")?.name === "calendar", "'신청 기간'은 달력이다(신청서가 아니라)");
  assert(pickPictogram("지원 금액")?.name === "won", "금액은 원화");
  assert(pickPictogram("행사 장소")?.name === "pin", "장소는 핀");
  assert(pickPictogram("지원 대상")?.name === "person", "대상은 사람");
  assert(pickPictogram("신청 방법")?.name === "form", "신청은 문서");
  assert(pickPictogram("문의")?.name === "phone", "문의는 전화");
  assert(pickPictogram("어디서 보나")?.name === "play", "시청처는 재생");
  console.log("✅ 라벨 성격에 맞는 픽토그램");
}

// 2) 못 고르면 null - 억지로 아이콘을 붙이지 않는다.
{
  assert(pickPictogram("코엑스") === null, "고유명사는 아이콘이 없다");
  assert(pickPictogram("") === null, "빈 라벨은 null");
  assert(pickPictogram("기타") === null, "규칙에 없으면 null");
  console.log("✅ 못 고르면 null(점으로 폴백)");
}

// 3) 막대그래프 - 같은 단위 숫자만.
{
  const ok = toNumericRows(rows(["코엑스", "12,000명"], ["더현대", "8,500명"], ["본점", "6,200명"]));
  assert(ok !== null && ok.length === 3, "같은 단위 숫자 3행이면 막대를 그린다");
  assert(ok![0].amount === 12000, "숫자를 읽어야 한다");

  const mixed = toNumericRows(rows(["금액", "20만 원"], ["기간", "30일"], ["대상", "19~34세"]));
  assert(mixed === null, "단위가 섞이면 막대를 그리지 않는다");

  const notNumeric = toNumericRows(rows(["방법", "온라인 신청"], ["장소", "코엑스"], ["문의", "주민센터"]));
  assert(notNumeric === null, "숫자가 아니면 막대가 아니다");

  const twoRows = toNumericRows(rows(["A", "10명"], ["B", "20명"]));
  assert(twoRows === null, "2행은 그래프가 아니다");

  const negative = toNumericRows(rows(["A", "-5명"], ["B", "10명"], ["C", "20명"]));
  assert(negative === null, "음수가 섞이면 가로 막대로 오해를 부른다");
  console.log("✅ 막대는 같은 단위 숫자 3행 이상일 때만");
}

// 4) 만·억 배수를 곱해 크기를 맞춘다. 안 그러면 "3억"이 "5000만"보다 짧게 그려진다.
{
  const scaled = toNumericRows(rows(["A", "3억 원"], ["B", "5000만 원"], ["C", "2000만 원"]));
  assert(scaled !== null, "같은 단위(원)면 막대를 그린다");
  assert(scaled![0].amount === 300_000_000, `억을 곱해야 한다 (${scaled![0].amount})`);
  assert(scaled![1].amount === 50_000_000, `만을 곱해야 한다 (${scaled![1].amount})`);
  const percents = barPercents(scaled!);
  assert(percents[0] === 100, "가장 큰 값이 100%");
  assert(percents[1] < percents[0] && percents[1] > 0, "작은 값은 짧게");
  console.log("✅ 만·억 배수 반영 + 막대 길이");
}

// 5) 아주 작은 값도 보이게 최소 길이를 준다.
{
  const percents = barPercents([
    { label: "A", display: "1000", amount: 1000 },
    { label: "B", display: "1", amount: 1 },
  ]);
  assert(percents[1] >= 6, `아주 작은 값도 보여야 한다 (${percents[1]}%)`);
  console.log("✅ 최소 막대 길이");
}

console.log("\n🎉 인포그래픽 시각 요소 테스트 통과");
