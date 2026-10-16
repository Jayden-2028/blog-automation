// 인물 백과 조사 풀에 추가하는 "드라마 테마 블로그" 목록(PERSON-RESEARCH-SOURCES-2026-10 §B-1).
// 네이버 블로그 테마 순위(드라마) Top 10, 2026-10-17 사용자 제공 스크린샷 기준.
//
// 병행, 2026-10-17: prompts/research/person-researcher.md §5의 서치풀(RSS 10곳)과 **함께** 쓴다.
// 교체 여부는 사용자 결정 대기 - 이 파일은 풀을 늘릴 뿐 기존 풀을 건드리지 않는다.
// 이 풀의 글은 구성·커버리지 참고용이다. 사실 근거로 쓰지 않는다(개인 블로그, 검증 안 됨).

export type PersonReferenceBlog = { blogId: string; name: string };

export const PERSON_REFERENCE_BLOGS: readonly PersonReferenceBlog[] = [
  { blogId: "uggang2", name: "깡이맘" },
  { blogId: "ddo-play", name: "또봄의 드라마 다이브" },
  { blogId: "js2y86", name: "덕빛's 드라마 필모그래피" },
  { blogId: "pang_gom", name: "미디어 부수기!!" },
  { blogId: "jaehee740", name: "드라마 보는 케이씨" },
  { blogId: "arahi428", name: "라미의 멀티 뮤지엄" },
  { blogId: "lunaris137", name: "루나리스의 문화생활" },
  { blogId: "jeje-_-", name: "드라마 컷컷" },
  { blogId: "khs2075-", name: "드라마 속 음악노트" },
  { blogId: "zosen98", name: "에뜨와르의 드라마, 영화, 책을 기록하는 일상" },
];
