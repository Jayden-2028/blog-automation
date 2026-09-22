// 오버레이(워터마크·로고·번인 텍스트)가 있는 슬라이드의 **깨끗한 원본**을 찾는다.
//
// 2-a단계: 텍스트 검색 폴백(searchImagesMerged = 네이버 + Serper). 정확히 "같은 사진"이 아니라
// "같은 주제 사진"이라 정확도가 떨어진다 - 원 정책(INSTAGRAM_POSTING_CONVERTER.md)도 이것을
// 차선책으로 적어 뒀다. 최종 판단은 사람이 승인 단계에서 하므로 후보만 준비한다.
//
// 2-b단계(나중): lens.google.com에 슬라이드를 올려 진짜 리버스 이미지 검색. 무료지만 DOM 의존이
// 커서, 2-a를 실제로 돌려 보고 부족할 때 붙인다 - INSTAGRAM_CAPTURE_AUTOMATION.md 참고.
//
// 새 유료 API를 부르지 않는다. Serper는 이미 파이프라인이 쓰는 경로다.

import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { safeHeaderUrl } from "../images/collectWebImages.js";
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
  const { width, height } = candidate;
  // 크기를 모르는 후보는 버리지 않는다 - 네이버가 값을 안 줄 때가 있다.
  if (width !== null && height !== null && (width < MIN_EDGE || height < MIN_EDGE)) return false;
  return true;
}

async function download(url: string, referer: string | null): Promise<Buffer | null> {
  try {
    const headers = { ...HEADERS };
    if (referer) headers.Referer = safeHeaderUrl(referer);
    const response = await fetch(url, { headers, redirect: "follow" });
    if (!response.ok) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    return buffer.length > 0 ? buffer : null;
  } catch {
    return null;
  }
}

export type FindCleanAlternativeDeps = {
  search?: (query: string) => Promise<ImageCandidate[]>;
  fetchImage?: (url: string, referer: string | null) => Promise<Buffer | null>;
  /** 내려받은 파일을 둘 디렉터리. 캡처 임시 디렉터리를 그대로 쓴다. */
  tempDir: string;
};

export async function findCleanAlternative(
  input: { keyword: string; description: string; slideIndex: number },
  deps: FindCleanAlternativeDeps
): Promise<CleanAlternative | null> {
  const search = deps.search ?? searchImagesMerged;
  const fetchImage = deps.fetchImage ?? download;

  const query = buildAlternativeQuery(input.keyword, input.description);
  const candidates = (await search(query).catch(() => [])).filter(usable);

  // 후보를 순서대로 받아 본다 - 핫링크 차단으로 앞쪽이 막혀도 자리를 통째로 버리지 않는다
  // (2026-09-21에 고친 것과 같은 실패 유형).
  for (const candidate of candidates.slice(0, 5)) {
    const buffer = await fetchImage(candidate.link, candidate.sourcePage ?? null);
    if (!buffer) continue;

    const localPath = join(deps.tempDir, `alt-${input.slideIndex}.img`);
    await writeFile(localPath, buffer);
    return {
      localPath,
      // 출처 페이지를 모르면 이미지 URL이라도 남긴다 - 저작권 판단의 근거가 되어야 한다.
      sourcePage: candidate.sourcePage ?? candidate.link,
      note: `검색어 "${query}"로 찾은 대체 이미지(같은 사진이 아닐 수 있음 - 승인 단계에서 확인)`,
    };
  }

  return null;
}
