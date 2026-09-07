// Keyword Scoring Engine의 가중치 / 임계값 / 후킹 단어를 한 곳에 모아둔 상수 파일.
// scoreKeyword.ts 등 로직 코드에는 숫자를 흩뿌리지 않고 이 파일만 참조한다.
// 총점은 0~100이며 아래 6개 항목 weight의 합은 항상 100이어야 한다.

export const KEYWORD_SCORE_WEIGHTS = {
  trendMomentum: 30,
  newsVelocity: 20,
  contentDemand: 15,
  freshness: 15,
  crossSourceSignal: 10,
  clickPotential: 10,
} as const;

// A. Trend Momentum: 검색어트렌드 최근 값의 단기 변화(latest-previous)와 중기 추세(shortAverage vs
// previousAverage)를 함께 반영해 채점한다.
//
// 두 가지 문제를 함께 해결한다:
// 1) 단기 delta 하나만 보면 DataLab 일별 ratio의 하루짜리 노이즈(예: 실제로는 상승 추세인데 어제 하루만
//    살짝 내려간 경우)에 점수 전체가 0으로 꺾여버린다 (과거 trend_score=0 버그의 1차 원인).
// 2) delta/slope를 ratio "절대값(%p)" 기준 임계값(예: 20, 5)으로 정규화하면, 이미 검색량이 많은 키워드
//    (예: "넷플릭스", ratio 0~100대)에는 맞아도 롱테일 키워드(예: "육아지원금", ratio 0~1 미만)는 하루 전체가
//    바뀌어도 delta가 절대값 기준 임계값 근처도 못 가서 사실상 영원히 0점이 된다 (2차 원인 — 실측 결과
//    "넷플릭스/육아지원금/정부지원금" 모두 이 문제로 trend_score=0이었음). ratio는 키워드마다 서로 다른
//    baseline(그 키워드 자체 최대치 기준 정규화)을 가지므로, 절대값이 아니라 "직전 값 대비 변화율(%)"로
//    정규화해야 키워드 검색량 규모와 무관하게 공정하게 비교할 수 있다.
//
// 따라서 단기/중기 신호 모두 퍼센트 변화율로 계산한다:
// - 단기: (latest - previous) / max(|previous|, minBaselineRatio) * 100
// - 중기: (shortAverage - previousAverage) / previousAverage * 100 (fetchTrendMomentum.ts에서 계산)
export const TREND_MOMENTUM_CONFIG = {
  // 단기 변화율(%)이 이 값 이상이면 단기 신호 만점.
  fullScoreDeltaPercentThreshold: 30,
  // 중기 변화율(%)이 이 값 이상이면 중기 신호 만점.
  fullScoreMidPercentThreshold: 40,
  // previousRatio가 0에 가까운 롱테일 키워드는 아주 작은 절대 변화도 변화율(%)이 폭발적으로 커 보이므로,
  // 변화율 계산의 분모(baseline)에 하한을 둬 노이즈 과대평가를 막는다.
  minBaselineRatio: 0.5,
  // 단기(delta%) / 중기(중기 변화율%) 신호를 합산할 때의 가중 비율(합 1 권장). 중기 데이터가 없으면
  // 단기 신호만으로 재정규화해서 사용한다(scoreTrendMomentum 참고).
  shortTermWeight: 0.4,
  midTermWeight: 0.6,
  // trend 데이터를 아예 못 가져온 경우(API 실패 등) 적용할 기본 점수 비율(0~1, weight에 곱함).
  // 0으로 두면 API 실패가 곧 최하점이 되어 다른 신호가 좋은 키워드까지 과하게 불리해지므로 중간값을 둔다.
  neutralScoreRatio: 0.4,
  // 방향(trendDirection) 판정 임계값(%). 단기(delta%)/중기(중기 변화율%) 공통으로 퍼센트 스케일을 쓴다.
  risingDirectionThresholdPercent: 10,
  fallingDirectionThresholdPercent: -10,
  risingMidThresholdPercent: 15,
  fallingMidThresholdPercent: -15,
} as const;

