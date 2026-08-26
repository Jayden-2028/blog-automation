// Creator Advisor 후보 pre-score(candidate_score) 설정.
//
// 기존 keyword_rankings의 6-factor 최종 scoring(config/keywordScoring.ts, scoreKeyword.ts)과
// 완전히 분리되어 있다 - 이 점수는 Creator Advisor가 매일 만들어내는 최대 120개 후보 중 NAVER API
// 검증(트렌드/뉴스/블로그 조회)을 보낼 상위 후보를 1차로 추리는 데만 쓰인다. scoreKeyword.ts의 최종
// trend_score는 이 파일을 참조하지 않고, 이 점수도 최종 score에 절대 합산되지 않는다
// (scoreCreatorAdvisorCandidate.ts 참고).

export const CREATOR_ADVISOR_CANDIDATE_SCORE_CONFIG = {
  // rank(topic 내 순위) 구간별 기본 점수. maxRank를 오름차순으로 순회하며 첫 매치를 사용한다.
  rankScoreBands: [
    { maxRank: 3, score: 20 },
    { maxRank: 6, score: 15 },
    { maxRank: 10, score: 10 },
    { maxRank: 20, score: 5 },
  ] as { maxRank: number; score: number }[],
  // 위 모든 구간을 벗어난 rank(예: 21위 이후)에 줄 기본 점수.
  rankScoreFallback: 2,

  // movementType별 기본 보너스. new(신규 진입)를 가장 높게 본다 - 이제 막 유입되기 시작한 키워드가
  // 블로그 선점 효과가 크다고 보기 때문. flat과 down은 이미 알려진/하락 중인 키워드라 낮게 둔다.
  movementBonus: {
    new: 15,
    up: 5,
    flat: 5,
    down: 0,
  } as Record<"new" | "up" | "down" | "flat", number>,

  // movementType="up"이고 rankChange(상승폭)가 양수일 때, movementBonus 위에 추가로 얹는 보너스.
  // minRankChange를 내림차순으로 순회하며 첫 매치를 사용한다.
  rankChangeBonusBands: [
    { minRankChange: 50, score: 10 },
    { minRankChange: 20, score: 7 },
    { minRankChange: 5, score: 3 },
  ] as { minRankChange: number; score: number }[],
} as const;
