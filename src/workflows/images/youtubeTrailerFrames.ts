// 유튜브 공식 예고편의 자동 생성 프레임을 이미지 후보로 끌어온다(2026-10-01 사용자 지시).
//
// 왜 필요한가: 작품(드라마·영화·OTT) 자리의 1순위는 공식 스틸인데, 공식 페이지도 키노라이츠도
// 못 찾으면 자리가 빈다. 규격(`image-maker.md` §4-1)은 예고편 컷 추출을 허용하지만 파이프라인에
// 기능이 없어 "기능이 생기기 전까지는 1·2로 채운다"고 적혀 있었다. 그 기능이다.
//
// **유튜브가 모든 영상에 자동으로 뽑아 두는 프레임 3장을 쓴다.**
//
//   https://i.ytimg.com/vi/<videoId>/maxres1.jpg   (maxres2, maxres3)
//
// 업로더가 고른 커스텀 썸네일(`maxresdefault.jpg`)과는 **다른 이미지**이고, 영상의 대략 25%·50%·
// 75% 지점이라 서로 다른 장면이다. 인증·API 키·쿼터가 없고 단순 GET 한 번이라 GitHub Actions에서
// 그대로 돈다(실측 2026-10-01: 영상 3편 모두 1280x720, HTTP 200).
//
// 왜 이 방식인가(다른 길을 전부 재 본 뒤의 결론):
//   - 공식 Data API의 `maxres`도 **상한이 1280x720**이다. 즉 공식 경로로 받을 수 있는 최대 화질과
//     같은 것을 키 없이 받는 셈이다.
//   - yt-dlp + ffmpeg는 화질이 더 좋지만 **클라우드에서 봇 차단에 막힌다**(실측:
//     "Sign in to confirm you're not a bot"). 맥 로컬이면 되지만 유튜브 약관에 가장 정면으로 걸린다.
//   - 영상 프레임 추출 MCP는 원본이 256x144라 본문 이미지로 못 쓴다.
//
// 한계: **시점을 고를 수 없다.** 3장이 전부다. "그 대사를 하는 그 표정"이 필요한 자리는 못 맞춘다.
// 그런 자리가 실제로 많으면 그때 맥 경로를 얹는다.
//
// 영상 ID는 **리서치 파일에서 긁는다.** 작품 job의 약 16%에 유튜브 링크가 들어 있다(실측
// 2026-09-20 이후 86건 중 14건). 나머지는 이 경로가 조용히 비활성이고 기존 흐름 그대로다.
// 틀린 영상(예고편이 아닌 예능 클립)이 섞여도 **후보일 뿐**이라, 뒤의 검증 에이전트가 사진을 열어
// 보고 자리에 맞지 않으면 떨어뜨린다.

import type { ImageCandidate } from "./searchNaverImages.js";

/** 자동 생성 프레임 번호. 0은 존재하지 않고 4 이상도 없다(실측). */
const FRAME_NUMBERS = [1, 2, 3] as const;

/** 유튜브 영상 ID는 11자다. */
const VIDEO_ID = "[A-Za-z0-9_-]{11}";

const URL_PATTERNS = [
  new RegExp(`youtube\\.com/watch\\?(?:[^\\s"'<>]*&)?v=(${VIDEO_ID})`, "gi"),
  new RegExp(`youtu\\.be/(${VIDEO_ID})`, "gi"),
  new RegExp(`youtube\\.com/embed/(${VIDEO_ID})`, "gi"),
  new RegExp(`youtube\\.com/shorts/(${VIDEO_ID})`, "gi"),
  new RegExp(`youtube\\.com/live/(${VIDEO_ID})`, "gi"),
];

/**
 * 글에서 유튜브 영상 ID를 등장 순서대로 뽑는다(중복 제거).
 *
 * 리서치 파일 전문을 그대로 넣는 용도라 "URL처럼 생긴 것"만 본다 - 본문 문장에서 11자 토큰을
 * 긁으면 엉뚱한 것이 걸린다.
 */
export function extractYoutubeVideoIds(text: string, limit = 3): string[] {
  if (!text) return [];
  const ids: string[] = [];
  for (const pattern of URL_PATTERNS) {
    pattern.lastIndex = 0;
    let match = pattern.exec(text);
    while (match) {
      const id = match[1];
      if (!ids.includes(id)) ids.push(id);
      match = pattern.exec(text);
    }
  }
  return ids.slice(0, limit);
}

export function trailerFrameUrl(videoId: string, frame: number): string {
  return `https://i.ytimg.com/vi/${videoId}/maxres${frame}.jpg`;
}

export function youtubeWatchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

export type TrailerFrameOptions = {
  /** 존재 확인용. 기본은 HEAD 요청. 테스트가 갈아 끼운다. */
  headImage?: (url: string) => Promise<boolean>;
  /** 한 영상에서 가져올 최대 장수. */
  maxPerVideo?: number;
};

/** 기본 존재 확인 - HEAD 한 번. 404면 그 번호의 프레임이 없다(720p 미만 업로드 등). */
async function defaultHeadImage(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: "HEAD" });
    if (!res.ok) return false;
    return (res.headers.get("content-type") ?? "").startsWith("image/");
  } catch {
    return false;
  }
}

/**
 * 영상 ID 목록 → 이미지 후보. 존재하는 프레임만 돌려준다.
 *
 * 크기를 1280x720으로 **단언해서** 넣는다(실측 고정값). 작품 자리의 선호 하한이 900px이라,
 * 크기를 모른다고 두면 그 필터에서 "모름"으로 통과하긴 하지만 정렬에서 뒤로 밀린다.
 */
export async function fetchTrailerFrameCandidates(
  videoIds: string[],
  options: TrailerFrameOptions = {}
): Promise<ImageCandidate[]> {
  const headImage = options.headImage ?? defaultHeadImage;
  const maxPerVideo = options.maxPerVideo ?? FRAME_NUMBERS.length;

  const candidates: ImageCandidate[] = [];
  for (const videoId of videoIds) {
    const frames = FRAME_NUMBERS.slice(0, maxPerVideo);
    const checked = await Promise.all(
      frames.map(async (frame) => {
        const url = trailerFrameUrl(videoId, frame);
        return (await headImage(url)) ? { frame, url } : null;
      })
    );
    for (const hit of checked) {
      if (!hit) continue;
      candidates.push({
        title: `유튜브 공식 영상 자동 프레임 ${hit.frame}`,
        link: hit.url,
        thumbnail: hit.url,
        width: 1280,
        height: 720,
        sourcePage: youtubeWatchUrl(videoId),
      });
    }
  }
  return candidates;
}