// B. News Velocity: 최근 뉴스 발생량 + 짧은 시간 내 집중 발생 여부.
// 절대 건수만으로는 소량 배치에서 변별력이 거의 없으므로(예: 1건 vs 0건),
// "이 batch 안에서 상대적으로 얼마나 많은가"(percentile)를 함께 반영한다.
export const NEWS_VELOCITY_CONFIG = {
  // 이 개수 이상이면 절대 신호가 만점.
  countNormalizationCap: 15,
  // 절대 건수 신호와 batch 내 percentile 신호를 합산할 때의 가중 비율(합 1 권장).
  absoluteWeight: 0.6,
  percentileWeight: 0.4,
  // 가장 최근 뉴스가 이 시간(시간 단위) 이내면 "속보성"으로 보고 가점.
  recentWindowHours: 24,
  recentBoostRatio: 1,
  staleBoostRatio: 0.6,
} as const;

// C. Content Demand: 블로그/웹문서 발생량. 절대량보다 최근 활동성을 우선한다.
// News Velocity와 동일하게 절대 건수 + batch 내 percentile을 함께 반영한다.
export const CONTENT_DEMAND_CONFIG = {
  countNormalizationCap: 20,
  absoluteWeight: 0.6,
  percentileWeight: 0.4,
  recentWindowHours: 48,
  // 최근 window 내 활동이면 count 기반 점수에 곱해줄 추가 비율.
  recentBoostRatio: 0.5,
} as const;

// D. Freshness: 가장 최근 콘텐츠 발행 시각 기준 지수 감쇠.
export const FRESHNESS_CONFIG = {
  // 이 시간이 지날 때마다 점수가 절반으로 감소.
  halfLifeHours: 12,
  // 이 시간 이상 지난 콘텐츠는 0점.
  maxAgeHours: 72,
  // cluster 안에 publishedAt을 제공하는 source(news/blog)가 하나도 없는 경우(예: web문서만으로 구성된 cluster)
  // 적용할 기본 점수 비율(0~1, weight에 곱함). 0으로 두면 "정보가 없음"이 "완전히 오래됨"과 동일하게 처리되어
  // web-only cluster가 부당하게 불리해지므로 0은 쓰지 않는다.
  //
  // 0.5에서 0.2로 낮춘 이유(2026-08-26 실측): 0.5이면 15 * 0.5 = 8점인데, 당일 발행된 글은
  // 15 * 0.5^(14/12) = 7점이었다. 즉 "날짜를 모른다"가 "오늘 발행됐다"를 이겼다. 발행일이 없는 건
  // 대부분 naver_web 결과(나무위키, 정부 랜딩페이지)로 상시 문서이지 신선한 뉴스가 아닌데도,
  // run #14에서 발행일 없는 3건이 전부 이 역전 덕에 Top 10에 올랐다
  // ("부모급여 - 보건복지부" 4위, "결혼 - 나무위키" 6위, "2023년 tvN 신작 라인업" 8위).
  //
  // 0.2 = 15 * 0.2 = 3점. 반감기 12시간 곡선에서 "약 1.5일 지난 글" 위치다(24시간=4점, 36시간=2점).
  // 당일 발행 글(7점 이상)보다는 확실히 낮고, 72시간 초과(0점)보다는 높다 -
  // 이 부등식이 무너지면 같은 역전이 재발하므로 testScoreKeyword.ts가 불변식으로 고정한다.
  neutralScoreRatio: 0.2,
} as const;

// E. Cross Source Signal: 서로 다른 source(news/blog/web)에 동시에 등장할수록 가점.
export const CROSS_SOURCE_CONFIG = {
  scoreRatioByUniqueSourceCount: {
    1: 0,
    2: 0.6,
    3: 1,
  } as Record<number, number>,
} as const;

// F. Click Potential: 규칙 기반 후킹 단어 매칭.
export const CLICK_POTENTIAL_CONFIG = {
  // 매칭 단어 1개당 부여할 원점수. weight(10점)로 clamp되므로 3개 이상 매칭 시 자동으로 만점.
  perMatchScore: 4,
  hookWords: [
    "지원금",
    "변경",
    "공개",
    "확정",
    "논란",
    "이유",
    "방법",
    "신청",
    "출연진",
    "결말",
    "가격",
    "무료",
    "일정",
  ] as string[],
} as const;

