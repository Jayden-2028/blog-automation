// koreaplain(Korea Plain) 트랙이 이미지를 가져와도 되는 출처 목록(2026-11-10 사용자 결정).
//
// 왜 만들었나(팀장 세션 실측): 발행본 71건 중 61건(86%)이 언론사·상업 사이트 사진을 싣고 있었다.
// 출처 표기(`Photo: Naver News`)만 있고 라이선스는 없으며, 파일은 우리 Cloudflare Pages 도메인에
// 복사돼 서비스된다. 구글 퍼블리셔 정책은 저작권 침해를 금지하고, 연합뉴스·뉴스1 같은 곳은 실제로
// 라이선스를 추심한다. 애드센스 수익화를 앞둔 사이트라 그대로 둘 수 없었다.
//
// 그래서 이 트랙의 이미지 자리는 아래 순서로만 채운다(2026-11-25 음식 전환에서 ①을 맨 앞에 넣었다 - 실제 사진 우선).
//   ① 한국관광공사 관광사진 API(collectKtoPhotos.ts) - 공공누리 제1유형, 한글 음식명으로 찾는다. 이미지는
//      tong.visitkorea.or.kr(아래 visitkorea.or.kr 하위)이라 이 목록 안이다. 키 `KTO_SERVICE_KEY`가 없으면 건너뛴다.
//   ② 공공·공식 자료(웹 검색) - **이 파일의 목록 안에 있는 호스트만**
//   ③ 공식 페이지 캡처(capturePagesForJob) - 화면 자체가 정보인 자리(요금표·운영시간·기관 안내)
//   ④ AI 생성(generateManuscriptImages, quality low 고정) - **설명 그림**(지도·상차림 도식·주문 순서)만.
//      실사 음식 사진을 대신하지 않는다 - 프롬프트 앞에 고정 일러스트 스타일(KOREAPLAIN_ILLUSTRATION_STYLE)이 붙는다.
// **한식진흥원(hansik.or.kr) 사진은 쓰지 않는다**(2026-11-25 사용자 결정 - 목록에 넣지 않는다). 일반 웹 검색 사진(언론·블로그·
// 상업 사이트)은 그대로 금지다.
//
// ①·②로 받은 실제 사진은 올릴 때 **톤을 맞춘다**(services/images/photoGrade.ts - 16:9 중앙 크롭 1600×900, 밝기·대비 정규화,
// 약간 따뜻한 색온도, 강도 상수 한 곳). 그래서 **변경 금지 라이선스(CC BY-ND, 공공누리 제3·4유형)는 보정 대신 제외**한다
// (isNoDerivativesLicense). 관광사진 출처 표기는 `Photo: Korea Tourism Organization (촬영자), KOGL Type 1`이다(toKtoPhotoCaption).
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

// ---------- 한국관광공사 관광사진(공공누리 제1유형) 출처 표기(2026-11-25) ----------

/**
 * 관광사진 API 사진의 출처 표기. 공공누리 제1유형은 **출처 표시**가 이용 조건이다. 기존 캡션 규격("소개. 출처")의
 * 영문 출처 자리(`Photo: <기관>`)에 촬영자와 유형을 붙인다:
 *   `Photo: Korea Tourism Organization (Kim Jiho), KOGL Type 1`
 * 촬영자를 로마자로 옮길 수 없으면(한글 단체명 등) 괄호를 뺀다 - 영문 발행본에 한글을 새게 하지 않는다.
 */
export const KTO_PHOTO_ORG = "Korea Tourism Organization";
export const KOGL_TYPE1_LABEL = "KOGL Type 1";
/** manifest·뷰어에 남기는 재사용 근거(사람이 읽는 값). */
export const KTO_PHOTO_LICENSE = "공공누리 제1유형(KOGL Type 1) - 한국관광공사 관광사진";

export function ktoPhotoCredit(photographer: string | null | undefined): string {
  const name = romanizePhotographer(photographer ?? "");
  return `Photo: ${KTO_PHOTO_ORG}${name ? ` (${name})` : ""}, ${KOGL_TYPE1_LABEL}`;
}

