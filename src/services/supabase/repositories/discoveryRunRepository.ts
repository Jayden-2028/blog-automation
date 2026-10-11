import { supabase } from "../client.js";
import { isKeywordSelectionRunKind } from "../../../config/discoveryRunKinds.js";
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
//
// 2026-10-11: 한 건만 읽지 않고 최근 몇 건을 읽어 **알림 전용 run(핫이슈 스타)은 건너뛴다.** 그 run은
// keyword_rankings가 없어서, 19시 이후 `npm run notify:keywords`(runId 생략) 재발송이 그걸 집으면
// 조용히 no_data로 끝난다. kind로 거르는 판정은 config/discoveryRunKinds.ts 한 곳에 있다.
// jsonb 조건을 SQL로 쓰지 않는 이유: metadata가 null인 옛 run이 `metadata->>kind not in (...)`에서
// 통째로 사라진다(NULL 비교).
const LATEST_RUN_SCAN_LIMIT = 5;

export async function getLatestCompletedDiscoveryRun(): Promise<DiscoveryRunRow | null> {
  const { data, error } = await supabase
    .from("discovery_runs")
    .select("*")
    .eq("status", "completed")
    .order("started_at", { ascending: false })
    .limit(LATEST_RUN_SCAN_LIMIT);

  if (error) throw error;
  return (data ?? []).find((run) => isKeywordSelectionRunKind(run.metadata?.kind)) ?? null;
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
