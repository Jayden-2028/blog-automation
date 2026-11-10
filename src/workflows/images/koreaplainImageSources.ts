// koreaplain(Korea Plain) 트랙이 이미지를 가져와도 되는 출처 목록(2026-11-10 사용자 결정).
//
// 왜 만들었나(팀장 세션 실측): 발행본 71건 중 61건(86%)이 언론사·상업 사이트 사진을 싣고 있었다.
// 출처 표기(`Photo: Naver News`)만 있고 라이선스는 없으며, 파일은 우리 Cloudflare Pages 도메인에
// 복사돼 서비스된다. 구글 퍼블리셔 정책은 저작권 침해를 금지하고, 연합뉴스·뉴스1 같은 곳은 실제로
// 라이선스를 추심한다. 애드센스 수익화를 앞둔 사이트라 그대로 둘 수 없었다.
//
// 그래서 이 트랙의 이미지 자리는 셋 중 하나로만 채운다.
//   1. 공공·공식 자료(웹 검색) - **이 파일의 목록 안에 있는 호스트만**
//   2. 공식 페이지 캡처(capturePagesForJob) - 화면 자체가 정보인 자리(요금표·운영시간·기관 안내)
//   3. AI 생성(generateManuscriptImages, quality low 고정) - 나머지 전부
//
// **화이트리스트 방식이다 - 목록에 없으면 거부한다.** 언론사 목록을 늘려 막는 방식(블랙리스트,
// `pressDomains.ts`)은 택하지 않았다. 이유 셋:
//   - 끝이 없다. 언론사·블로그·커뮤니티·쇼핑몰·이미지 호스팅이 매일 생기고, 목록에서 빠진 한 곳이
//     곧바로 추심 대상이 된다. 막는 쪽이 항상 한 발 늦다.
//   - 실패의 방향이 반대다. 블랙리스트는 **모르는 곳을 통과**시키고, 화이트리스트는 **모르는 곳을
//     거부**한다. 거부된 자리는 AI 생성으로 넘어가 비용이 장당 $0.0036일 뿐이지만, 잘못 통과한
//     사진은 청구서가 된다.
//   - 우리가 쓸 수 있는 출처는 실측으로 이미 좁혀져 있다(아래 목록 - 발행본에서 문제없이 쓰인 곳).
//
// `pressDomains.ts`는 다른 일을 한다 - 기사 **화면 캡처**를 막는 2차 방어선이고, 전 트랙에 적용된다.
// 이 파일은 그것을 건드리지 않고 **koreaplain 수집 경로에서만** 쓴다(collectWebImages.ts).

import { KOREAPLAIN_TRACK } from "../../config/koreaplainTrack.js";

/**
 * 허용 호스트. 하위 도메인까지 받는다(`www.seoul.go.kr` → `seoul.go.kr`, `ko.wikipedia.org` → `wikipedia.org`).
 *
 * 근거는 발행본 71건의 출처 실측 분포(팀장 세션, 2026-11-10)다. 괄호는 그 분포의 기관명.
 *
 * **`.or.kr`을 통째로 허용하지 않는다.** `.or.kr`은 사설 단체·협회·언론 계열 재단이 많이 쓰는
 * 도메인이라 접미사로 열면 문이 너무 넓다 - 필요한 곳만 호스트 단위로 적는다.
 */
const ALLOWED_HOSTS = [
  // 정부·지자체·공공기관은 접미사로 받는다(ALLOWED_SUFFIXES). 아래는 접미사 밖에 있는 공식 호스트다.
  "korea.kr", // 정책브리핑(Korea Policy Briefing, 4건). `.kr` 직하위라 `.go.kr`에 안 걸린다.
  "visitseoul.net", // 서울관광재단 Visit Seoul(5건)
  "visitkorea.or.kr", // 한국관광공사 Korea Tourism Organization(4건). `.or.kr` 중 **이 호스트만** 연다.
  "airport.kr", // 인천국제공항공사 Incheon International Airport(7건)
  "wikimedia.org", // Wikimedia Commons(8건) - 이미지 파일은 upload.wikimedia.org에 있다
  "wikipedia.org", // Wikipedia(4건)
] as const;

/**
 * 접미사로 허용하는 공공 도메인. `.go.kr`은 정부·지자체·공공기관만 발급받는 도메인이라 호스트를 일일이
 * 적지 않는다(`seoul.go.kr` 서울시 10건 등 - 기관이 많고 하위 기관이 계속 생긴다).
 */
const ALLOWED_SUFFIXES = [".go.kr"] as const;

function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
}

