// 엔터 트렌드 게이트 회귀 테스트(KEYWORD-ENT-PURITY-2026-10.md A-3).
// 외부 호출 없는 순수 함수만 검증한다. 실측 사례를 그대로 고정한다.

import { ENT_TREND_GATE_CONFIG } from "../../config/entertainmentTrendGate.js";
import { evaluateEntertainmentTrendGate } from "./entertainmentTrendGate.js";
import type { KeywordCandidate } from "../../types/keywordDiscovery.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

function makeCandidate(keyword: string, query: string): KeywordCandidate {
  return {
    keyword,
    normalizedKey: keyword.toLowerCase(),
    category: "entertainment",
    source: "naver_news",
    trendScore: 0,
    sourceUrl: null,
    publishedAt: null,
    metadata: { query },
  } as KeywordCandidate;
}

function main(): void {
  console.log("▶ entertainmentTrendGate 테스트 시작\n");

  // 실측 사례. seed는 전부 동적 소스(creator_advisor/daum_realtime) 유래로 둔다.
  const TREND_QUERIES = [
    "인천 흉기난동 사건",
    "유지원 러너",
    "김현이",
    "이지혜 성심당 논란",
    "조재복",
    "신인 그룹 오프닝",
  ];

  const candidates = [
    // ① 비엔터 확정 - run #158 8위. classifyKeywordCategory가 "살인"으로 incident를 준다.
    makeCandidate("인천 흉기난동 살인미수 사건 5개월 만에 공개된 CCTV", "인천 흉기난동 사건"),
    // ② 비엔터 확정 - 사회 트랙 run #160 2위 유형.
    makeCandidate("장모 때려 숨지게 한 조재복에 징역 45년 죄의식", "조재복"),
    // ③ 엔터 신호 없음이지만 비엔터도 아님 - strict는 살리고 loose는 죽인다.
    makeCandidate("결승선 500m 앞두고 쓰러진 카이스트 女 러너 세상", "유지원 러너"),
    makeCandidate("이지혜 성심당 싹쓸이 지적에 논란 만드는 이유가 무엇인지?", "이지혜 성심당 논란"),
    // ④ 역할어로 통과 - 추모 기사. 이름을 몰라도 "배우"가 있으면 살아야 한다.
    makeCandidate("액션배우 김현이 교통사고 사망 뒤늦게 알려진 비보", "김현이"),
    // ⑤ 신인·무명 보호 - 이름이 생소해도 역할어가 있으면 통과.
    makeCandidate("무명 5년 끝 신인 그룹 오프닝 첫 음악방송 무대", "신인 그룹 오프닝"),
  ];

  const preview = evaluateEntertainmentTrendGate(candidates, {
    trendQueries: TREND_QUERIES,
    config: { ...ENT_TREND_GATE_CONFIG, previewEnabled: true, apply: false },
  });

  assert(preview.evaluated === 6, `동적 소스 유래 6건을 전부 판정해야 한다 (실제 ${preview.evaluated})`);
  console.log("✅ 동적 소스 유래 후보만 판정 대상");

  const strict = preview.strictDrops.map((d) => d.keyword);
  assert(strict.length === 2, `strict 탈락은 2건이어야 한다 (실제 ${strict.length}: ${strict.join(" / ")})`);
  assert(strict.some((k) => k.includes("인천 흉기난동")), "run #158 8위가 strict로 잡혀야 한다");
  assert(strict.some((k) => k.includes("조재복")), "사건·사고 기사가 strict로 잡혀야 한다");
  console.log("✅ strict: 비엔터 확정(사건·사고) 2건 탈락");

  const loose = preview.looseDrops.map((d) => d.keyword);
  assert(loose.length === 4, `loose 탈락은 4건이어야 한다 (실제 ${loose.length})`);
  assert(loose.some((k) => k.includes("카이스트")), "run #148 2위는 loose에서 잡힌다");
  assert(loose.some((k) => k.includes("이지혜")), "역할어·작품어가 없는 연예 가십도 loose에서는 함께 죽는다");
  console.log("✅ loose: 4건(strict 2건 + 판정 불가 2건) - loose를 켜면 정당 후보도 죽는다");

  // 신인·무명 보호. 이게 깨지면 게이트를 켤 수 없다.
  assert(!loose.some((k) => k.includes("김현이")), "역할어 '배우'가 있으면 어떤 기준에서도 통과해야 한다");
  assert(!loose.some((k) => k.includes("오프닝")), "신인·무명도 역할어('그룹')가 있으면 통과해야 한다");
  console.log("✅ 역할어 보호: 추모 기사·신인 그룹은 두 기준 모두에서 통과");

  // preview는 후보를 하나도 버리지 않는다.
  assert(preview.candidates.length === candidates.length, "preview는 후보를 그대로 통과시켜야 한다");
  assert(preview.applied === false, "preview의 applied는 false여야 한다");
  console.log("✅ preview 모드는 후보를 버리지 않는다");

  // apply를 켜면 strict만 빠진다.
  const applied = evaluateEntertainmentTrendGate(candidates, {
    trendQueries: TREND_QUERIES,
    config: { ...ENT_TREND_GATE_CONFIG, previewEnabled: true, apply: true },
  });
  assert(applied.candidates.length === candidates.length - 2, "apply는 strict 2건만 버려야 한다");
  assert(
    !applied.candidates.some((c) => c.keyword.includes("인천 흉기난동")),
    "apply 후에는 run #158 8위가 남아 있으면 안 된다"
  );
  assert(
    applied.candidates.some((c) => c.keyword.includes("이지혜")),
    "apply는 loose 전용 탈락(이지혜)을 버리면 안 된다"
  );
  console.log("✅ apply 모드는 strict만 적용(loose 전용 탈락은 유지)");

  // seed_queries 유래는 아예 보지 않는다.
  const seedOnly = evaluateEntertainmentTrendGate(
    [makeCandidate("스틸 대미투자 이행 비관세장벽 차별말라", "공식 스틸")],
    { trendQueries: TREND_QUERIES, config: { ...ENT_TREND_GATE_CONFIG, apply: true } }
  );
  assert(seedOnly.evaluated === 0, "seed_queries 유래 후보는 판정 대상이 아니다");
  assert(seedOnly.candidates.length === 1, "seed_queries 유래 후보는 버리지 않는다");
  console.log("✅ seed_queries 유래는 게이트 범위 밖(시드 자체를 고치는 쪽이 옳다)");

  console.log("\n✅ 전체 통과");
}

main();
