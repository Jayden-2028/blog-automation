// A-2 단독 일반어 시드 정비 (KEYWORD-ENT-PURITY-2026-10.md A-2-3, 2026-10-13 사용자 승인).
// 교체 13건(keyword UPDATE) + 비활성 8건(status='paused' UPDATE). **행 삭제는 없다** - 되돌리기가 1:1이다.
// status는 seed_queries_status_check가 active|paused|archived만 받는다(20260825120000_seed_queries.sql).
// archived가 아니라 paused를 쓴다 - 되돌리기가 한 번의 UPDATE로 끝나야 한다.
// 두 번 실행해도 안전하다(이미 적용된 항목은 "적용됨"으로 건너뛴다).
//
// 실행: npm run seeds:apply-purity           (대조만, 쓰기 없음)
//       npm run seeds:apply-purity -- --apply (실제 UPDATE)
//
// 되돌리기: docs/ai-handoff/ENT_KEYWORD_PURITY_2026-10-13.md A-2-4의 백업 값으로 역방향 UPDATE.
import "dotenv/config";

import { supabase as sb } from "../src/services/supabase/client.js";

const RENAME: { from: string; category: string; to: string }[] = [
  { from: "화보", category: "entertainment", to: "스타 화보" },
  { from: "논란", category: "entertainment", to: "연예계 논란" },
  { from: "발매", category: "entertainment", to: "신곡 발매" },
  { from: "결혼", category: "entertainment", to: "스타 결혼" },
  { from: "수상", category: "entertainment", to: "시상식 수상" },
  { from: "차트", category: "entertainment", to: "음원 차트" },
  { from: "무대", category: "entertainment", to: "컴백 무대" },
  { from: "이혼", category: "entertainment", to: "연예인 이혼" },
  { from: "공개", category: "ott", to: "드라마 공개" },
  { from: "공개일", category: "ott", to: "드라마 공개일" },
  { from: "원작", category: "ott", to: "웹툰 원작" },
  { from: "호평", category: "ott", to: "드라마 호평" },
  { from: "웨이브", category: "ott", to: "웨이브 오리지널" },
];

const DEACTIVATE: { keyword: string; category: string }[] = [
  { keyword: "이슈", category: "entertainment" },
  { keyword: "실체", category: "entertainment" },
  { keyword: "방송", category: "entertainment" },
  { keyword: "변신", category: "entertainment" },
  { keyword: "이상형", category: "entertainment" },
  { keyword: "순위", category: "entertainment" },
  { keyword: "미담", category: "entertainment" },
  { keyword: "출연진", category: "ott" },
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

  console.log("--- 교체 13건 ---");
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

  console.log("\n--- 비활성 8건 ---");
  for (const d of DEACTIVATE) {
    const row = find(d.keyword, d.category);
    if (!row) { console.log(`  ✗ 없음: "${d.keyword}"(${d.category}) - 건너뜀`); blocked++; continue; }
    if (row.status !== "active") { console.log(`  = 이미 ${row.status}: "${d.keyword}"`); continue; }
    console.log(`  "${d.keyword}" (${d.category}, p${row.priority}) -> paused`);
    if (apply) {
      const { error: ue } = await sb.from("seed_queries").update({ status: "paused" }).eq("id", row.id);
      if (ue) throw ue;
    }
  }

  if (blocked > 0) console.log(`\n⚠️ 건너뛴 항목 ${blocked}건 - 위 사유 확인 필요`);
  if (!apply) { console.log("\n대조만 했다. 실제 적용은 -- --apply"); return; }

  const { data: after, error: ae } = await sb
    .from("seed_queries")
    .select("keyword, category, priority, status")
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
