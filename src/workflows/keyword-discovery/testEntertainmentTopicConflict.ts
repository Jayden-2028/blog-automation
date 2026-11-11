// 엔터 topic 라벨 충돌 회귀 테스트(2026-11-11, KEYWORD-ENT-REDESIGN-2026-11.md R2).
// 외부 호출 없는 순수 함수만 검증한다. 재료는 2026-11-10 run 260의 trend_candidates 실측값이다.

import { ENT_TOPIC_CONFLICT_CONFIG } from "../../config/entertainmentTopicConflict.js";
import type { QueryPoolEntry } from "./buildDailyQueryPool.js";
import { evaluateEntertainmentTopicConflict } from "./entertainmentTopicConflict.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

function trendEntry(keyword: string, category = "entertainment"): QueryPoolEntry {
  return { keyword, category, priority: 3, origin: "creator_advisor", source: "creator_advisor", metadata: {} };
}

function seedEntry(keyword: string): QueryPoolEntry {
  return { keyword, category: "entertainment", priority: 5, origin: "seed", source: null, metadata: {} };
}

// 2026-11-09 trend_candidates 실측(run 260이 읽은 날짜). 같은 키워드가 여러 카드에 동시에 올라온다.
const TOPICS: Record<string, string[]> = {
  "젠슨 황 불륜": ["비즈니스·경제", "방송"],
  앨리스황: ["사회·정치", "방송", "비즈니스·경제"],
  엘리스황: ["사회·정치", "비즈니스·경제", "스타·연예인"],
  // 엔터 카드 하나만 - 충돌 아님(실측에서도 이 키워드는 스타·연예인 한 행뿐이었다).
  "젠슨 황 불륜 인정": ["스타·연예인"],
  // 정상 엔터 후보. 엔터 카드에만 올라온다.
  이세계아이돌: ["스타·연예인", "방송"],
  "닥터X 10회 시청률 17.7% 돌파": ["드라마"],
  // 커뮤니티 소스. topic이 어느 목록에도 없으므로 신호를 만들지 않는다(더쿠는 연예 커뮤니티다).
  "맹승지 개그우먼 은퇴 선언": ["community", "스타·연예인"],
  // 제외 어휘로 남긴 grab-bag 카드. 비엔터 증거로 쓰지 않는다.
  "생활의달인 남대문 스카프 달인 출연": ["일상·생각", "방송"],
};

function main(): void {
  console.log("▶ entertainmentTopicConflict 테스트 시작\n");

  const entries = [
    trendEntry("젠슨 황 불륜"),
    trendEntry("앨리스황"),
    trendEntry("엘리스황"),
    trendEntry("젠슨 황 불륜 인정"),
    trendEntry("이세계아이돌"),
    trendEntry("닥터X 10회 시청률 17.7% 돌파", "ott"),
    trendEntry("맹승지 개그우먼 은퇴 선언"),
    trendEntry("생활의달인 남대문 스카프 달인 출연"),
  ];

  // ---------- preview(기본값): 판정만 하고 아무것도 빼지 않는다 ----------
  const preview = evaluateEntertainmentTopicConflict(entries, { topicsByKeyword: TOPICS });
  assert(preview.applied === false, "기본값은 apply=false다(ENT_TOPIC_CONFLICT_DROP 미설정)");
  assert(preview.entries.length === entries.length, "preview는 entry를 하나도 빼지 않는다");
  assert(preview.evaluated === entries.length, `동적 entry 전부를 본다 (${preview.evaluated})`);

  const conflicted = preview.conflicts.map((verdict) => verdict.keyword).sort();
  assert(
    JSON.stringify(conflicted) === JSON.stringify(["앨리스황", "엘리스황", "젠슨 황 불륜"]),
    `충돌 3건만 잡아야 한다: ${JSON.stringify(conflicted)}`
  );
  console.log("✅ preview는 판정만 한다 — 실측 충돌 3건(젠슨 황 불륜·앨리스황·엘리스황)");

  const jensen = preview.conflicts.find((verdict) => verdict.keyword === "젠슨 황 불륜");
  assert(jensen?.entertainmentTopics.includes("방송"), "충돌 근거에 엔터 카드가 남아야 한다");
  assert(jensen?.nonEntertainmentTopics.includes("비즈니스·경제"), "충돌 근거에 비엔터 카드가 남아야 한다");
  console.log("✅ 판정 근거(어느 카드 때문인지)가 verdict에 남는다");

  // ---------- 충돌이 아닌 것들 ----------
  assert(!conflicted.includes("젠슨 황 불륜 인정"), "엔터 카드만 있으면 충돌이 아니다");
  assert(!conflicted.includes("이세계아이돌"), "엔터 카드만 있는 정상 후보를 건드리면 안 된다");
  assert(
    !conflicted.includes("맹승지 개그우먼 은퇴 선언"),
    "community처럼 어느 목록에도 없는 topic은 비엔터 증거가 아니다"
  );
  assert(
    !conflicted.includes("생활의달인 남대문 스카프 달인 출연"),
    "`일상·생각`은 grab-bag이라 비엔터 증거 목록에서 빼 뒀다"
  );
  console.log("✅ 엔터 전용·미등록 topic·grab-bag 카드는 충돌로 보지 않는다");

  // ---------- apply: 충돌만 뺀다 ----------
  const applied = evaluateEntertainmentTopicConflict(entries, {
    topicsByKeyword: TOPICS,
    config: { ...ENT_TOPIC_CONFLICT_CONFIG, apply: true },
  });
  assert(applied.applied === true, "apply=true가 반영돼야 한다");
  assert(applied.entries.length === entries.length - 3, `충돌 3건만 빠져야 한다 (${applied.entries.length})`);
  assert(
    !applied.entries.some((entry) => entry.keyword === "앨리스황"),
    "충돌 키워드는 풀에서 빠진다"
  );
  assert(
    applied.entries.some((entry) => entry.keyword === "이세계아이돌"),
    "정상 엔터 후보는 남는다"
  );
  console.log("✅ apply는 충돌만 뺀다(정상 후보 보존)");

  // ---------- seed/merged는 범위 밖 ----------
  const seedOnly = evaluateEntertainmentTopicConflict([seedEntry("젠슨 황 불륜")], {
    topicsByKeyword: TOPICS,
    config: { ...ENT_TOPIC_CONFLICT_CONFIG, apply: true },
  });
  assert(seedOnly.evaluated === 0, "seed_queries 유래는 판정 대상이 아니다");
  assert(seedOnly.entries.length === 1, "seed_queries 유래는 버리지 않는다");
  console.log("✅ 사람이 큐레이션한 시드는 건드리지 않는다(시드 자체를 고치는 쪽이 옳다)");

  // ---------- topic 정보가 없으면 아무 일도 하지 않는다 ----------
  const noTopics = evaluateEntertainmentTopicConflict(entries, {
    topicsByKeyword: {},
    config: { ...ENT_TOPIC_CONFLICT_CONFIG, apply: true },
  });
  assert(noTopics.conflicts.length === 0, "topic 정보가 없으면 충돌로 보지 않는다");
  assert(noTopics.entries.length === entries.length, "topic 정보가 없으면 아무것도 빼지 않는다");
  console.log("✅ topic 정보 없음을 「비엔터」로 오판하지 않는다");

  console.log("\n✅ 전체 통과");
}

main();
