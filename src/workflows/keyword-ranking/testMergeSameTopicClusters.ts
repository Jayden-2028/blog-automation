// mergeSameTopicClusters()의 병합/비병합 불변식 테스트.
//
// 회귀 기준은 run #34 실측이다(mergeSameTopicClusters.ts 상단 주석): 부산 오피스텔 추락사 한 사건이
// 서로 다른 cluster 2개로 쪼개져 Top 10을 두 칸 차지했고, pairwise 합성 유사도는 0.270이라
// clustering 임계값(cross-seed 0.55 / same-seed 0.38) 어느 쪽도 못 넘었다.
//
// 이 테스트가 지키는 것은 두 방향이다:
// - 같은 이슈는 합쳐진다(그러지 않으면 이 모듈을 만든 이유가 없다).
// - 무관한 이슈는 절대 합쳐지지 않는다(과병합은 잘못된 headline/sources가 원고로 흘러가므로
//   미병합보다 훨씬 나쁘다).
//
// 외부 호출/DB 접근 없이 순수 함수만 검증한다. 실행: npm run test:merge-same-topic

import { mergeSameTopicClusters } from "./mergeSameTopicClusters.js";
import type { KeywordCluster } from "./clustering/KeywordClusterer.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

type Item = { keyword: string };

function cluster(representativeKeyword: string, itemCount = 1): KeywordCluster<Item> {
  return {
    representativeKeyword,
    items: Array.from({ length: itemCount }, (_, i) => ({
      keyword: i === 0 ? representativeKeyword : `${representativeKeyword} (${i})`,
    })),
  };
}

// run #32~34 실제 Top 키워드. df 통계가 의미를 가지려면 batch 문맥이 필요하다.
const REAL_BATCH = [
  cluster('"가해자 누나는 KBS 드라마 출연 중" 부산 오피스텔 추락사 사건 전말', 3),
  cluster('"내 딸은 죽었는데..." 부산 오피스텔 추락사 유족, KBS에 청원 올려'),
  cluster("4차 민생지원금 추석 전 신청 일정과 지급 지역은", 2),
  cluster("이마트 할인행사 전단지 / 고래잇 페스타 / 이마트"),
  cluster("2026 여의도 불꽃축제 일정·시간·명당·교통통제", 2),
  cluster("2026 여의도 불꽃축제 시간 헷갈리면 손해! 일정·명당·귀가"),
  cluster("테슬라 사이버캡 진짜 도로에 나왔다 운전대 없는 로보택시"),
  cluster("강남 치폴레 오픈! 가격 메뉴 주문 방법 웨이팅"),
  cluster("어린이집 대기 신청 방법 시기 아이사랑 어플 사이트"),
  cluster("드라마 이런 엿같은 사랑 등장인물 결말 촬영지 출연진"),
  cluster("두리랜드에 250억 쓴 임채무 빚과 운영 이유"),
  cluster("옵세션 결말 해석 짝사랑 소원이 집착 공포가 된"),
  cluster("김민석 용혜인 논란에 깊이 생각해야 국민 목소리 존중할"),
  cluster("천안 k컬쳐 박람회 2026 라인업 일정 주차 셔틀"),
  cluster("2027 9모 등급컷 숫자만 보면 위험한 이유와 수시"),
  cluster("티빙 개인정보 유출 보상 신청방법 2만 원·최대 300만 원 누가"),
  cluster("이재영 증평군수 중부고속도로 확장 범도민 서명 챌린지 동참"),
  cluster("나 결혼해 빠니보틀 예비신부 메로나 전격 공개 38세에"),
  cluster("곽시양 임현주 공개열애 결별 그리고 2026년"),
];

function groupContaining(
  result: ReturnType<typeof mergeSameTopicClusters<Item>>,
  needle: string
): string[] | null {
  const group = result.mergedGroups.find((g) => g.memberKeywords.some((k) => k.includes(needle)));
  return group?.memberKeywords ?? null;
}

