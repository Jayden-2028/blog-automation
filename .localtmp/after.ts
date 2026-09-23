import "dotenv/config";
import { supabase } from "../src/services/supabase/client.js";
const { data } = await supabase.from("article_jobs").select("metadata")
  .eq("id","079ae8dd-2960-486d-a156-86b3ed39edfb").single();
const m = data!.metadata as any;
for (const i of (m.images ?? [])) {
  console.log(`[${i.index}] ${(i.provider ?? "빔").padEnd(5)} ${i.url ? "채움" : "비어있음"}`);
  console.log(`     캡션: ${i.description ?? "-"}`);
  if (i.sourcePage) console.log(`     출처: ${i.sourcePage}`);
  if (i.url) console.log(`     파일: ${i.url}`);
}
console.log("\n=== 수집 로그 ===");
for (const f of (m.imageFailures ?? [])) console.log(" -", f);
