import { supabase } from "../client.js";
import type {
  DiscoveryRunInsert,
  DiscoveryRunRow,
  DiscoveryRunUpdate,
} from "../../../types/database.js";

export async function createDiscoveryRun(
  input: DiscoveryRunInsert
): Promise<DiscoveryRunRow> {
  const { data, error } = await supabase
    .from("discovery_runs")
    .insert(input)
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function getDiscoveryRunById(id: number): Promise<DiscoveryRunRow | null> {
  const { data, error } = await supabase
    .from("discovery_runs")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) throw error;
  return data;
}

export async function updateDiscoveryRun(
  id: number,
  patch: DiscoveryRunUpdate
): Promise<DiscoveryRunRow> {
  const { data, error } = await supabase
    .from("discovery_runs")
    .update(patch)
    .eq("id", id)
    .select()
    .single();

  if (error) throw error;
  return data;
}

// keyword-notification 워크플로우가 "오늘의 Top10"을 조회할 기준 run을 찾는 데 쓴다.
// status='completed'만 대상으로 해서, 저장 중 실패한(failed) run이나 아직 진행 중인 run은 제외한다.
export async function getLatestCompletedDiscoveryRun(): Promise<DiscoveryRunRow | null> {
  const { data, error } = await supabase
    .from("discovery_runs")
    .select("*")
    .eq("status", "completed")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data;
}

export async function listRecentDiscoveryRuns(limit = 20): Promise<DiscoveryRunRow[]> {
  const { data, error } = await supabase
    .from("discovery_runs")
    .select("*")
    .order("started_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data ?? [];
}
