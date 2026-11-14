// 사용설명서 트랙이 "이미 쓴/제안한 주제"를 모을 때 쓰는 **순수 판정**(2026-11-14).
// DB 접근은 runKoreaplainTopicCollection의 defaultLoadExistingTopics가 하고, 여기서는 받아 온 행을 거르기만 한다 -
// 네트워크 없이 tsx 테스트로 단정할 수 있어야 하기 때문이다.
//
// 📌 "중복"의 정의(2026-11-14 사용자 요청 "중복 키워드가 없도록 합시다"):
//   ① **이미 job이 된 주제**(기발행·집필 중·조사 중) - 다시 제안하지 않는다. **기간 제한이 없다.**
//      단 `rejected`는 사람이 버린 것이므로 다시 올라와도 된다(기존 동작 유지).
//   ② **제안만 하고 고르지 않은 주제** - `proposalMemoryDays`(60일) 동안 다시 제안하지 않는다.
//      시드가 241개뿐이라 영구히 막으면 몇 달 뒤 뽑을 것이 없어진다. 60일이면 Pass한 주제가
//      두 달 뒤 한 번 더 보이는 정도다.
//   ③ 같은 **알림 안**의 중복은 selectTopics가 같은 규칙(isDuplicateTopic)으로 거른다.
//
// 📌 **기억 창이 잘리면 조용히 넘기지 않는다.** 읽을 수 있는 행 수에 상한이 있어, 운영이 커지면
// 기억 기간(60일)을 덮지 못하는 날이 온다. 그때 중복 제거는 "되는 것처럼 보이면서" 약해진다 -
// 이 파이프라인에서 가장 나쁜 실패 양식이라, 경고 문구를 돌려주고 알림 헤더에 적는다.

import { KOREAPLAIN_TRACK } from "../../config/koreaplainTrack.js";

/** article_jobs에서 필요한 조각만. metadata.track이 트랙 판정의 근거다(없으면 엔터 - trackOfJob과 같다). */
export type KoreaplainJobRow = {
  keyword: string;
  status?: string | null;
  metadata?: unknown;
};

/** discovery_runs에서 필요한 조각만. */
export type KoreaplainRunRow = {
  id: number;
  started_at: string;
  metadata?: { kind?: unknown } | null;
};

/** 사용설명서 run의 kind(runKoreaplainTopicCollection.KOREAPLAIN_JOB_KIND와 같은 값). */
export const KOREAPLAIN_RUN_KIND = "kscene_topic";

function trackOf(metadata: unknown): string | null {
  if (metadata && typeof metadata === "object") {
    const raw = (metadata as Record<string, unknown>).track;
    if (typeof raw === "string") return raw;
  }
  return null;
}

/**
 * 사용설명서 트랙 job의 키워드만. 엔터·사회·인물 job은 **주제 공간이 달라** 섞으면 안 된다
 * (한국어 키워드가 영문 주제의 중복 판정에 들어가면 토큰이 하나도 안 겹쳐 무해해 보이지만,
 * 트랙이 섞이기 시작하면 어느 트랙 때문에 걸렸는지 설명할 수 없게 된다).
 */
export function koreaplainJobTopics(rows: readonly KoreaplainJobRow[]): string[] {
  return rows
    .filter((row) => trackOf(row.metadata) === KOREAPLAIN_TRACK && row.status !== "rejected")
    .map((row) => row.keyword)
    .filter((keyword): keyword is string => Boolean(keyword));
}

export type KoreaplainProposalRunSelection = {
  runIds: number[];
  /** 기억 창이 잘렸을 때의 경고(알림 헤더로 간다). 평소에는 빈 배열이다. */
  warnings: string[];
};

/**
 * 기억 기간 안의 사용설명서 run id. `rows`는 **최신순**으로 들어온다고 본다.
 *
 * `limit`은 그 행을 읽어 온 질의의 상한이다. 돌려받은 행이 상한만큼이고 그중 가장 오래된 것이
 * 아직 기억 기간 안이면 **더 오래된 run이 잘렸다는 뜻**이라 경고를 남긴다.
 */
export function koreaplainProposalRuns(
  rows: readonly KoreaplainRunRow[],
  cutoffMs: number,
  limit: number
): KoreaplainProposalRunSelection {
  const runIds: number[] = [];
  let oldestSeen = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    const startedAt = Date.parse(row.started_at);
    if (Number.isFinite(startedAt)) oldestSeen = Math.min(oldestSeen, startedAt);
    if (row.metadata?.kind !== KOREAPLAIN_RUN_KIND) continue;
    if (!Number.isFinite(startedAt) || startedAt < cutoffMs) continue;
    runIds.push(row.id);
  }

  const truncated = rows.length >= limit && oldestSeen >= cutoffMs;
  return {
    runIds,
    warnings: truncated
      ? [`⚠️ 중복 기억 창이 잘렸습니다(run ${rows.length}건 상한) — 오래된 제안이 다시 올라올 수 있습니다`]
      : [],
  };
}