function main(): void {
  console.log("▶ mergeSameTopicClusters 테스트");

  // ---------- 1. 실측 회귀: 같은 사건 병합 ----------
  console.log("\n[1] run #34 실측 — 같은 이슈 병합");

  const result = mergeSameTopicClusters(REAL_BATCH, {
    categoryTerms: ["넷플릭스", "드라마 출연진", "신작 드라마", "예능", "배우", "아이돌"],
  });

  const fallGroup = groupContaining(result, "오피스텔 추락사");
  assert(fallGroup !== null, "부산 오피스텔 추락사 2건이 같은 그룹으로 병합되어야 한다");
  assert(
    fallGroup.length === 2,
    `추락사 그룹은 정확히 2건이어야 한다 (실제 ${fallGroup.length}건: ${fallGroup.join(" | ")})`
  );
  console.log(`   추락사 병합: ${fallGroup.length}건`);

  const fireworksGroup = groupContaining(result, "여의도 불꽃축제");
  assert(fireworksGroup !== null, "여의도 불꽃축제 2건도 병합되어야 한다");
  console.log(`   불꽃축제 병합: ${fireworksGroup.length}건`);

  assert(
    result.clusters.length < REAL_BATCH.length,
    "병합이 일어났으면 cluster 수가 줄어야 한다"
  );
  console.log(`   cluster ${REAL_BATCH.length} -> ${result.clusters.length}개`);

  // ---------- 2. 과병합 방지 ----------
  console.log("\n[2] 과병합 방지");

  for (const group of result.mergedGroups) {
    const hasFall = group.memberKeywords.some((k) => k.includes("추락사"));
    const hasUnrelated = group.memberKeywords.some(
      (k) => k.includes("이마트") || k.includes("불꽃축제") || k.includes("치폴레")
    );
    assert(
      !(hasFall && hasUnrelated),
      `추락사가 무관한 이슈와 병합되면 안 된다: ${group.memberKeywords.join(" | ")}`
    );
  }

  // 서로 다른 드라마 두 편이 "드라마"라는 분류어 하나로 묶이면 안 된다.
  const dramaGroup = groupContaining(result, "이런 엿같은 사랑");
  const obsessionInSameGroup = dramaGroup?.some((k) => k.includes("옵세션")) ?? false;
  assert(!obsessionInSameGroup, "서로 다른 작품이 분류어로 병합되면 안 된다");
  console.log(`   무관 이슈 병합 없음 (그룹 ${result.mergedGroups.length}개 전부 점검)`);

  // ---------- 3. 항목/신호 보존 ----------
  console.log("\n[3] 항목 보존");

  const beforeItems = REAL_BATCH.reduce((sum, c) => sum + c.items.length, 0);
  const afterItems = result.clusters.reduce((sum, c) => sum + c.items.length, 0);
  assert(
    beforeItems === afterItems,
    `병합 전후 항목 총수가 같아야 한다 (${beforeItems} -> ${afterItems})`
  );
  console.log(`   항목 ${beforeItems}건 보존 (신호가 합산되도록)`);

  // 대표 키워드는 그룹 안에서 가장 짧은 것(기존 clusterer 규칙과 동일).
  const fallCluster = result.clusters.find((c) => c.representativeKeyword.includes("추락사"));
  assert(fallCluster !== undefined, "병합된 cluster가 결과에 있어야 한다");
  assert(
    fallCluster.items.length === 4,
    `병합된 cluster는 양쪽 항목을 모두 가져야 한다 (실제 ${fallCluster.items.length}건)`
  );

  // ---------- 4. 경계 조건 ----------
  console.log("\n[4] 경계 조건");

  assert(mergeSameTopicClusters([]).clusters.length === 0, "빈 입력은 빈 결과");
  assert(mergeSameTopicClusters([]).mergedGroups.length === 0, "빈 입력은 병합 그룹도 없음");

  const single = [cluster("단독 이슈")];
  assert(mergeSameTopicClusters(single).clusters.length === 1, "1개 입력은 그대로");
  assert(mergeSameTopicClusters(single).mergedGroups.length === 0, "1개 입력은 병합 없음");

  // 원본 불변성 - 호출자가 병합 전 상태를 계속 쓸 수 있어야 한다(preview 모드가 이에 의존한다).
  const originalLength = REAL_BATCH.length;
  const originalFirstItems = REAL_BATCH[0].items.length;
  mergeSameTopicClusters(REAL_BATCH);
  assert(REAL_BATCH.length === originalLength, "원본 배열이 수정되면 안 된다");
  assert(REAL_BATCH[0].items.length === originalFirstItems, "원본 cluster의 items가 수정되면 안 된다");
  console.log("   빈 입력 / 단일 입력 / 원본 불변성 확인");

  // 결정성: 같은 입력이면 같은 결과여야 한다(로그 비교가 가능하려면 필수).
  const again = mergeSameTopicClusters(REAL_BATCH, {
    categoryTerms: ["넷플릭스", "드라마 출연진", "신작 드라마", "예능", "배우", "아이돌"],
  });
  assert(
    JSON.stringify(again.mergedGroups) === JSON.stringify(result.mergedGroups),
    "같은 입력은 같은 병합 결과를 내야 한다"
  );
  console.log("   결정성 확인");

  console.log("\n✅ 전체 통과");
  console.log(`\n▶ 병합된 그룹 (${result.mergedGroups.length}개)`);
  for (const group of result.mergedGroups) {
    console.log(`   • ${group.representativeKeyword} (${group.mergedItemCount}건)`);
    for (const member of group.memberKeywords) console.log(`     - ${member}`);
  }
}

main();