/**
 * 이 주소의 호스트가 허용 목록에 있는가.
 *
 * **판단할 수 없으면 거부한다(fail-closed).** `pressDomains.isPressUrl`은 반대로 fail-open이다 -
 * 거기는 "막을 이유가 있어야 막는" 블랙리스트라 그렇고, 여기는 "허용할 이유가 있어야 쓰는"
 * 화이트리스트라 주소를 못 읽으면 쓸 이유도 없다.
 */
export function isAllowedKoreaplainImageSource(url: string): boolean {
  const host = hostOf(url);
  if (!host) return false;
  if (ALLOWED_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  // `pressDomains.ts`와 같은 모양의 호스트 매칭 - 정확히 같거나 점을 사이에 둔 하위 도메인.
  // 점 없이 endsWith만 쓰면 `notkorea.kr`이 `korea.kr`에 걸린다 - 그래서 `.${allowed}`로 경계를 단다.
  return ALLOWED_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

/**
 * 후보 하나를 쓸 수 있는가: **이미지 파일 주소와 출처 페이지가 둘 다** 허용 목록 안이어야 한다.
 *
 * 둘 다 보는 이유: 이미지 호스트만 보면 언론사 기사에 실린 공공 이미지가 통과하고(출처 표기가 언론사로
 * 나간다), 출처 페이지만 보면 공공 페이지에 걸어 둔 외부 이미지가 통과한다. 출처 페이지를 모르는
 * 후보(이미지 검색 결과 - collectWebImages가 이미지 origin을 출처로 대신 쓴다)는 이미지 주소만 본다.
 */
export function isAllowedKoreaplainCandidate(candidate: { imageUrl: string; sourcePage?: string | null }): boolean {
  if (!isAllowedKoreaplainImageSource(candidate.imageUrl)) return false;
  const sourcePage = (candidate.sourcePage ?? "").trim();
  return sourcePage === "" || isAllowedKoreaplainImageSource(sourcePage);
}

/** 이 job의 카테고리가 koreaplain 출처 정책을 받는 트랙인가. 다른 트랙은 전부 false라 동작이 그대로다. */
export function usesKoreaplainImagePolicy(category: string | null | undefined): boolean {
  return category === KOREAPLAIN_TRACK;
}

/** 허용 후보만 남기고 버린 것을 센다. 순서는 유지한다. */
export function filterKoreaplainCandidates<T extends { imageUrl: string; sourcePage?: string | null }>(
  candidates: T[]
): { kept: T[]; dropped: T[] } {
  const kept: T[] = [];
  const dropped: T[] = [];
  for (const candidate of candidates) {
    (isAllowedKoreaplainCandidate(candidate) ? kept : dropped).push(candidate);
  }
  return { kept, dropped };
}

/** 수집 기록(failures)에 남기는 한 줄. 사람이 "왜 자리가 비었는지" 알 수 있어야 한다. */
export function describeDroppedCandidates(count: number): string {
  return `ℹ️ 허용 출처가 아닌 후보 ${count}장을 버렸습니다(언론사·상업 사이트).`;
}

/**
 * AI로 만든 이미지의 캡션(2026-11-10).
 *
 * `Photo: …` 표기를 붙이지 않는다 - 사진이 아닌 것을 사진처럼 표기하면 독자를 오인시킨다. 기존 캡션
 * 규격(prompts/images/image-maker.md §7)이 "간단한 소개. 출처 표기" 두 요소이고 영문 출처 표기가
 * `Photo: <매체>`이므로, 같은 자리에 **`Illustration: AI-generated`** 를 둔다.
 *
 * 지우는 것: 획득 방식 꼬리(`— AI 생성`), 앞뒤의 `Photo:` 크레디트(웹 검색 캡션이 섞여 들어온 경우),
 * 폴백이 붙이는 한글 꼬리(`(웹 검색 실패 - AI 대체 장면)`) - 영문 발행본에 한글이 새면 안 된다.
 */
export const AI_ILLUSTRATION_CREDIT = "Illustration: AI-generated";

export function toIllustrationCaption(description: string): string {
  let intro = (description ?? "")
    .replace(/\s*—\s*(웹 검색|AI 생성|표 생성|인포그래픽 생성|페이지 캡처)\s*$/, "")
    // 한글이 든 괄호 꼬리는 파이프라인이 붙인 메모다(독자용 글이 아니다).
    .replace(/\s*\([^()]*[가-힣][^()]*\)\s*$/, "")
    .replace(/[.\s]*(Photo|Source|Image)\s*:\s*[^.]*$/i, "")
    .replace(/^\s*(Illustration|AI[- ]generated illustration)\s*:\s*/i, "")
    .trim();
  intro = intro.replace(/[.。\s]+$/, "");
  if (!intro) return AI_ILLUSTRATION_CREDIT;
  return `${intro}. ${AI_ILLUSTRATION_CREDIT}`;
}