// 동일 이슈 clustering(CompositeSimilarityClusterer) 설정.
// 단순 Jaccard 하나가 아니라 token overlap / 핵심 명사 overlap / character n-gram 세 신호를
// similarityWeights 비율로 합산한 뒤 similarityThreshold와 비교한다.
export const CLUSTERING_CONFIG = {
  // 최종 합성 유사도가 이 값 이상이면 같은 cluster로 묶는다.
  similarityThreshold: 0.38,
  // 이 길이 미만인 token은 비교에서 제외(조사 제거 후 남은 1글자 노이즈 등).
  minTokenLength: 2,
  // 클러스터링에 영향을 주지 않도록 제외할 범용/보도유형 단어.
  stopwords: [
    "관련",
    "총정리",
    "정리",
    "이슈",
    "소식",
    "속보",
    "단독",
    "포토",
    "영상",
    "전문",
    "인터뷰",
    "공식",
    "종합",
    "화보",
    "특징주",
    "외신",
  ] as string[],
  // 조사(josa)로 추정되는 접미사. 토큰 끝에서 매칭되면 제거하되, 제거 후 남는 길이가
  // minTokenLength 이상일 때만 적용한다(형태소 분석기 없이 문자열 규칙으로 처리하는 근사치).
  josaSuffixes: [
    "이지만",
    "이라는",
    "에서는",
    "에게서",
    "으로부터",
    "라는",
    "다는",
    "부터",
    "까지",
    "에서",
    "에게",
    "으로",
    "이나",
    "라도",
    "마저",
    "조차",
    "이랑",
    "은",
    "는",
    "이",
    "가",
    "을",
    "를",
    "의",
    "에",
    "와",
    "과",
    "도",
    "만",
    "랑",
  ] as string[],
  // 괄호류 안의 언론사 표기/보도유형 표시 등을 title에서 통째로 제거한다. (예: "[단독]", "(종합)", "〈포토〉")
  bracketPatterns: [
    "\\[[^\\]]*\\]",
    "\\([^)]*\\)",
    "【[^】]*】",
    "〈[^〉]*〉",
    "《[^》]*》",
  ] as string[],
  // seed query(검색에 사용한 원 query) 토큰은 같은 query에서 나온 거의 모든 후보에 공통으로 등장해
  // token/핵심명사 overlap 신호에서는 변별력이 없으므로 제외한다.
  // (character n-gram 신호에는 원문 그대로 남아 자연스럽게 낮은 가중치로 반영된다 — "제거 또는 낮은 가중치 적용"을
  //  신호별로 나눠 구현한 것)
  excludeSeedQueryFromTokens: true,
  // character n-gram 비교 시 사용할 n. 2(bigram)면 "중증외상센터"와 "중증"처럼 형태소가 부분적으로만
  // 겹치는 표현도 어느 정도 유사도를 인정받는다.
  charNgramSize: 2,
  // 세 유사도 신호를 합산할 때의 가중치. 합이 1이 아니어도 내부적으로 정규화해서 사용한다.
  // token/핵심명사 overlap을 primary 신호로 유지하고 char n-gram은 보조 신호로만 쓰도록, charNgram
  // 비중을 낮춰뒀다(과거 0.25 -> 0.15). "위키백과 한국어"/"나무위키" 같은 site boilerplate가 짧은
  // title에서 char n-gram 유사도를 부풀려 서로 무관한 seed의 후보를 잘못 병합시키는 문제가 실측으로
  // 확인됐다(minTokenOverlapToTrustCharNgram과 함께 대응).
  similarityWeights: {
    tokenOverlap: 0.5,
    coreNounOverlap: 0.35,
    charNgram: 0.15,
  } as const,
  // char n-gram 신호를 "신뢰"하는 최소 조건. token overlap이 이 값 미만이고 핵심 명사(entity) 교집합도
  // 0개면, char n-gram 유사도가 아무리 높아도(예: 공통 site suffix 때문에) 그 기여분을 0으로 무시한다.
  // token/entity 신호가 전혀 없는데 char n-gram만으로 merge되는 경우를 막기 위함.
  minTokenOverlapToTrustCharNgram: 0.15,
  // 서로 다른 seedQuery에서 나온 candidate를 merge할 때 요구하는, similarityThreshold보다 강한 합성
  // 유사도 기준. 같은 seed 내부 merge보다 cross-seed merge에 더 높은 확신을 요구한다.
  crossSeedSimilarityThreshold: 0.55,
  // cross-seed merge를 허용하려면(위 threshold를 넘겼더라도) 핵심 명사 교집합이 1개 이상이거나
  // token overlap이 이 값 이상이어야 한다 — 단순 site suffix/boilerplate 공통점만으로는 금지.
  crossSeedMinTokenOverlap: 0.3,
  // clustering 유사도 계산 전, title text에서 주제 판단에 불필요한 generic source/site suffix를
  // 제거하는 데 쓰는 패턴. 원문 headline 자체는 건드리지 않고 clustering용 정규화 텍스트에만 적용한다
  // (CompositeSimilarityClusterer.prepare() 참고).
  genericBoilerplatePatterns: [
    "위키백과\\s*한국어",
    "위키백과",
    "나무위키",
    "한국민족문화대백과사전",
    "두산백과",
    "네이버\\s*지식백과",
    "네이버\\s*블로그",
    "네이버\\s*포스트",
    "다음\\s*백과",
    "공식\\s*홈페이지",
    "공식\\s*블로그",
    "최신\\s*뉴스",
    "관련\\s*정보",
    "google\\s*play",
    "app\\s*store",
    "\\bnaver\\b",
  ] as string[],
  // naver_news/naver_blog/naver_web은 같은 이슈라도 문체가 크게 달라(블로그는 개인 코멘트, 뉴스는 육하원칙식)
  // 전체 합성 유사도(similarityThreshold)를 못 넘는 경우가 흔하다. 그래도 핵심 명사(entity)가 충분히 겹치면
  // 같은 이슈로 보고 병합할 수 있도록, 합성 유사도와 별개로 "핵심 명사 overlap 단독" 병합 경로를 둔다.
  // (coreNounOverlapMinIntersection으로 최소 겹침 개수를 강제해 명사 1개 우연 일치로 인한 오병합을 방지한다.)
  coreNounOverlapMergeThreshold: 0.5,
  coreNounOverlapMinIntersection: 2,
} as const;