/** 캡션 = 소개 한 문장 + 관광사진 출처 표기. 소개에 붙어 온 다른 출처 표기(`Photo: …`)·획득 방식 꼬리는 뗀다. */
export function toKtoPhotoCaption(intro: string, photographer: string | null | undefined): string {
  const cleaned = (intro ?? "")
    .replace(/\s*—\s*(웹 검색|AI 생성|표 생성|인포그래픽 생성|페이지 캡처)\s*$/, "")
    .replace(/\s*\([^()]*[가-힣][^()]*\)\s*$/, "")
    .replace(/[.\s]*(Photo|Source|Image|사진|출처)\s*[:=]\s*[^.]*$/i, "")
    .trim()
    .replace(/[.。\s]+$/, "");
  const credit = ktoPhotoCredit(photographer);
  // 한글이 남은 소개는 영문 발행본에 쓸 수 없다 - 출처 표기만 남긴다(뷰어에서 사람이 고친다).
  if (!cleaned || /[가-힣]/.test(cleaned)) return credit;
  return `${cleaned}. ${credit}`;
}

const INITIALS = ["g", "kk", "n", "d", "tt", "r", "m", "b", "pp", "s", "ss", "", "j", "jj", "ch", "k", "t", "p", "h"];
const MEDIALS = ["a", "ae", "ya", "yae", "eo", "e", "yeo", "ye", "o", "wa", "wae", "oe", "yo", "u", "wo", "we", "wi", "yu", "eu", "ui", "i"];
const FINALS = ["", "k", "k", "k", "n", "n", "n", "t", "l", "k", "m", "l", "l", "l", "p", "l", "m", "p", "p", "t", "t", "ng", "t", "t", "k", "t", "p", "t"];

/** 성씨 관용 표기(여권·언론 관행). 표에 없는 성은 국어의 로마자 표기법 그대로 옮긴다. */
const SURNAMES: Record<string, string> = {
  김: "Kim", 이: "Lee", 박: "Park", 최: "Choi", 정: "Jung", 강: "Kang", 조: "Cho", 윤: "Yoon", 장: "Jang", 임: "Lim",
  한: "Han", 오: "Oh", 서: "Seo", 신: "Shin", 권: "Kwon", 황: "Hwang", 안: "Ahn", 송: "Song", 류: "Ryu", 유: "Yoo",
  홍: "Hong", 전: "Jeon", 고: "Ko", 문: "Moon", 양: "Yang", 손: "Son", 배: "Bae", 백: "Baek", 허: "Heo", 노: "Noh",
  남: "Nam", 심: "Shim", 하: "Ha", 곽: "Kwak", 성: "Sung", 차: "Cha", 주: "Joo", 우: "Woo", 구: "Koo", 민: "Min",
  진: "Jin", 나: "Na", 엄: "Eom", 채: "Chae", 원: "Won", 천: "Cheon", 방: "Bang", 공: "Kong", 현: "Hyun", 함: "Ham",
  변: "Byun", 염: "Yeom", 여: "Yeo", 추: "Choo", 도: "Do", 석: "Seok", 선: "Sun", 설: "Seol", 마: "Ma", 길: "Gil",
  연: "Yeon", 표: "Pyo", 명: "Myung", 기: "Ki", 반: "Ban", 왕: "Wang", 금: "Keum", 옥: "Ok", 육: "Yuk", 인: "In",
  맹: "Maeng", 제: "Je", 모: "Mo", 탁: "Tak", 국: "Kook", 어: "Eo", 은: "Eun", 편: "Pyeon", 용: "Yong", 예: "Ye",
};

/** 한글 음절열을 국어의 로마자 표기법(음운 변화 없이, 이름 표기 관행)으로 옮긴다. 한글이 아닌 글자가 있으면 null. */
function romanizeSyllables(hangul: string): string | null {
  let out = "";
  for (const char of hangul) {
    const code = char.charCodeAt(0) - 0xac00;
    if (code < 0 || code > 11171) return null;
    out += INITIALS[Math.floor(code / 588)] + MEDIALS[Math.floor((code % 588) / 28)] + FINALS[code % 28];
  }
  return out;
}

/**
 * 관광사진 촬영자 표기를 영문 크레딧용으로 옮긴다. 옮길 수 없으면 빈 문자열(크레딧에서 괄호가 빠진다).
 *  - "한국관광공사 김지호" → "Kim Jiho"(기관 접두는 뗀다 - 기관은 크레딧 본문에 이미 있다)
 *  - "IR 스튜디오 이창용" → "Lee Changyong"(마지막 토큰이 2~4자 한글 이름이면 그것만)
 *  - 로마자 이름은 그대로, 한글 단체명("라이브스튜디오")은 빈 문자열.
 */
