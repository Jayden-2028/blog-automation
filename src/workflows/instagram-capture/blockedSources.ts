// 대체 이미지로 쓰지 않을 도메인(2026-09-23 사용자 결정).
//
// 왜 인스타를 빼는가: 지금 찾는 것은 오버레이가 없는 **깨끗한 원본**이다. 그런데 검색이
// 물어온 게 또 다른 인스타 게시물이면 같은 종류의 뉴스 카드일 확률이 높고(번인 텍스트를
// 피하려는 목적이 무너진다), 저작권 판단도 원본 게시물과 다를 바 없다. 실측에서 실제로
// 다른 인스타 게시물이 출처로 잡혔다(job ec21f085).
//
// findCleanAlternative(2-a)와 reverseImageSearch(2-b) 양쪽이 쓴다. 한쪽에만 두면 다른
// 경로로 인스타가 새어 들어온다 - 그래서 공용 모듈로 뺐다.

const BLOCKED_HOSTS = ["instagram.com", "cdninstagram.com", "fbcdn.net", "threads.net", "threads.com"];

export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function blocked(host: string | null): boolean {
  if (host === null) return false;
  return BLOCKED_HOSTS.some((b) => host === b || host.endsWith(`.${b}`));
}

/** 이미지 주소든 출처 페이지든 한쪽이라도 막힌 도메인이면 후보에서 뺀다. */
export function isBlockedSource(candidate: { link?: string | null; sourcePage?: string | null }): boolean {
  return [candidate.link, candidate.sourcePage].some((url) => (url ? blocked(hostOf(url)) : false));
}
