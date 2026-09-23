// 인포그래픽의 **픽토그램과 막대그래프**를 고른다(2026-09-23 사용자 결정 Q6=C안).
//
// 왜 AI 생성이 아닌가: 이미지 모델은 한글을 거의 항상 깨뜨린다(output-format.md §8 - `no text,
// no letters`가 규칙인 이유). 정책·행사 인포그래픽은 글자가 정확해야 쓸모가 있으므로, 그리는
// 주체는 계속 Chromium이고 여기서는 **무엇을 그릴지**만 고른다.
//
// 두 가지를 더한다.
//   픽토그램 - 항목 성격(날짜·금액·장소·대상…)에 맞는 아이콘. 못 고르면 기존 주황 점으로 떨어진다.
//   막대그래프 - 값이 전부 **같은 단위의 숫자**일 때만. 아니면 그리지 않는다.
//
// 보수적으로 잡은 이유: 잘못 고른 아이콘이나 엉뚱한 막대는 없는 것만 못하다.

import type { TableRow } from "./extractTableData.js";

/** 24x24 뷰박스 기준 SVG path. 한 항목의 성격을 한눈에 보여주는 정도면 충분하다. */
export type Pictogram = { name: string; path: string };

/**
 * 라벨에 들어간 말로 아이콘을 고른다. **위에서부터 먼저 걸리는 것**을 쓴다 -
 * "신청 기간"처럼 둘 이상 걸리는 라벨이 흔해서 순서가 곧 우선순위다.
 */
const PICTOGRAM_RULES: { test: RegExp; picto: Pictogram }[] = [
  // 기간·일정이 먼저다. "신청 기간"은 신청서가 아니라 달력이 맞다.
  {
    test: /기간|일정|날짜|기한|마감|시작일|종료일|개봉|공개일|방영|출시/,
    picto: { name: "calendar", path: "M7 2v3M17 2v3M3 9h18M5 5h14a2 2 0 012 2v12a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2z" },
  },
  {
    test: /시간|시각|소요|운영시간|영업/,
    picto: { name: "clock", path: "M12 7v5l3 2M12 3a9 9 0 100 18 9 9 0 000-18z" },
  },
  {
    test: /금액|가격|비용|요금|지원금|할인|수당|급여|예산|원$|만원|월세|보증금/,
    picto: { name: "won", path: "M4 7l3 10 3-7 3 7 3-10M3 12h18M3 15h18" },
  },
  // 시청처가 장소보다 먼저다. `어디서 보나`는 핀이 아니라 재생이다(실측: 장소 규칙의 넓은
  // `어디`가 먼저 걸려 핀이 붙었다).
  {
    test: /채널|방송|플랫폼|시청|어디서 보|OTT|넷플릭스|티빙|쿠팡|디즈니|왓챠/,
    picto: { name: "play", path: "M3 6a2 2 0 012-2h14a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V6z M10 8l5 3-5 3V8z M8 21h8" },
  },
  {
    // `어디`는 빼둔다 - "어디서 보나"·"어디서 신청하나"까지 장소로 끌고 온다.
    test: /장소|위치|주소|지역|매장|지점|현장|본점/,
    picto: { name: "pin", path: "M12 21s7-6.2 7-11a7 7 0 10-14 0c0 4.8 7 11 7 11z M12 10a2.5 2.5 0 100-5 2.5 2.5 0 000 5z" },
  },
  {
    test: /대상|자격|조건|요건|누가|해당자/,
    picto: { name: "person", path: "M12 12a4 4 0 100-8 4 4 0 000 8z M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5" },
  },
  {
    test: /인원|명$|참가자|관객|시청자|구독자|팔로워/,
    picto: { name: "people", path: "M9 11a3.5 3.5 0 100-7 3.5 3.5 0 000 7z M2 20c0-3.3 3.1-5.5 7-5.5s7 2.2 7 5.5 M17 11a3 3 0 100-6 M18 20c0-2.4-1-4.2-2.6-5.2" },
  },
  {
    test: /신청|접수|제출|등록|예매|예약|구매|주문/,
    picto: { name: "form", path: "M14 2H7a2 2 0 00-2 2v16a2 2 0 002 2h10a2 2 0 002-2V7l-5-5z M14 2v5h5 M9 13h6 M9 17h4" },
  },
  {
    test: /문의|연락|전화|상담/,
    picto: { name: "phone", path: "M6 3h3l2 5-2.5 1.5a12 12 0 006 6L16 13l5 2v3a2 2 0 01-2 2A16 16 0 014 5a2 2 0 012-2z" },
  },
  {
    test: /혜택|사은품|경품|쿠폰|증정|이벤트/,
    picto: { name: "tag", path: "M3 12l9-9 9 9-9 9-9-9z M8.5 8.5h.01" },
  },
  {
    test: /방법|절차|순서|단계|과정/,
    picto: { name: "steps", path: "M4 18h4v-4H4v4z M10 14h4v-4h-4v4z M16 10h4V6h-4v4z" },
  },
  {
    test: /주의|유의|제외|불가|금지|경고/,
    picto: { name: "warning", path: "M12 4l9 16H3l9-16z M12 10v4 M12 17h.01" },
  },
];