// Canonical Keyword 생성(canonicalKeyword.ts) 설정.
// 뉴스/블로그 title 전체를 그대로 keyword로 쓰지 않기 위해, 언론사명/괄호/따옴표/문장형 어미/말줄임표를
// 규칙 기반으로 제거하고 목표 어절 수로 축약한다. 형태소 분석기나 LLM 없이 하는 1차 근사치이므로
// 완벽한 의미 압축(예: 부수적 수식어까지 골라내는 것)은 기대하지 않는다.
export const CANONICAL_KEYWORD_CONFIG = {
  // 목표 어절(공백 기준 token) 수 범위. 넘으면 앞에서부터 targetMaxWords개로 자른다.
  targetMinWords: 2,
  targetMaxWords: 8,
  // 문장 끝에 흔히 붙는 서술형 어미. 매칭되면 해당 절(마지막 어절)을 제거한다.
  sentenceEndingSuffixes: [
    "했다",
    "였다",
    "한다",
    "됐다",
    "이다",
    "보인다",
    "밝혔다",
    "전했다",
    "나왔다",
    "드러났다",
    "알려졌다",
    "귀추가 주목된다",
    "이라고",
    "한다는",
    "다는",
  ] as string[],
  // title에 흔히 등장하는 언론사/매체명. 단어 경계 기준으로 제거한다.
  knownOutlets: [
    "연합뉴스",
    "뉴시스",
    "뉴스1",
    "YTN",
    "MBC",
    "KBS",
    "SBS",
    "JTBC",
    "MBN",
    "채널A",
    "TV조선",
    "OSEN",
    "스포츠조선",
    "스포츠동아",
    "일간스포츠",
    "마이데일리",
    "텐아시아",
    "조선일보",
    "중앙일보",
    "동아일보",
    "한겨레",
    "경향신문",
    "한국일보",
    "서울신문",
    "국민일보",
    "매일경제",
    "한국경제",
    "머니투데이",
    "이데일리",
    "파이낸셜뉴스",
    "아시아경제",
    "헤럴드경제",
    "노컷뉴스",
    "데일리안",
    "아이뉴스24",
    "전자신문",
    "뉴스핌",
    "쿠키뉴스",
    "세계일보",
  ] as string[],
  // 목표 길이로 줄이기 위해 중간에서 제거해도 의미 손실이 적은 순수 날짜/월 표기 토큰 패턴(맨 앞 토큰은 제외).
  droppableMidTokenPatterns: ["^\\d{1,2}월$", "^\\d{1,2}일$"] as string[],
  // CLUSTERING_CONFIG.stopwords와 같은 성격(보도유형/범용 수식어)의 단어를 canonical keyword에서도 제거한다.
  // clustering 토큰화에 영향을 주지 않도록 별도 목록으로 분리해 이 파일에서만 사용한다(맨 앞 토큰은 제외).
  genericDroppableWords: [
    "관련",
    "총정리",
    "정리",
    "이슈",
    "소식",
    "속보",
    "단독",
    "포토",
    "영상",
    "전문",
    "인터뷰",
    "공식",
    "종합",
    "화보",
    "특징주",
    "외신",
  ] as string[],
  // 어절 끝에 붙은 조사를 제거해 단어 자체를 짧게 만든다(어절 수는 그대로, 길이만 축약).
  // CLUSTERING_CONFIG.josaSuffixes와 별개 목록으로 둬서 clustering 유사도 계산에는 영향을 주지 않는다.
  // 1글자 조사(은/는/이/가/을/를/의/에/와/과/도 등)는 넣지 않는다 — "쿠팡플레이"처럼 브랜드/고유명사가
  // 우연히 그 글자로 끝나는 경우가 흔해(예: ...이/가/도로 끝나는 이름), 단어 자체를 훼손하는 사례가
  // 실측(dry-run)으로 확인됐다. 2글자 이상의, 조사일 가능성이 훨씬 높은 표현만 포함한다.
  wordTrailingJosaSuffixes: [
    "이라며",
    "라며",
    "면서",
    "으로",
    "에서",
    "에게",
    "부터",
    "까지",
    "이나",
    "라도",
  ] as string[],
} as const;

