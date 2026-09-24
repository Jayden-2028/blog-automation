// 표 마커 제거 테스트. 실행: npm run test:remove-table-markers
//
// 지켜야 할 것: ① 표 마커와 그 프롬프트를 함께 지운다 ② 다른 마커는 건드리지 않는다
// ③ 빈 줄이 겹치지 않는다 ④ 지울 게 없으면 원본 그대로
import { removeTableMarkers } from "./removeTableMarkers.js";

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

console.log("\n🎉 표 마커 제거 테스트 통과");
