// 표 마커 제거 테스트. 실행: npm run test:remove-table-markers
//
// 지켜야 할 것: ① 표 마커와 그 프롬프트를 함께 지운다 ② 다른 마커는 건드리지 않는다
// ③ 빈 줄이 겹치지 않는다 ④ 지울 게 없으면 원본 그대로
import { removeMarkersAt, removeTableMarkers, shiftImageIndexes, shiftIndexedRecord } from "./removeTableMarkers.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

console.log("▶ 표 마커 제거 테스트 시작\n");

{
  const body = [
    "**소제목**",
    "문단입니다.",
    "",
    "[IMAGE: 9월 23일 기준 한국 아시안게임 메달 집계 — 표 생성]",
    "[IMAGE PROMPT: 바로 위 목록을 표로 렌더]",
    "",
    "다음 문단입니다.",
    "",
    "[IMAGE: 시상대의 오상욱 — 웹 검색]",
    "[IMAGE PROMPT: 오상욱 시상대]",
  ].join("\n");

  const out = removeTableMarkers(body);
  assert(out.removed === 1, `표 자리 1개를 지워야 한다 (${out.removed})`);
  assert(!out.body.includes("표 생성"), "표 마커가 남으면 안 된다");
  assert(!out.body.includes("표로 렌더"), "표 마커의 프롬프트도 같이 지워야 한다");
  assert(out.body.includes("웹 검색"), "다른 마커는 그대로 둬야 한다");
  assert(out.body.includes("오상욱 시상대"), "다른 마커의 프롬프트도 그대로");
  assert(!/\n\n\n/.test(out.body), "빈 줄이 세 줄로 겹치면 안 된다");
  console.log("✅ 표 마커 + 프롬프트 제거, 다른 마커 보존");
}

{
  // 프롬프트 줄이 없는 기준 원고 형태도 있다.
  const out = removeTableMarkers("앞\n\n[IMAGE: 집계표 — 표 생성]\n\n뒤");
  assert(out.removed === 1 && !out.body.includes("표 생성"), "프롬프트가 없어도 지운다");
  console.log("✅ 프롬프트 줄이 없어도 제거");
}

{
  const body = "앞\n\n[IMAGE: 사진 — 웹 검색]\n[IMAGE PROMPT: 검색어]\n\n뒤";
  const out = removeTableMarkers(body);
  assert(out.removed === 0, "지울 것이 없으면 0");
  assert(out.body === body, "원본 문자열을 그대로 돌려줘야 한다");
  console.log("✅ 지울 것이 없으면 원본 그대로");
}

{
  // 페이지 캡처(순위 화면)는 본문을 옮긴 표가 아니다 - 건드리지 않는다.
  const body = "[IMAGE: 펀덱스 화제성 순위 — 페이지 캡처]\n[IMAGE PROMPT: https://example.com]";
  assert(removeTableMarkers(body).removed === 0, "페이지 캡처는 지우지 않는다");
  console.log("✅ 페이지 캡처는 대상이 아니다");
}

// --- 자리 번호 당기기(2026-09-24 실측 사고) ---------------------------------------------------
// 마커를 지우면 그 뒤 자리 번호가 하나씩 내려간다. metadata를 같이 당기지 않으면 사용자가
// 6번에 준 이미지 주소가 **존재하지 않는 자리**를 가리키게 된다 - 오상욱 원고에서 실제로 났다.
{
  const body = [
    "[IMAGE: 1번 — 웹 검색]",
    "[IMAGE: 2번 — 웹 검색]",
    "[IMAGE: 3번 집계 — 표 생성]",
    "[IMAGE: 4번 — 페이지 캡처]",
  ].join("\n\n");

  const out = removeTableMarkers(body);
  assert(out.removed === 1, "1개 제거");
  assert(out.removedIndexes.join(",") === "3", `지운 자리 번호는 3 (${out.removedIndexes.join(",")})`);

  // 이미지 배열: 3번은 사라지고 4번이 3번이 된다.
  const images = [{ index: 1, url: "a" }, { index: 2, url: "b" }, { index: 3, url: null }, { index: 4, url: "d" }];
  const shifted = shiftImageIndexes(images, out.removedIndexes);
  assert(shifted.length === 3, `3장이 남아야 한다 (${shifted.length})`);
  assert(shifted.map((i) => i.index).join(",") === "1,2,3", `번호가 1,2,3이어야 한다 (${shifted.map((i) => i.index).join(",")})`);
  assert(shifted[2].url === "d", "4번이었던 것이 3번으로 내려와야 한다");

  // 번호로 붙은 요구사항·직접 주소도 같이 내려간다.
  const urls = shiftIndexedRecord({ "4": "https://example.com/a.jpg" }, out.removedIndexes);
  assert(urls?.["3"] === "https://example.com/a.jpg", `4번 주소가 3번으로 와야 한다 (${JSON.stringify(urls)})`);

  // 지워진 자리에 붙어 있던 값은 버린다.
  const dropped = shiftIndexedRecord({ "3": "표 지워주세요" }, out.removedIndexes);
  assert(dropped === null, "지워진 자리의 값은 남지 않는다");
  console.log("✅ 자리 번호 당기기 - 이미지·요구사항·직접 주소가 함께 이동");
}

{
  // 사람이 지운 자리도 같은 규칙.
  const body = "[IMAGE: A — 웹 검색]\n\n[IMAGE: B — 웹 검색]\n\n[IMAGE: C — 웹 검색]";
  const out = removeMarkersAt(body, [2]);
  assert(out.removed === 1 && out.removedIndexes.join(",") === "2", "2번을 지웠다고 알려야 한다");
  assert(!out.body.includes("B"), "2번 마커가 지워져야 한다");
  const shifted = shiftImageIndexes([{ index: 1 }, { index: 2 }, { index: 3 }], out.removedIndexes);
  assert(shifted.map((i) => i.index).join(",") === "1,2", "1,2로 당겨져야 한다");
  console.log("✅ 사람이 지운 자리도 번호가 당겨진다");
}

console.log("\n🎉 표 마커 제거 테스트 통과");
