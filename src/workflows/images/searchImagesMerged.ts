// 네이버 + 구글 이미지 검색 후보를 합친다(2026-09-21 사용자 결정 - 4안).
//
// 왜 둘 다인가: 색인이 다르다. 한국 연예·예능은 네이버가 강하고, 스포츠 현장·해외 인물·영화
// 스틸은 구글이 강하다. 실측 반려가 전부 후자였다("구글에선 수십 장 나오는데 자리가 비었다").
// 검색어를 다듬는 것만으로는 **색인에 없는 사진**을 찾을 수 없어 색인을 하나 더 붙인다.
//
// 합치는 방식은 **번갈아 끼우기**다. 한쪽을 앞에 몰아 넣으면 프롬프트에 실리는 상위 몇 장이
// 한 색인으로만 채워져, 다른 색인을 붙인 의미가 사라진다(에이전트는 앞쪽부터 본다).

import { searchNaverImages } from "./searchNaverImages.js";
import { searchSerperImages } from "./searchSerperImages.js";
import type { ImageCandidate, SearchImages } from "./searchNaverImages.js";

/** 같은 이미지가 두 색인에 다 있으면 한 번만 남긴다. */
function dedupe(candidates: ImageCandidate[]): ImageCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = candidate.link.split("?")[0];
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 두 목록을 번갈아 하나로. 한쪽이 짧으면 나머지는 뒤에 이어 붙인다. */
export function interleave(a: ImageCandidate[], b: ImageCandidate[]): ImageCandidate[] {
  const merged: ImageCandidate[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (i < a.length) merged.push(a[i]);
    if (i < b.length) merged.push(b[i]);
  }
  return dedupe(merged);
}

/**
 * 두 색인을 **동시에** 친다. 한쪽이 실패해도(키 없음·한도 초과·네트워크) 나머지로 계속 간다 -
 * 이미지 수집이 검색 한 곳의 사정으로 통째로 멈추면 안 된다.
 */
export const searchImagesMerged: SearchImages = async (query) => {
  const [naver, google] = await Promise.all([
    searchNaverImages(query).catch(() => [] as ImageCandidate[]),
    searchSerperImages(query).catch(() => [] as ImageCandidate[]),
  ]);
  return interleave(naver, google);
};
