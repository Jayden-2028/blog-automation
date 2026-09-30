// 순위 출처 등록부 무결성 테스트. 외부 사이트를 열지 않는다.
// (2026-09-30: 표 이미지 렌더 경로를 폐지해 "본문 데이터로 그리는 폴백" 테스트는 사라졌다. 순위 화면은
//  `페이지 캡처`(capturePagesForJob → capturePageImage)로만 찍는다.)

import { RANKING_SOURCES } from "./captureRankingImage.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

assert(RANKING_SOURCES.length >= 2, "펀덱스·CGV 두 출처가 등록돼 있어야 한다");
assert(RANKING_SOURCES.every((s) => /^https:\/\//.test(s.url) && s.attribution), "출처마다 URL과 표기가 있어야 한다");
assert(RANKING_SOURCES.some((s) => s.id === "tv-buzz") && RANKING_SOURCES.some((s) => s.id === "box-office"), "tv-buzz·box-office");
console.log("✅ 순위 출처 등록부 - URL·출처 표기");
console.log("\n🎉 순위 출처 테스트 통과");
