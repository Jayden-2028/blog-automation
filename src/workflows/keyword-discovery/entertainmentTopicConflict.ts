// 엔터 트랙 topic 라벨 충돌 판정 (2026-11-11, KEYWORD-ENT-REDESIGN-2026-11.md R2).
// 근거·설계 원칙·어느 카드를 비엔터로 보는지는 config/entertainmentTopicConflict.ts 상단에 있다.
//
// 외부 호출 없는 순수 함수다. 판정만 하고 아무것도 저장하지 않는다 - 적용 여부는 호출자가 정한다.
// 판정 재료는 그날 trend_candidates에 이미 들어 있는 **원본 topic 카드 제목**뿐이다.

import { ENT_TOPIC_CONFLICT_CONFIG } from "../../config/entertainmentTopicConflict.js";
import type { QueryPoolEntry } from "./buildDailyQueryPool.js";

export type TopicConflictVerdict = {
  keyword: string;
  /** 이 키워드가 그날 올라온 엔터 카드 제목. */
  entertainmentTopics: string[];
  /** 이 키워드가 그날 함께 올라온 비엔터 카드 제목(= 충돌 근거). */
  nonEntertainmentTopics: string[];
};

export type EntTopicConflictResult = {
  /** 판정 대상이 된 entry 수(동적 소스 유래만). */
  evaluated: number;
  /** 엔터 카드와 비엔터 카드에 동시에 올라온 키워드. apply를 켜면 이쪽을 뺀다. */
  conflicts: TopicConflictVerdict[];
  /** apply 여부를 반영한 결과 목록. apply=false면 입력과 동일하다. */
  entries: QueryPoolEntry[];
  applied: boolean;
};

export type EvaluateEntTopicConflictOptions = {
  /**
   * 정규화된 키워드 -> 그날 그 키워드가 올라온 **원본 topic 카드 제목** 목록.
   * buildDailyQueryPool이 quota 선별 **전에** 모아 둔 값을 그대로 쓴다(선별 후에는 비엔터 행이
   * 떨어져 충돌 증거가 사라진다).
   */
  topicsByKeyword: Readonly<Record<string, readonly string[]>>;
  /** 테스트에서 config를 덮어쓰기 위한 주입 지점. */
  config?: typeof ENT_TOPIC_CONFLICT_CONFIG;
};

function normalizeKeyword(keyword: string): string {
  return keyword.trim().toLowerCase();
}

/** 동적 소스 유래 entry인지. seed/merged는 사람이 큐레이션한 쪽이라 판정하지 않는다. */
function isTrendOrigin(origin: QueryPoolEntry["origin"]): boolean {
  return origin === "creator_advisor" || origin === "trend";
}

export function evaluateEntertainmentTopicConflict(
  entries: readonly QueryPoolEntry[],
  options: EvaluateEntTopicConflictOptions
): EntTopicConflictResult {
  const config = options.config ?? ENT_TOPIC_CONFLICT_CONFIG;
  const entSet = new Set(config.entertainmentTopics);
  const nonEntSet = new Set(config.nonEntertainmentTopics);

  const conflicts: TopicConflictVerdict[] = [];
  const conflicted = new Set<QueryPoolEntry>();
  let evaluated = 0;

  for (const entry of entries) {
    if (!isTrendOrigin(entry.origin)) continue;
    evaluated++;

    const topics = options.topicsByKeyword[normalizeKeyword(entry.keyword)] ?? [];
    const entertainmentTopics = [...new Set(topics.filter((topic) => entSet.has(topic)))];
    const nonEntertainmentTopics = [...new Set(topics.filter((topic) => nonEntSet.has(topic)))];

    // 충돌은 **양쪽이 다 있을 때**만이다. 비엔터 카드만 있는 키워드는 includeCategories가 이미
    // 걸러내므로 여기서 또 셀 필요가 없고, 엔터 카드만 있으면 정상 경로다.
    if (entertainmentTopics.length === 0 || nonEntertainmentTopics.length === 0) continue;

    conflicts.push({ keyword: entry.keyword, entertainmentTopics, nonEntertainmentTopics });
    conflicted.add(entry);
  }

  const applied = config.apply && conflicted.size > 0;
  return {
    evaluated,
    conflicts,
    entries: applied ? entries.filter((entry) => !conflicted.has(entry)) : [...entries],
    applied: config.apply,
  };
}
