// 오버레이(워터마크·로고·번인 텍스트)가 있는 슬라이드의 **깨끗한 원본**을 찾는다.
//
// 2-a단계: 텍스트 검색 폴백(searchImagesMerged = 네이버 + Serper). 정확히 "같은 사진"이 아니라
// "같은 주제 사진"이라 정확도가 떨어진다 - 원 정책(INSTAGRAM_POSTING_CONVERTER.md)도 이것을
// 차선책으로 적어 뒀다. 최종 판단은 사람이 승인 단계에서 하므로 후보만 준비한다.
//
// 2-b단계(2026-09-23 붙임): lens.google.com에 슬라이드를 올려 진짜 리버스 이미지 검색. 2-a를
// 실제로 돌려 보니 엉뚱한 출처가 붙어(job ec21f085 - 다른 인스타 게시물) 조건이 충족됐다.
// **렌즈를 먼저 쓰고, 못 구하면 2-a로 떨어진다** - 렌즈는 CAPTCHA로 막힐 수 있어서 단독으로
// 세울 수 없다(reverseImageSearch.ts).
//
// 새 유료 API를 부르지 않는다. Serper는 이미 파이프라인이 쓰는 경로다.

import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { safeHeaderUrl } from "../images/collectWebImages.js";
import { isBlockedSource } from "./blockedSources.js";
import { reverseImageSearch } from "./reverseImageSearch.js";
import type { ReverseSearchResult } from "./reverseImageSearch.js";
import { searchImagesMerged } from "../images/searchImagesMerged.js";
import type { ImageCandidate } from "../images/searchNaverImages.js";
import type { CleanAlternative } from "./runCaptureSession.js";

/** 핫링크 차단을 피하려고 브라우저처럼 보이게 한다(collectWebImages.ts와 같은 이유). */
const HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
  Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
};

/** 본문에서 알아볼 수 있는 최소 크기. collectWebImages의 완화된 기준(2026-09-21)과 맞춘다. */
const MIN_EDGE = 400;

export function buildAlternativeQuery(keyword: string, description: string): string {
  // 설명이 길면 검색이 0건으로 끝난다("2022년 인스타그램 셀카 사진" 같은 수식이 붙는 문제와 같다).
  // 주제어를 앞에 두고 설명은 짧게 덧붙인다.
  const trimmed = description.trim().split(/\s+/).slice(0, 6).join(" ");
  return trimmed ? `${keyword} ${trimmed}` : keyword;
}

function usable(candidate: ImageCandidate): boolean {
  if (!candidate.link) return false;
  if (isBlockedSource(candidate)) return false;
  const { width, height } = candidate;
  // 크기를 모르는 후보는 버리지 않는다 - 네이버가 값을 안 줄 때가 있다.
  if (width !== null && height !== null && (width < MIN_EDGE || height < MIN_EDGE)) return false;
  return true;
}

// 2-a와 2-b가 같은 규칙을 쓰도록 공용 모듈에서 가져와 다시 내보낸다.
export { isBlockedSource };

export type Downloaded = { buffer: Buffer; contentType: string };

async function download(url: string, referer: string | null): Promise<Downloaded | null> {
  try {
    const headers = { ...HEADERS };
    if (referer) headers.Referer = safeHeaderUrl(referer);
    const response = await fetch(url, { headers, redirect: "follow" });
    if (!response.ok) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) return null;
    return { buffer, contentType: response.headers.get("content-type") ?? "" };
  } catch {
    return null;
  }
}

/**
 * 파일 확장자를 실제 content-type에서 정한다.
 *
 * 왜 중요한가: createInstagramJob의 guessMimeType은 **확장자만 보고** MIME을 정하고, 그 MIME이
 * Storage에 저장되는 content-type이자 파일 확장자가 된다(uploadArticleImage). 확장자를 .img처럼
 * 두면 전부 image/png로 올라가, 내용은 JPEG인데 png라고 적힌 파일이 나간다.
 */
export function extensionForContentType(contentType: string): string {
  const type = contentType.split(";")[0].trim().toLowerCase();
  if (type === "image/jpeg" || type === "image/jpg") return "jpg";
  if (type === "image/webp") return "webp";
  if (type === "image/gif") return "gif";
  return "png";
}

export type FindCleanAlternativeDeps = {
  search?: (query: string) => Promise<ImageCandidate[]>;
  fetchImage?: (url: string, referer: string | null) => Promise<Downloaded | null>;
  reverseSearch?: (slidePath: string) => Promise<ReverseSearchResult>;
};

