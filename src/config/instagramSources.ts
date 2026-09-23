// 키워드 수집 풀로 쓰는 인스타그램 이슈 페이지 목록(2026-09-21 사용자 제공).
//
// 왜 목록을 코드에 두는가: 데모 단계에서는 목록이 고정이다(사용자 결정). 교체가 확정되면
// 그때 DB 테이블로 옮길지 정한다 - 지금 테이블을 만들면 마이그레이션 승인 게이트가 걸리고,
// 아직 이 소스가 쓸 만한지도 확인되지 않았다.
//
// ⚠️ Business Discovery API는 **비즈니스/크리에이터 계정만** 조회할 수 있다. 개인 계정은
// 조회 자체가 실패한다(에러코드 110 또는 빈 응답). 어느 페이지가 해당되는지는 실측으로만
// 알 수 있어서, probe CLI가 확인한 뒤 여기에 기록한다.

export type InstagramSource = {
  /** @ 없는 사용자명. API 호출의 유일한 키다. */
  username: string;
  /** probe로 확인한 조회 가능 여부. null이면 아직 확인 전. */
  reachable?: boolean | null;
  /** 사람이 알아보기 위한 메모(성격·주력 주제). probe 결과를 보고 채운다. */
  note?: string;
};

export const INSTAGRAM_SOURCES: InstagramSource[] = [
  { username: "ddak.mag" },
  { username: "_ytnstar" },
  { username: "hangang.official" },
  { username: "eyesmag" },
  { username: "_trend_kr" },
  { username: "seoul__guide" },
  { username: "dip_magazine" },
  { username: "glowupmag" },
  { username: "newsourcemag" },
  { username: "izitmag_" },
  { username: "hipkr_" },
  { username: "idolissue" },
  { username: "the_edit.co.kr" },
  { username: "issuemagazines" },
  { username: "issue.mg" },
];

/** probe에서 제외되지 않은(=조회 가능한) 소스만. reachable이 아직 null이면 포함한다. */
export function activeInstagramSources(): InstagramSource[] {
  return INSTAGRAM_SOURCES.filter((source) => source.reachable !== false);
}
