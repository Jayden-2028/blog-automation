// 핫이슈 스타 "✍️ 인물글" 버튼(pgo:<run_id>:<rank>)이 가리키는 인물을 읽는다(인물 백과 트랙, 2026-10-13).
//
// 출처는 keyword_rankings가 아니라 discovery_runs.metadata.people[]다 - 핫이슈 스타 run은 알림 전용이라
// keyword_rankings 행을 만들지 않는다(config/discoveryRunKinds.ts). go:/pass:가 keyword_rankings 조회 실패를
// "위조/만료"로 거부하는 것과 같은 구조로, 여기서도 **조회되지 않으면 null**이고 호출자는 거부한다.
// kind가 핫이슈 스타가 아닌 run을 가리키는 위조 callback_data(pgo:<다른 run>:…)도 null이다.

import { HOT_STAR_RUN_KIND } from "../../config/discoveryRunKinds.js";
import { getDiscoveryRunById } from "../../services/supabase/repositories/discoveryRunRepository.js";
import type { DiscoveryRunRow } from "../../types/database.js";

export type HotStarPersonRef = {
  runId: number;
  rank: number;
  name: string;
  /** 화제 배경 한 줄. 이 저장 방식 도입 전에 만든 run은 빈 문자열이다. */
  background: string;
};

/** run.metadata에서 rank번 인물을 꺼낸다. 순수 함수 - 테스트에서 DB 없이 쓴다. */
export function pickHotStarPerson(run: Pick<DiscoveryRunRow, "id" | "metadata"> | null, rank: number): HotStarPersonRef | null {
  if (!run || run.metadata?.kind !== HOT_STAR_RUN_KIND) return null;
  const people = run.metadata.people;
  if (!Array.isArray(people)) return null;

  for (const entry of people) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as { rank?: unknown; name?: unknown; background?: unknown };
    if (candidate.rank !== rank) continue;
    const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
    if (!name) return null;
    const background = typeof candidate.background === "string" ? candidate.background.trim() : "";
    return { runId: run.id, rank, name, background };
  }
  return null;
}

export async function loadHotStarPerson(runId: number, rank: number): Promise<HotStarPersonRef | null> {
  return pickHotStarPerson(await getDiscoveryRunById(runId), rank);
}
