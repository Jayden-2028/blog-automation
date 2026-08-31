import "dotenv/config";
import { supabase as sb } from "../../../services/supabase/client.js";

const JOB_ID = "753d9af8-9d2d-4179-bf3f-139fa62ba813"; // 보조금24 - Sprint 3 테스트 잔재(placeholder 이미지)

const { data: before } = await sb.from("article_jobs").select("id,keyword,status").eq("id", JOB_ID).single();
console.log("before:", JSON.stringify(before));

const { data: after, error } = await sb
  .from("article_jobs")
  .update({ status: "published", metadata: { closedReason: "sprint3-test-artifact; placeholder image; not for real publish (2026-08-31)" } })
  .eq("id", JOB_ID)
  .select("id,keyword,status")
  .single();
console.log("error:", JSON.stringify(error));
console.log("after:", JSON.stringify(after));

// 관련 article도 published로(폴러가 다시 집지 않게)
const { data: arts } = await sb.from("articles").update({ status: "published" }).eq("job_id", JOB_ID).select("id,status");
console.log("articles:", JSON.stringify(arts));
