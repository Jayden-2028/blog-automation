import type { NaverTrendKeywordGroup } from "../providers/NaverTrendProvider.js";

// 검색어트렌드(DataLab) 조회에 사용할 기본 검색어 그룹.
// DataLab API는 요청 1건당 최대 5개 groupName, group당 최대 20개 keyword를 허용한다.
export const DEFAULT_NAVER_TREND_GROUPS: NaverTrendKeywordGroup[] = [
  {
    groupName: "OTT",
    keywords: ["넷플릭스", "디즈니플러스", "티빙", "웨이브", "쿠팡플레이"],
  },
  {
    groupName: "육아",
    keywords: ["육아지원금", "출산지원금", "부모급여", "아동수당"],
  },
  {
    groupName: "생활/정책",
    keywords: ["정부지원금", "날씨", "전기요금", "교통비", "정책변화"],
  },
  {
    groupName: "연예",
    keywords: ["연예", "배우", "아이돌", "드라마", "영화"],
  },
];
