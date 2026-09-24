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
};

/**
 * 본문에서 `표 생성` 마커 쌍을 지운다. 앞뒤로 생긴 빈 줄도 정리한다.
 *
 * 마커가 없으면 **원본 문자열을 그대로** 돌려준다(불필요한 저장을 피한다).
 */
export function removeTableMarkers(body: string): RemoveTableMarkersResult {
  const lines = body.split("\n");
  const kept: string[] = [];
  let removed = 0;

  for (let i = 0; i < lines.length; i += 1) {
    if (TABLE_MARKER.test(lines[i].trim())) {
      removed += 1;
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

  if (removed === 0) return { body, removed: 0 };
  return { body: kept.join("\n"), removed };
}

/**
 * 지정한 **자리 번호**의 이미지 마커를 지운다(2026-09-24 "이미지 수정 - 삭제" 지원).
 *
 * 번호는 본문에 나온 `[IMAGE:]` 순서다(1부터). 획득 방식과 무관하게 지운다 - 사람이 그 자리를
 * 없애 달라고 한 것이므로 종류를 따지지 않는다.
 */
export function removeMarkersAt(body: string, indexes: readonly number[]): RemoveTableMarkersResult {
  const wanted = new Set(indexes);
  if (wanted.size === 0) return { body, removed: 0 };

  const lines = body.split("\n");
  const kept: string[] = [];
  let seen = 0;
  let removed = 0;

  for (let i = 0; i < lines.length; i += 1) {
    if (/^\[IMAGE:/.test(lines[i].trim())) {
      seen += 1;
      if (wanted.has(seen)) {
        removed += 1;
        if (PROMPT_LINE.test((lines[i + 1] ?? "").trim())) i += 1;
        while (kept.length > 0 && kept[kept.length - 1].trim() === "" && (lines[i + 1] ?? "").trim() === "") {
          kept.pop();
        }
        continue;
      }
    }
    kept.push(lines[i]);
  }

  if (removed === 0) return { body, removed: 0 };
  return { body: kept.join("\n"), removed };
}
