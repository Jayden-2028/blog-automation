// 단체 사진·2샷·합성컷 허용 스위치(2026-10-02 사용자 결정).
//
// **기본은 허용이다.** 옛 규칙 "단독 인물 자리에 단체 사진을 넣지 않는다 / 합성컷은 단독 사진이
// 하나라도 있으면 고르지 않는다"를 폐지했다. 사용자 판단: 영상물(드라마·영화·OTT·예능·방송)은 배우
// 2샷·단체샷이 공식 스틸의 대부분이라, 이 규칙 때문에 **자리가 비는 것이 더 손해**다.
//
// 옛 규칙을 만든 이유는 남아 있다(2026-09-24 - "방영 정보" 자리에 배우·감독·배우 3분할 합성컷이
// 들어가 썸네일에서 전부 작게 보였다). 그래서 지우지 않고 스위치로 남겨 며칠 지켜본다.
//
// **되돌리는 법**: 저장소 variables에 `IMAGE_GROUP_SHOTS=false`. 판정·기획 프롬프트가 옛 문구를 다시 싣는다.
// 빈 값은 "정하지 않음"이라 기본값(허용)이다.

function parseBooleanEnv(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value.trim() === "") return defaultValue;
  return value.trim().toLowerCase() === "true";
}

export function groupShotsAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseBooleanEnv(env.IMAGE_GROUP_SHOTS, true);
}