export type FindCleanAlternativeInput = {
  keyword: string;
  description: string;
  slideIndex: number;
  tempDir: string;
  /** 오버레이가 있는 그 슬라이드의 파일 경로. 리버스 검색의 입력이다. 없으면 2-a만 쓴다. */
  slidePath?: string | null;
};

export async function findCleanAlternative(
  input: FindCleanAlternativeInput,
  deps: FindCleanAlternativeDeps = {}
): Promise<CleanAlternative | null> {
  const search = deps.search ?? searchImagesMerged;
  const fetchImage = deps.fetchImage ?? download;
  const reverse = deps.reverseSearch ?? ((slidePath: string) => reverseImageSearch(slidePath));

  const query = buildAlternativeQuery(input.keyword, input.description);

  // 2-b: 같은 사진을 먼저 찾는다. 꺼져 있거나(skipped) 막히면(blocked) 조용히 2-a로 간다 -
  // 여기서 멈추면 렌즈가 막힌 날에는 대체 이미지가 통째로 사라진다.
  let reverseHits: ImageCandidate[] = [];
  let via: "reverse" | "text" = "text";
  if (input.slidePath) {
    const result = await reverse(input.slidePath).catch(
      (error): ReverseSearchResult => ({ status: "failed", error: String(error) })
    );
    if (result.status === "ok") {
      reverseHits = result.candidates.filter(usable);
    } else if (result.status === "blocked") {
      console.warn("⚠️ [ig-capture] 구글 렌즈가 막혔습니다(CAPTCHA) - 텍스트 검색으로 갑니다.");
    } else if (result.status === "failed") {
      console.warn(`⚠️ [ig-capture] 리버스 검색 실패: ${result.error} - 텍스트 검색으로 갑니다.`);
    }
  }

  const textHits = reverseHits.length > 0 ? [] : (await search(query).catch(() => [])).filter(usable);
  if (reverseHits.length > 0) via = "reverse";
  const found = reverseHits.length > 0 ? reverseHits : textHits;

  // **출처 페이지가 있는 후보를 먼저 쓴다**(2026-09-22 실측 대응). 네이버 이미지 검색은
  // sourcePage를 주지 않아 폴백이 이미지 파일 URL을 출처로 남겼다
  // (http://imgnews.naver.net/.../0003806827_001.jpg). 그건 사람이 열어 저작권을 판단할 수 있는
  // 페이지가 아니라, 정책(INSTAGRAM_POSTING_CONVERTER.md - web_alternative는 sourcePage 필수)의
  // 근거가 사라진다. 구글(Serper)은 contextLink로 출처 페이지를 준다.
  const candidates = [...found.filter((c) => c.sourcePage), ...found.filter((c) => !c.sourcePage)];

  // 후보를 순서대로 받아 본다 - 핫링크 차단으로 앞쪽이 막혀도 자리를 통째로 버리지 않는다
  // (2026-09-21에 고친 것과 같은 실패 유형).
  for (const candidate of candidates.slice(0, 5)) {
    const downloaded = await fetchImage(candidate.link, candidate.sourcePage ?? null);
    if (!downloaded) continue;

    // 캡처 임시 디렉터리에 쓴다 - cleanup이 같이 지우고, 항목끼리 파일명이 부딪히지 않는다.
    const localPath = join(input.tempDir, `alt-${input.slideIndex}.${extensionForContentType(downloaded.contentType)}`);
    await writeFile(localPath, downloaded.buffer);
    // 출처 페이지를 끝내 못 구하면 이미지 URL이라도 남기되, **그 사실을 note에 적는다** -
    // 승인 단계에서 사람이 "출처를 열어볼 수 없는 후보"임을 알고 판단해야 한다.
    const unknownSource = !candidate.sourcePage;
    return {
      localPath,
      sourcePage: candidate.sourcePage ?? candidate.link,
      note:
        (via === "reverse"
          ? // 렌즈가 지목한 것은 **페이지**다. 거기서 실제로 받는 것은 그 페이지의 og:image이고,
            // 그건 기사 대표 이미지라 렌즈가 매칭한 사진과 다를 수 있다(2026-09-23 실측:
            // 인스타는 정우성·박정민 2인 사진, og:image는 4개월 전 기사의 3인 사진이었다).
            // "같은 사진"이라고 적으면 승인 단계에서 사람이 과신한다.
            "구글 렌즈가 지목한 출처 페이지의 대표 이미지(같은 사진이 아닐 수 있음 - 승인 단계에서 확인)"
          : `검색어 "${query}"로 찾은 대체 이미지(같은 사진이 아닐 수 있음 - 승인 단계에서 확인)`) +
        (unknownSource ? " ⚠️ 출처 페이지 불명(이미지 주소만 있음)" : ""),
    };
  }

  return null;
}
