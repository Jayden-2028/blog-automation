// 엔터 트랙 topic 라벨 충돌 판정 (2026-11-11, KEYWORD-ENT-REDESIGN-2026-11.md R2).
// 근거·설계 원칙·어느 카드를 비엔터로 보는지는 config/entertainmentTopicConflict.ts 상단에 있다.
//
// 외부 호출 없는 순수 함수다. 판정만 하고 아무것도 저장하지 않는다 - 적용 여부는 호출자가 정한다.
// 판정 재료는 그날 trend_candidates에 이미 들어 있는 **원본 topic 카드 제목**뿐이다.
//
// ---------- 2026-11-11 교정: 엔터 증거를 CA 카드로만 보지 않는다 ----------
//
// 첫 구현은 충돌 조건을 "엔터 카드가 **있고** 비엔터 카드도 있다"로 걸었다. 그런데 엔터 카드 제목을
// 주는 소스는 Creator Advisor뿐이다 - google_trends·daum_realtime·community·news_feed_ent는 topic이
// 고정 문자열이라(`daum_realtime` 등) 어느 목록에도 들어가지 않는다. 그래서 그 소스에서만 엔터로
// 분류된 시드는 **구조적으로 면제**됐다.
//
// 실측으로 그 구멍이 열려 있다: 2026-11-09에 `젠슨 황 나이`는 daum_realtime에서 왔고
// `젠슨 황 불륜`은 CA `비즈니스·경제`에서 왔다. 전자 같은 행이 classifyKeywordCategory로
// entertainment가 되면 충돌로 안 잡힌다.
//
// 설계안 R2가 적은 규칙은 "같은 keyword_normalized가 같은 날 **비엔터 topic으로도 존재하면** 뺀다"
// 였고 "CA 유래일 때만"이 아니었다. 즉 첫 구현이 설계를 좁게 옮긴 것이다. 지금은 이렇게 본다:
//
//   엔터 증거 = **그 entry가 엔터 풀에 들어와 있다는 사실 자체**다.
//               (entry.category가 entertainment/ott라서 includeCategories를 통과했다)
//   충돌      = 거기에 더해 같은 키워드가 그날 **비엔터 카드**에도 올라왔다.
//
// 비엔터 쪽은 계속 카드 제목만 본다. 고정 topic(`daum_realtime`·`community`)을 비엔터 증거로 쓰면
// 전 분야 소스에서 온 정당한 연예 후보를 전부 죽인다 - 더쿠는 연예 커뮤니티다.
//
// 판정 근거는 verdict에 **어느 소스에서 왔는지까지** 남긴다(entertainmentEvidence). 1주 preview
// 기록으로 적용 여부를 판단할 때 숫자만으로는 못 믿기 때문이다.

import { ENT_TOPIC_CONFLICT_CONFIG } from "../../config/entertainmentTopicConflict.js";
import type { QueryPoolEntry } from "./buildDailyQueryPool.js";

/** 엔터 트랙이 풀에 들이는 category. 호출자가 includeCategories로 넘기는 값과 같아야 한다. */
export const DEFAULT_ENTERTAINMENT_CATEGORIES: readonly string[] = ["entertainment", "ott"];

export type TopicConflictVerdict = {
  keyword: string;
  /**
   * 이 키워드가 그날 올라온 **엔터 카드** 제목. Creator Advisor 유래가 아니면 빈 배열이고,
   * 그때 엔터 증거는 entertainmentEvidence.kind="category"다.
   */
  entertainmentTopics: string[];
  /** 이 키워드가 그날 함께 올라온 비엔터 카드 제목(= 충돌 근거). */
  nonEntertainmentTopics: string[];
  /**
   * 엔터 증거의 출처(2026-11-11). 1주 뒤 이 기록으로 적용 여부를 판단한다.
   *   kind="card"     — CA 엔터 카드(방송·스타·연예인·드라마·영화)에 올라왔다.
   *   kind="category" — 카드는 없고, 풀 entry의 category가 엔터라서 들어왔다(비CA 소스).
   */
  entertainmentEvidence: {
    kind: "card" | "category";
    /** 이 키워드를 풀에 들여보낸 entry의 trend_candidates.source. seed면 null. */
    source: string | null;
    /** 그 entry의 category(entertainment/ott). */
    category: string;
  };
  /** 그날 이 키워드에 붙은 모든 topic. 어느 목록에도 없는 고정 topic까지 포함한다(진단용). */
  allTopics: string[];
};

export type EntTopicConflictResult = {
  /** 판정 대상이 된 entry 수(동적 소스 유래 + 엔터 category만). */
  evaluated: number;
  /** 비엔터 카드에 함께 올라온 키워드. apply를 켜면 이쪽을 뺀다. */
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
  /**
   * 엔터 풀로 보는 category. 생략하면 entertainment/ott.
   *
   * 왜 함수 안에서 한 번 더 보는가: 호출자가 includeCategories 없이 쓰면 categoryScoped가 풀 전체가
   * 되어(dailyKeywordWorkflow) 사회 트랙 후보까지 판정 대상이 된다. 이 판정은 엔터 전용이므로
   * 스스로 범위를 지킨다.
   */
  entertainmentCategories?: readonly string[];
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
  const entCategories = new Set(options.entertainmentCategories ?? DEFAULT_ENTERTAINMENT_CATEGORIES);

  const conflicts: TopicConflictVerdict[] = [];
  const conflicted = new Set<QueryPoolEntry>();
  let evaluated = 0;

  for (const entry of entries) {
    if (!isTrendOrigin(entry.origin)) continue;
    if (!entCategories.has(entry.category)) continue;
    evaluated++;

    const topics = options.topicsByKeyword[normalizeKeyword(entry.keyword)] ?? [];
    const entertainmentTopics = [...new Set(topics.filter((topic) => entSet.has(topic)))];
    const nonEntertainmentTopics = [...new Set(topics.filter((topic) => nonEntSet.has(topic)))];

    // 충돌 = 비엔터 카드가 있다. 엔터 증거는 "이 entry가 엔터 풀에 있다"는 사실로 이미 성립한다
    // (파일 상단 2026-11-11 교정). 비엔터 카드가 없으면 정상 경로이므로 세지 않는다.
    if (nonEntertainmentTopics.length === 0) continue;

    conflicts.push({
      keyword: entry.keyword,
      entertainmentTopics,
      nonEntertainmentTopics,
      entertainmentEvidence: {
        kind: entertainmentTopics.length > 0 ? "card" : "category",
        source: entry.source,
        category: entry.category,
      },
      allTopics: [...new Set(topics)],
    });
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
