// `— 표 생성` 이미지 자리를 본문에서 **없앤다**(2026-09-24 사용자 결정).
//
// 사용자 규칙 메인 5번: **본문 텍스트를 그대로 이미지로 옮겨둔 표는 모든 원고에서 금지.**
//
// 왜 "안 그린다"가 아니라 "마커를 지운다"인가: 안 그리기만 하면 뷰어에 빈 자리가 남는다.
// 실측(오상욱 원고) 5번이 정확히 그 상태였다 - "9월 23일 기준 한국 아시안게임 메달 집계 —
// 표 생성"이라는 빈 칸이 남아 사람이 "표 이미지 삭제하세요"라고 따로 요청해야 했다.
//
// 이 규칙은 **순위 캡처(`페이지 캡처`)와 무관하다.** 그쪽은 원본 사이트 화면이지 본문을 옮긴
// 표가 아니다. 여기서 지우는 것은 `표 생성` 마커뿐이다.

/** `[IMAGE: ... — 표 생성]` 한 줄. 설명 안에 대괄호가 없다는 전제는 다른 마커 파서와 같다. */
const TABLE_MARKER = /^\[IMAGE:\s*[\s\S]*?—\s*표\s*생성\s*\]\s*$/;
/** 마커 바로 다음 줄에 붙는 프롬프트. 마커를 지우면 이것도 같이 지운다. */
const PROMPT_LINE = /^\[IMAGE\s*PROMPT\s*:/i;

export type RemoveTableMarkersResult = {
  body: string;
  /** 지운 자리 수. 0이면 본문이 그대로다. */
  removed: number;
  /**
   * **지운 자리의 원래 번호**(1부터). 마커를 지우면 그 뒤 자리 번호가 전부 하나씩 당겨지므로,
   * 번호로 붙어 있는 metadata(images·imageRequirements·imageDirectUrls)도 같이 옮겨야 한다.
   *
   * 실측 사고(2026-09-24 오상욱): 5번 표 마커를 지워 본문은 1~5가 됐는데 metadata는 1~6 그대로라,
   * 사용자가 6번에 준 이미지 주소가 **존재하지 않는 자리**를 가리키게 됐다.
   */
  removedIndexes: number[];
};

/**
 * 자리 번호로 매긴 값들을 지운 자리에 맞춰 **당긴다**.
 *
 * 지워진 번호의 값은 버리고, 그보다 큰 번호는 지워진 개수만큼 내린다.
 */
export function shiftIndexedRecord<T>(
  record: Record<string, T> | null | undefined,
  removedIndexes: readonly number[]
): Record<string, T> | null {
  if (!record) return null;
  const removed = [...removedIndexes].sort((a, b) => a - b);
  const out: Record<string, T> = {};
  for (const [key, value] of Object.entries(record)) {
    const index = Number(key);
    if (!Number.isInteger(index) || removed.includes(index)) continue;
    out[String(index - removed.filter((r) => r < index).length)] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** 이미지 배열도 같은 규칙으로 당긴다. */
export function shiftImageIndexes<T extends { index: number }>(
  images: readonly T[],
  removedIndexes: readonly number[]
): T[] {
  const removed = [...removedIndexes].sort((a, b) => a - b);
  return images
    .filter((image) => !removed.includes(image.index))
    .map((image) => ({ ...image, index: image.index - removed.filter((r) => r < image.index).length }));
}

/**
 * 본문에서 `표 생성` 마커 쌍을 지운다. 앞뒤로 생긴 빈 줄도 정리한다.
 *
 * 마커가 없으면 **원본 문자열을 그대로** 돌려준다(불필요한 저장을 피한다).
 */
export function removeTableMarkers(body: string): RemoveTableMarkersResult {
  const lines = body.split("\n");
  const kept: string[] = [];
  const removedIndexes: number[] = [];
  let seen = 0;

  for (let i = 0; i < lines.length; i += 1) {
    if (/^\[IMAGE:/.test(lines[i].trim())) seen += 1;
    if (TABLE_MARKER.test(lines[i].trim())) {
      removedIndexes.push(seen);
      // 바로 다음 줄이 프롬프트면 함께 버린다.
      if (PROMPT_LINE.test((lines[i + 1] ?? "").trim())) i += 1;
      // 마커 앞뒤의 빈 줄이 겹쳐 세 줄이 되는 것을 막는다.
      while (kept.length > 0 && kept[kept.length - 1].trim() === "" && (lines[i + 1] ?? "").trim() === "") {
        kept.pop();
      }
      continue;
    }
    kept.push(lines[i]);
  }

  if (removedIndexes.length === 0) return { body, removed: 0, removedIndexes: [] };
  return { body: kept.join("\n"), removed: removedIndexes.length, removedIndexes };
}

/**
 * 지정한 **자리 번호**의 이미지 마커를 지운다(2026-09-24 "이미지 수정 - 삭제" 지원).
 *
 * 번호는 본문에 나온 `[IMAGE:]` 순서다(1부터). 획득 방식과 무관하게 지운다 - 사람이 그 자리를
 * 없애 달라고 한 것이므로 종류를 따지지 않는다.
 */
export function removeMarkersAt(body: string, indexes: readonly number[]): RemoveTableMarkersResult {
  const wanted = new Set(indexes);
  if (wanted.size === 0) return { body, removed: 0, removedIndexes: [] };

  const lines = body.split("\n");
  const kept: string[] = [];
  const removedIndexes: number[] = [];
  let seen = 0;

  for (let i = 0; i < lines.length; i += 1) {
    if (/^\[IMAGE:/.test(lines[i].trim())) {
      seen += 1;
      if (wanted.has(seen)) {
        removedIndexes.push(seen);
        if (PROMPT_LINE.test((lines[i + 1] ?? "").trim())) i += 1;
        while (kept.length > 0 && kept[kept.length - 1].trim() === "" && (lines[i + 1] ?? "").trim() === "") {
          kept.pop();
        }
        continue;
      }
    }
    kept.push(lines[i]);
  }

  if (removedIndexes.length === 0) return { body, removed: 0, removedIndexes: [] };
  return { body: kept.join("\n"), removed: removedIndexes.length, removedIndexes };
}
