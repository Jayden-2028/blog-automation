// buildFactCard / summarizeSourcesByAuthority 테스트. 순수 함수만 검증한다.

import { buildFactCard, summarizeSourcesByAuthority } from "./buildFactCard.js";
import type { SourceRow } from "../../types/database.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

function makeSource(overrides: Partial<SourceRow>): SourceRow {
  return {
    id: 1,
    keyword_id: null,
    job_id: "job-1",
    title: "제목",
    url: "https://example.com",
    source_name: "naver_web",
    authority: "community",
    published_at: null,
    content: "내용",
    created_at: "2026-08-27T00:00:00.000Z",
    ...overrides,
  };
}

function main(): void {
  console.log("▶ buildFactCard / summarizeSourcesByAuthority 테스트 시작\n");

  // 1) 등급 개수 집계.
  const sources = [
    makeSource({ id: 1, authority: "official" }),
    makeSource({ id: 2, authority: "official" }),
    makeSource({ id: 3, authority: "medical" }),
    makeSource({ id: 4, authority: "news" }),
    makeSource({ id: 5, authority: "community" }),
    makeSource({ id: 6, authority: null }),
  ];
  const summary = summarizeSourcesByAuthority(sources);
  assert(summary.total === 6, `total은 6이어야 한다 (실제: ${summary.total})`);
  assert(summary.countByAuthority.official === 2, "official 2건이어야 한다");
  assert(summary.countByAuthority.unknown === 1, "등급 null은 unknown으로 집계돼야 한다");
  console.log("✅ 등급별 집계 정확");

  // 2) 근거가 없으면 "단정하지 말라"는 안내를 반환한다(원고가 없는 사실을 지어내지 않게).
  const empty = buildFactCard([]);
  assert(empty.includes("단정하지"), "근거 없음 안내에 '단정하지'가 포함돼야 한다");
  console.log("✅ 근거 없음 -> 단정 금지 안내");

  // 3) 등급 표시 + 정렬(official이 community보다 먼저 와야 한다 - 신뢰도 높은 근거를 앞에 배치).
  const mixed = [
    makeSource({ id: 1, authority: "community", title: "커뮤니티 글" }),
    makeSource({ id: 2, authority: "official", title: "국세청 공지" }),
  ];
  const card = buildFactCard(mixed);
  const officialIndex = card.indexOf("국세청 공지");
  const communityIndex = card.indexOf("커뮤니티 글");
  assert(officialIndex !== -1 && communityIndex !== -1, "두 항목 모두 카드에 포함돼야 한다");
  assert(officialIndex < communityIndex, "official 등급이 community보다 먼저 나와야 한다");
  assert(card.includes("공공(정부/공식기관)"), "등급 라벨이 사람이 읽을 수 있는 형태로 표시돼야 한다");
  assert(card.includes("커뮤니티/블로그"), "community 라벨도 표시돼야 한다");
  console.log("✅ official 우선 정렬 + 등급 라벨 표시");

  // 4) url/content가 없어도 죽지 않는다(방어적 처리).
  const sparse = buildFactCard([makeSource({ url: null, content: null, published_at: null })]);
  assert(sparse.length > 0, "필드가 비어 있어도 카드는 만들어져야 한다");
  console.log("✅ 필드 누락에도 안전하게 처리");

  console.log("\n✅ buildFactCard / summarizeSourcesByAuthority 테스트 완료");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
