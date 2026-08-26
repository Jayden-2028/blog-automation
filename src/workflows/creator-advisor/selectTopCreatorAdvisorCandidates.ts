// Creator Advisor 후보(최대 120개 안팎) 중 NAVER API 검증 대상 + Daily Query Pool에 투입할
// 상위 후보를 고르는 diversity selection.
//
// 기존 ranking diversity 로직(workflows/keyword-ranking/selectDiverseTopN.ts)은 재사용하지 않는다 -
// 그건 6-factor 최종 score 기준 Top N 선정용이고, 이건 candidate_score 기준으로 "1차로 얼마나 넓게
// NAVER API 검증을 보낼지"를 고르는 완전히 별개의 목적이라 억지로 공유하면 두 관심사가 얽힌다.
//
// 알고리즘: topic별로 candidate_score 내림차순 정렬한 뒤, topic들을 순회하며 한 번에 1개씩
// round-robin으로 뽑는다(topic당 maxPerTopic에 도달하면 그 topic은 건너뜀) - 전체를 candidate_score
// 하나로만 정렬해서 앞에서 자르면 점수가 높은 소수 topic이 독식할 수 있으므로, 항상 여러 topic이
// 골고루 섞이게 한다.

import { CREATOR_ADVISOR_CONFIG } from "../../config/creatorAdvisor.js";

export type SelectableCreatorAdvisorCandidate = {
  topic: string;
  candidateScore: number;
};

export type SelectTopCreatorAdvisorCandidatesOptions = {
  /** 전체 최대 선택 개수. 기본 CREATOR_ADVISOR_CONFIG.maxDailyCandidates(40). */
  maxTotal?: number;
  /** topic 하나가 차지할 수 있는 최대 개수. 기본 CREATOR_ADVISOR_CONFIG.maxCandidatesPerTopic(6). */
  maxPerTopic?: number;
};

export function selectTopCreatorAdvisorCandidates<T extends SelectableCreatorAdvisorCandidate>(
  candidates: T[],
  options: SelectTopCreatorAdvisorCandidatesOptions = {}
): T[] {
  const maxTotal = options.maxTotal ?? CREATOR_ADVISOR_CONFIG.maxDailyCandidates;
  const maxPerTopic = options.maxPerTopic ?? CREATOR_ADVISOR_CONFIG.maxCandidatesPerTopic;

  const byTopic = new Map<string, T[]>();
  for (const candidate of candidates) {
    const list = byTopic.get(candidate.topic);
    if (list) {
      list.push(candidate);
    } else {
      byTopic.set(candidate.topic, [candidate]);
    }
  }
  for (const list of byTopic.values()) {
    list.sort((a, b) => b.candidateScore - a.candidateScore);
  }

  const topics = [...byTopic.keys()];
  const cursorByTopic = new Map(topics.map((topic) => [topic, 0]));
  const countByTopic = new Map(topics.map((topic) => [topic, 0]));
  const selected: T[] = [];

  let progressed = true;
  while (selected.length < maxTotal && progressed) {
    progressed = false;
    for (const topic of topics) {
      if (selected.length >= maxTotal) break;

      const count = countByTopic.get(topic)!;
      if (count >= maxPerTopic) continue;

      const cursor = cursorByTopic.get(topic)!;
      const list = byTopic.get(topic)!;
      if (cursor >= list.length) continue;

      selected.push(list[cursor]);
      cursorByTopic.set(topic, cursor + 1);
      countByTopic.set(topic, count + 1);
      progressed = true;
    }
  }

  return selected;
}