export function romanizePhotographer(raw: string): string {
  const cleaned = (raw ?? "")
    .replace(/한국관광공사|관광공사|Korea Tourism Organization|KTO/gi, " ")
    .replace(/[()[\]·,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  if (!/[가-힣]/.test(cleaned)) return /^[A-Za-z][A-Za-z .'-]{1,40}$/.test(cleaned) ? cleaned : "";
  const last = cleaned.split(" ").pop() ?? "";
  if (!/^[가-힣]{2,4}$/.test(last)) return "";
  const surname = SURNAMES[last[0]];
  if (!surname) return "";
  const given = romanizeSyllables(last.slice(1));
  if (!given) return "";
  return `${surname} ${given.charAt(0).toUpperCase()}${given.slice(1)}`;
}

/**
 * 변경 금지 라이선스인가(2026-11-25). koreaplain 실제 사진은 톤 보정(크롭·색 보정)을 거치는데, 변경 금지(CC BY-ND,
 * 공공누리 제3·4유형)는 그 자체가 위반이다. 그런 후보는 보정 대신 **제외**한다. 분류(`cc_nd`)나 라이선스 문구로 본다.
 */
export function isNoDerivativesLicense(license: string | null | undefined, reusePermission?: string | null): boolean {
  if (reusePermission === "cc_nd") return true;
  const value = (license ?? "").toLowerCase();
  if (!value) return false;
  return (
    /\bnd\b|-nd\b|by-nd|nc-nd|noderiv|no deriv|no-deriv/.test(value) ||
    /변경\s*금지|변경금지/.test(value) ||
    /(공공누리|kogl)\s*(제\s*)?[34]\s*유형|kogl\s*type\s*[34]/.test(value)
  );
}

// ---------- AI 생성 = 설명 그림(2026-11-25) ----------

/**
 * koreaplain의 AI 이미지는 **실사 음식 사진을 대신하지 않는다** - 지도·상차림 도식·주문 순서 같은 설명 그림이다. 실사처럼 만든
 * 음식 사진은 독자가 실물로 오해하고(평양냉면 모양을 틀리게 그린 위험 - KOREAPLAIN-FOOD-PIVOT-2026-11.md), 실사 사진(관광사진)과
 * 톤도 섞이지 않는다. 그래서 생성 프롬프트 앞에 **이 한 줄 스타일**을 고정으로 붙인다(generateManuscriptImages의 aiIllustrations).
 * 스타일을 바꾸려면 이 문자열 하나만 고친다.
 */
export const KOREAPLAIN_ILLUSTRATION_STYLE =
  "Flat vector editorial illustration, clean outlines, soft warm palette of cream, terracotta, mustard and sage green, simple shapes, subtle paper texture, not photorealistic";

/**
 * 생성 프롬프트를 설명 그림 스타일로 고정한다. 실사 지시어(`photorealistic photograph of` 등)는 지우고 스타일 한 줄을 앞에 붙인다.
 * `no text`·비율 표기는 원래 프롬프트에 있으면 그대로 남고, 없으면 붙인다(validateAiPrompt 규칙).
 */
export function toIllustrationPrompt(prompt: string): string {
  if ((prompt ?? "").startsWith(KOREAPLAIN_ILLUSTRATION_STYLE)) return prompt;
  let body = (prompt ?? "")
    .replace(/\b(ultra[- ]?)?photo[- ]?realistic(\s+(photograph|photo|image|shot))?(\s+of)?\s*,?\s*/gi, "")
    .replace(/\b(realistic|dslr|stock)\s+(photograph|photo)(\s+of)?\s*,?\s*/gi, "")
    .replace(/^\s*(a\s+)?(photograph|photo)\s+of\s+/i, "")
    .replace(/\s{2,}/g, " ")
    .trim()
    .replace(/^[,.\s]+/, "");
  if (!/no\s+text/i.test(body)) body = `${body.replace(/[.\s]+$/, "")}, no text, no letters`;
  if (!/\d+\s*:\s*\d+/.test(body)) body = `${body.replace(/[.\s]+$/, "")}, 16:9`;
  return `${KOREAPLAIN_ILLUSTRATION_STYLE}. ${body}`;
}