/** 라벨에 맞는 픽토그램. 못 고르면 null - 호출부가 기존 주황 점으로 떨어진다. */
export function pickPictogram(label: string): Pictogram | null {
  const text = (label ?? "").trim();
  if (!text) return null;
  for (const rule of PICTOGRAM_RULES) {
    if (rule.test.test(text)) return rule.picto;
  }
  return null;
}

export type NumericRow = { label: string; display: string; amount: number };

/** `1,200` `3.5` 같은 수를 읽는다. 없으면 null. */
function readNumber(text: string): number | null {
  const matched = text.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  if (!matched) return null;
  const value = Number(matched[0]);
  return Number.isFinite(value) ? value : null;
}

/**
 * 값에서 **단위**를 읽는다. 숫자와 만/억 배수를 걷어낸 나머지다.
 * "30만 원" -> "원", "12,900원" -> "원", "95%" -> "%", "3일" -> "일"
 */
function readUnit(text: string): string {
  return text
    .replace(/,/g, "")
    .replace(/-?\d+(?:\.\d+)?/g, "")
    .replace(/[만억천]/g, "")
    .replace(/\s+/g, "")
    .trim();
}

/** 만·억을 곱해 실제 크기로 바꾼다. 막대 길이를 비교하려면 단위를 맞춰야 한다. */
function scaleOf(text: string): number {
  if (/억/.test(text)) return 100_000_000;
  if (/만/.test(text)) return 10_000;
  if (/천/.test(text)) return 1_000;
  return 1;
}

/**
 * 막대그래프를 그릴 수 있는 행인지 본다.
 *
 * **전부 숫자이고 단위가 같을 때만** 그린다. 하나라도 숫자가 아니거나 단위가 섞이면 null -
 * 엉뚱한 막대는 없는 것만 못하다. 3행 미만도 그리지 않는다(막대 둘은 그래프가 아니다).
 */
export function toNumericRows(rows: readonly TableRow[]): NumericRow[] | null {
  if (rows.length < 3) return null;

  const parsed: NumericRow[] = [];
  const units = new Set<string>();
  for (const row of rows) {
    if (!row.value) return null;
    const base = readNumber(row.value);
    if (base === null) return null;
    units.add(readUnit(row.value));
    parsed.push({ label: row.label, display: row.value, amount: base * scaleOf(row.value) });
  }

  if (units.size !== 1) return null;
  // 전부 0이면 막대 길이를 정할 수 없다.
  if (parsed.every((row) => row.amount === 0)) return null;
  // 음수가 섞이면 가로 막대로는 오해를 부른다.
  if (parsed.some((row) => row.amount < 0)) return null;
  return parsed;
}

/** 막대 길이(%) - 가장 큰 값을 100%로 둔다. 아주 작은 값도 보이게 최소 6%를 준다. */
export function barPercents(rows: readonly NumericRow[]): number[] {
  const max = Math.max(...rows.map((row) => row.amount));
  if (max <= 0) return rows.map(() => 0);
  return rows.map((row) => Math.max(6, Math.round((row.amount / max) * 100)));
}
