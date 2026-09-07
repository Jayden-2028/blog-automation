import { excludeCandidateInserts } from "./excludeCandidateInserts.js";
import type { TrendCandidateInsert } from "../../types/database.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

function row(keyword: string, category: string): TrendCandidateInsert {
  return {
    keyword,
    keyword_normalized: keyword.toLowerCase(),
    topic: category,
    topic_normalized: category,
    trend_date: "2026-09-07",
    rank: 1,
    movement_type: "new",
  };
}

function main(): void {
  console.log("▶ excludeCandidateInserts 테스트 시작\n");

  const rows: TrendCandidateInsert[] = [
    row("아기 이유식 거부", "parenting"),
    row("국민의힘 지지율", "living"),
    row("캣맘 새덕후 청원", "community"),
    row("넷플릭스 신작 공개", "ott"),
  ];

  const { rows: kept, excludedCount } = excludeCandidateInserts(rows);

  assert(excludedCount === 2, `제외 2건이어야 한다 (${excludedCount})`);
  assert(kept.length === 2, `남는 건 2건이어야 한다 (${kept.length})`);
  assert(kept.every((r) => r.topic_normalized !== "parenting"), "육아 카테고리는 남으면 안 된다");
  assert(!kept.some((r) => r.keyword.includes("국민의힘")), "정치 키워드는 남으면 안 된다");
  assert(kept.some((r) => r.keyword.includes("캣맘")), "비정치 사회 이슈는 남아야 한다");
  assert(kept.some((r) => r.keyword.includes("넷플릭스")), "연예/OTT는 남아야 한다");

  console.log("✅ 육아 카테고리·정치 키워드만 걸러지고 나머지는 유지된다");
  console.log("\n✅ 전체 통과");
}

main();