// Seed Relevance(seed 검색어 <-> candidate 실제 연관성) 설정.
// 형태소 분석기/LLM 없이, candidate의 title(keyword)/description에 seed query 토큰이 실제로
// 등장하는지를 기준으로 0~1 relevance score를 계산한다(computeSeedRelevance.ts).
export const SEED_RELEVANCE_CONFIG = {
  // title 토큰 overlap(seed 토큰 중 title에 등장하는 비율)에 곱할 가중치.
  titleTokenWeight: 0.7,
  // description 토큰 overlap에 곱할 가중치. title에 seed 언급이 전혀 없는데 description에서만
  // 스쳐 지나가듯 언급된 경우(예: 스폰서십/제휴 나열 기사)까지 관련성 있다고 오판하지 않도록,
  // description 신호만으로는 minRelevanceThreshold를 넘지 못하는 값으로 낮게 둔다.
  descriptionTokenWeight: 0.15,
  // title에 seed query(또는 SEED_QUERY_ALIASES의 alias) 원문이 구(phrase) 단위로 그대로 포함되면
  // relevance를 최댓값(1)으로 확정한다 — "쿠팡플레이"처럼 공백 없는 고유 브랜드/서비스명이 title에
  // 그대로 등장하는 경우를 가장 강하게 신뢰하기 위함. additive bonus가 아니라 확정값으로 처리해,
  // 토큰 일부만 겹치는 경우(아래 partialOverlapPenaltyExponent)와 명확히 구분한다.
  exactPhraseMatchScore: 1,
  // seed가 여러 토큰으로 이뤄진 경우(예: "신작 드라마"), title/description에 토큰 일부만 겹치면
  // 그 비율(overlapRatio)을 이 지수로 제곱해 감점한다(0<ratio<1 구간에서 값이 더 작아짐).
  // 1이면 감점 없음(선형), 값이 클수록 "일부만 일치"를 더 강하게 걸러낸다.
  // 예: overlapRatio=0.5, exponent=2 -> 0.25로 감점(선형이면 0.5 그대로 반영됐을 것).
  partialOverlapPenaltyExponent: 2,
  // 이 값 미만인 candidate는 ranking 후보에서 제외한다.
  minRelevanceThreshold: 0.25,
  // seed query가 너무 짧아(조사/불용어 제거 후 토큰이 0개) relevance를 계산할 수 없는 경우 적용할 중립 점수.
  // 0으로 두면 정보 부족을 "무관함"과 동일하게 취급해 부당하게 걸러지므로 중간값 이상을 둔다.
  neutralRelevanceWhenSeedTooShort: 0.7,
} as const;

