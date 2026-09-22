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

/**
 * 대체 이미지로 쓰지 않을 도메인(2026-09-23 사용자 결정).
 *
 * 왜 인스타를 빼는가: 지금 찾는 것은 오버레이가 없는 **깨끗한 원본**이다. 그런데 검색이
 * 물어온 게 또 다른 인스타 게시물이면 같은 종류의 뉴스 카드일 확률이 높고(번인 텍스트를
 * 피하려는 목적이 무너진다), 저작권 판단도 원본 게시물과 다를 바 없다. 실측에서 실제로
 * 다른 인스타 게시물이 출처로 잡혔다(job ec21f085).
 */
const BLOCKED_HOSTS = ["instagram.com", "cdninstagram.com", "fbcdn.net", "threads.net", "threads.com"];

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** 이미지 주소든 출처 페이지든 한쪽이라도 막힌 도메인이면 후보에서 뺀다. */
export function isBlockedSource(candidate: Pick<ImageCandidate, "link" | "sourcePage">): boolean {
  const hosts = [hostOf(candidate.link), candidate.sourcePage ? hostOf(candidate.sourcePage) : null];
  return hosts.some(
    (host) => host !== null && BLOCKED_HOSTS.some((blocked) => host === blocked || host.endsWith(`.${blocked}`))
  );
}

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
};

export async function findCleanAlternative(
  input: { keyword: string; description: string; slideIndex: number; tempDir: string },
  deps: FindCleanAlternativeDeps = {}
): Promise<CleanAlternative | null> {
  const search = deps.search ?? searchImagesMerged;
  const fetchImage = deps.fetchImage ?? download;

  const query = buildAlternativeQuery(input.keyword, input.description);
  const found = (await search(query).catch(() => [])).filter(usable);

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
        `검색어 "${query}"로 찾은 대체 이미지(같은 사진이 아닐 수 있음 - 승인 단계에서 확인)` +
        (unknownSource ? " ⚠️ 출처 페이지 불명(이미지 주소만 있음)" : ""),
    };
  }

  return null;
}
