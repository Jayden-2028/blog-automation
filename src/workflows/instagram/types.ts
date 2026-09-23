// 인스타그램 기반 키워드 수집의 공용 타입.
//
// 파이프라인: Business Discovery 응답 -> PostSignal(게시물 단위 점수) -> TopicCandidate(주제 단위)
//            -> 검색 수요 보정 -> RankedTopic(최종 top 20)

/** 게시물 1건 + 그 게시물이 속한 계정의 맥락. 점수 계산에 필요한 최소 집합. */
export type PostSignal = {
  username: string;
  /** 그 계정의 팔로워 수. 도달 보정에만 쓴다(정규화에는 쓰지 않는다). */
  followers: number;
  /** 그 계정 최근 게시물들의 engagement 중앙값 = "평소 수준". */
  accountBaseline: number;
  postId: string;
  caption: string;
  permalink: string;
  timestamp: string;
  likes: number;
  comments: number;
};

/** 여러 게시물이 같은 사건을 가리킬 때 하나로 묶은 것. LLM이 만든다. */
export type TopicCandidate = {
  /** 사람이 읽는 주제명. 알림·뷰어에 그대로 나간다. */
  label: string;
  /** 라벨링만 한다 - 순위에는 쓰지 않는다(2026-09-21 사용자 결정). */
  category: string;
  /** 블로그 포화도를 재려고 던질 검색어. 짧은 핵심어여야 한다. */
  query: string;
  /** 이 주제를 이루는 게시물들. */
  posts: PostSignal[];
};

/** 점수까지 매겨진 최종 결과. */
export type RankedTopic = TopicCandidate & {
  /** 소셜 화제성 원점수. */
  socialScore: number;
  /** 서로 다른 페이지 수. 1이면 한 곳에서만 나온 것이라 신뢰도가 낮다. */
  pageCount: number;
  /** 네이버 블로그 문서 수. null이면 조회 실패. */
  blogTotal: number | null;
  /** 0~1. 높을수록 "수요는 있는데 글이 아직 없다". */
  opportunity: number | null;
  /** 소셜 × 기회도. 이 값으로 정렬한다. */
  finalScore: number;
  /** 왜 이 순위인지 사람이 읽을 근거 한 줄. */
  reason: string;
};
