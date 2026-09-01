import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const { data: j } = await s.from("article_jobs").select("*").eq("id","b374133f-bbba-406f-9533-405d5c71dc1f").single();
console.log("status:", j.status, "updated:", j.updated_at);
console.log("metadata:", JSON.stringify(j.metadata,null,1));
const { data: src } = await s.from("sources").select("id,authority,source_name,url").eq("job_id",j.id);
console.log("sources:", src?.length, JSON.stringify(src?.slice(0,3)));
