import { supabase } from "./client.js";

async function main() {
  const { data, error } = await supabase
    .from("keywords")
    .select("*")
    .limit(5);

  if (error) {
    console.error("❌ keywords 테이블 조회 실패:", error.message);
    process.exit(1);
  }

  console.log(`✅ keywords 테이블 조회 성공 (${data?.length ?? 0}건)`);
  console.log(data);
}

main();
