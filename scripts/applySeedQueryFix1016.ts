// 시드 `스틸` 교체 (2026-10-16 사용자 승인).
//
// 왜: run #158(10/15 18시) Top 10에서 `스틸` 하나가 3칸을 먹었다 - 스틸시리즈(게이밍 기어)
// 3위, 포항스틸러스 6위, 스틸 대미투자 7위. 전부 비엔터다. 최근 2주 엔터 Top 10 260행 중
// `스틸` 유래는 이 3건이 전부이고 **정당한 엔터 공급은 0건**이었다 - 순수 손실 시드다.
//
// 교체어를 `드라마 스틸컷`이 아니라 `공식 스틸`로 잡은 이유(사용자 결정): 영화·방송 보도자료도
// "공식 스틸"이라는 표현을 쓴다. 드라마로 한정하면 영화·예능 스틸 공개 기사를 놓친다.
//
// 실행: npm run seeds:apply-1016            (대조만, 쓰기 없음)
//       npm run seeds:apply-1016 -- --apply (실제 UPDATE)
// 되돌리기: keyword를 "스틸"로 되돌리는 UPDATE 1회. 행 삭제·INSERT 없다.
import "dotenv/config";

import { supabase as sb } from "../src/services/supabase/client.js";

const RENAME: { from: string; category: string; to: string }[] = [
  { from: "스틸", category: "ott", to: "공식 스틸" },
];

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const { data: rows, error } = await sb
    .from("seed_queries")
    .select("id, keyword, category, priority, status")
    .in("category", ["entertainment", "ott"]);
  if (error) throw error;

  const find = (keyword: string, category: string) =>
    (rows ?? []).find((r) => r.keyword === keyword && r.category === category);

  let blocked = 0;
  console.log(`▶ ${apply ? "적용" : "대조만(쓰기 없음)"} / ent·ott 시드 ${rows?.length ?? 0}건\n`);

  for (const r of RENAME) {
    const row = find(r.from, r.category);
    const collision = find(r.to, r.category);
    if (!row && collision) { console.log(`  = 적용됨: "${r.to}"`); continue; }
    if (!row) { console.log(`  ✗ 없음: "${r.from}"(${r.category}) - 건너뜀`); blocked++; continue; }
    if (row.status !== "active") { console.log(`  ✗ active 아님: "${r.from}" status=${row.status} - 건너뜀`); blocked++; continue; }
    if (collision) { console.log(`  ✗ 충돌: "${r.to}"가 이미 있다 - 건너뜀`); blocked++; continue; }
    console.log(`  "${r.from}" -> "${r.to}" (${r.category}, p${row.priority})`);
    if (apply) {
      const { error: ue } = await sb.from("seed_queries").update({ keyword: r.to }).eq("id", row.id);
      if (ue) throw ue;
    }
  }

  if (blocked > 0) console.log(`\n⚠️ 건너뛴 항목 ${blocked}건 - 위 사유 확인 필요`);
  if (!apply) { console.log("\n대조만 했다. 실제 적용은 -- --apply"); return; }

  const { data: after, error: ae } = await sb
    .from("seed_queries")
    .select("keyword, category")
    .in("category", ["entertainment", "ott"])
    .eq("status", "active")
    .order("category", { ascending: true });
  if (ae) throw ae;
  console.log(`\n--- 적용 후 active ${after?.length ?? 0}건 ---`);
  for (const cat of ["entertainment", "ott"]) {
    const list = (after ?? []).filter((r) => r.category === cat);
    console.log(`  ${cat} (${list.length}건): ${list.map((r) => r.keyword).join(", ")}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