// seedQuery -> alias(동의어/영문 표기 등) 목록. computeSeedRelevance는 seedQuery 자신뿐 아니라
// 여기 등록된 모든 alias에 대해 relevance를 계산하고 그중 최댓값을 사용한다 — "쿠팡플레이" 기사가
// 영문 "Coupang Play"로만 표기돼도 관련성을 놓치지 않기 위함. 등록되지 않은 seedQuery는 자기 자신만
// 사용한다(기존 동작과 동일).
export const SEED_QUERY_ALIASES: Record<string, string[]> = {
  "넷플릭스": ["넷플릭스", "netflix"],
  "디즈니플러스": ["디즈니플러스", "디즈니 플러스", "disney+", "disney plus"],
  "티빙": ["티빙", "tving"],
  "웨이브": ["웨이브", "wavve"],
  "쿠팡플레이": ["쿠팡플레이", "coupang play"],
} as const;

// Topic Grouping(Top N 선정 단계의 "같은 주제" 판정) 설정. topicGrouping.ts 참고.
//
// clustering(CLUSTERING_CONFIG)과 목적이 다르다. clustering은 수백 개 후보를 이슈 단위로 묶는 1차
// 작업이고, 이쪽은 그 결과 중 Top N을 고를 때 "이미 뽑은 것과 사실상 같은 건인가"만 다시 보는
// 2차 안전장치다. clustering이 놓쳐도(특히 cross-seed로 같은 이슈가 잡힌 경우 - topicGrouping.ts
// 상단 주석) Top 10이 한 주제로 도배되는 것을 막는다.
export const TOPIC_GROUPING_CONFIG = {
  // batch 크기 * 이 비율 이하의 document frequency를 가진 핵심 명사를 "희소(distinctive)"로 본다.
  // 400개 cluster 기준 8건 이하. 그날의 고유명사("들쥐" 4건)는 통과하고, 플랫폼/범용어("넷플릭스"
  // 수십 건)는 통과하지 못하는 지점으로 잡았다.
  distinctiveDocFrequencyRatio: 0.02,
  // 후보가 얕은 날 비율만으로는 0에 수렴하므로 하한을 둔다(df 2 = 두 후보가 공유하는 단어).
  minDistinctiveDocFrequency: 2,
  // 후보가 아주 많은 날 흔한 단어까지 희소로 인정되는 것을 막는 상한.
  maxDistinctiveDocFrequency: 12,
  // 희소 토큰을 공유하지 않아도, 핵심 명사 집합 자체가 이만큼 겹치면 같은 주제로 본다.
  coreNounSameTopicThreshold: 0.5,
  // 위 비율 판정이 짧은 제목에서 우연히 성립하는 것을 막는 최소 교집합 개수.
  coreNounSameTopicMinIntersection: 2,
  // 플랫폼/장르처럼 "주제"가 아니라 "분류"를 가리키는 단어. 희소성 통계만으로는 고유명사와 구분할
  // 수 없어서(후보가 얕은 날에는 "넷플릭스"의 df가 "들쥐"의 df와 거의 같아진다) 명시적으로 제외한다.
  // 이게 없으면 서로 다른 작품인 "넷플릭스 들쥐"와 "넷플릭스 오징어게임"이 플랫폼 이름 하나로 묶인다.
  //
  // 여기 나열한 것은 어느 날이든 분류어인 고정 목록이고, 그날그날의 분류어(= seed_queries에 사람이
  // 등록해둔 상시 검색어)는 selectDiverseTopN이 runtime으로 추가 주입한다.
  categoryTerms: [
    "넷플릭스", "netflix", "티빙", "tving", "웨이브", "wavve", "디즈니플러스", "디즈니",
    "쿠팡플레이", "왓챠", "유튜브", "youtube", "ott", "드라마", "영화", "예능", "시리즈",
    "방송", "연예", "육아", "날씨", "지원금", "정부지원금",
  ] as string[],
  // 희소해 보여도 주제를 대표하지 못하는 범용 수식어. 신호 계산에서 통째로 제외한다.
  // 이게 없으면 서로 다른 드라마 두 편이 "촬영지" 하나로 같은 주제가 된다.
  genericTokens: [
    "리뷰", "후기", "정보", "방법", "이유", "결말", "출연진", "촬영지", "공개일",
    "시즌", "가격", "일정", "신청", "총정리", "정리", "순위", "근황", "논란",
    "공개", "확정", "변경", "무료", "실화", "해석", "가능성", "예고", "모음",
    "추천", "비교", "차이", "후속", "반응", "일화", "회차", "티저", "예고편",
    "관람평", "줄거리", "등장인물", "몰아보기", "다시보기",
  ] as string[],
} as const;

// Ranking Diversity(Top N 선정 다양성) 설정.
// 최종 selection 단계에서 동일 seedQuery/canonical topic 편중을 막고, 가능하면 category별로
// 최소 1개씩 포함되도록 한다(selectDiverseTopN.ts). 실제 고점 이슈가 없는 category는 억지로 채우지 않는다.
export const DIVERSITY_CONFIG = {
  // 최종 Top N 안에서 동일 seedQuery가 등장할 수 있는 최대 횟수.
  // 2026-08-31: 2 -> 1. "며칠 운영 후 판단"하기로 했던 항목(CURRENT_STATE 알려진문제 #3).
  // 같은 seed에서 파생된 키워드 2건이 Top 10 자리를 차지하는 사례가 반복돼 1로 내렸다.
  maxPerSeedQuery: 1,
  // 최종 Top N 안에서 동일 topic이 등장할 수 있는 최대 횟수.
  //
  // "동일 topic"의 판정 기준이 2026-08-29에 바뀌었다. 이전에는 canonical keyword "문자열 완전 일치"
  // 였는데, 그래서 같은 이슈라도 제목이 다르면(= canonical이 다르면) cap이 아예 발화하지 않았다.
  // 실제로 "넷플릭스 들쥐" 한 건이 서로 다른 canonical 4개로 Top 10을 4칸 차지했다.
  // 지금은 topicGrouping.ts의 isSameTopic()(희소 핵심 명사 공유 또는 핵심 명사 overlap)으로 센다.
  maxPerCanonicalTopic: 1,
  // false로 두면 위 판정이 예전처럼 canonical keyword 문자열 완전 일치로 돌아간다.
  // 주제 판정이 과하게 묶는 날이 관측되면 코드 수정 없이 이 값만 내려 원복할 수 있게 남겨둔다.
  enableTopicGrouping: true,
  // category별 최소 1개 포함을 시도할 대상 category 목록.
  // "community"는 2026-08-29 추가(커뮤니티/다음/구글 소스 확장). backfill은 pool에 해당 category
  // 후보가 실제로 있을 때만 동작하므로(selectDiverseTopN 3번 규칙), 커뮤니티 수집이 붙기 전까지는
  // 이 항목이 있어도 동작이 달라지지 않는다.
  //
  // "incident"(사건·사고, 2026-09-04 추가)는 **의도적으로 넣지 않았다.** backfill은 "대표가 없으면
  // 점수가 낮아도 한 자리를 만들어준다"는 규칙인데, 사망·범죄 기사에 그걸 적용하면 매일 사건사고
  // 하나를 억지로 Top 10에 올리게 된다. 그런 글을 쓸지는 사용자가 Go/Pass로 결정할 일이지
  // 다양성 정책이 밀어 넣을 일이 아니다. 점수가 높으면 backfill 없이도 정상적으로 올라온다.
  // parenting 제거(2026-09-07 채널 개편, 사용자 승인) - 육아 카테고리는 수집 단계에서 원천
  // 차단되어(keywordExclusionRules.ts) candidate pool에 아예 들어오지 않으므로, backfill 대상으로
  // 남겨둬도 동작하지 않는 죽은 설정이었다.
  targetCategories: ["ott", "living", "entertainment", "community"] as string[],
  // true면 targetCategories 중 Top N에 대표가 없는 category를 candidate pool에서 backfill 시도한다.
  enableCategoryBackfill: true,
  // category별 Top N 등장 상한(2026-08-31). 지정한 category만 적용, 나머지는 무제한. 기본은 비활성({}).
  // 관측된 도배는 전부 "동일 seedQuery에서 같은 사건 기사 2건"이라 maxPerSeedQuery=1로 해소된다.
  // living처럼 서로 다른 주제가 정상적으로 섞이는 grab-bag category까지 상한을 걸면 다양성을
  // 오히려 해쳐서 지금은 켜지 않는다. 특정 category(예: 정책/지원금 전용 category가 생기면) 편중이
  // 관측되면 코드 수정 없이 { living: 2 } 식으로 조절한다. 후보가 얕은 날은 selectDiverseTopN이
  // 이 상한을 풀어 빈 자리를 메운다(1-1 pass).
  maxPerCategory: {} as Record<string, number>,
} as const;
