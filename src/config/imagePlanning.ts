// 이미지 기획 단계 스위치. 설계: docs/ai-handoff/IMAGE_PLANNING_DESIGN.md
//
// **2026-10-02부터 기본이 켜짐이다**(사용자 결정). 구현 직후에는 꺼 두고 병합했고, 3단계 배선까지
// 끝난 뒤 B안(기획안 사전 승인 없이 켜고 뷰어 기록으로 사후 확인)으로 가기로 하면서 켰다.
//
// 켜면 원고마다 LLM을 한 번 더 부르고, 검색어와 획득 방식이 집필자 마커가 아니라 **기획**을 따른다.
// 왜 그래야 하는지는 설계 문서의 실측 두 건을 참고한다(기안장2 - 방영 전 장면을 지시해 자리가
// 비고 주인공이 한 장도 없었다 / 폭설 - 원고 한 줄과 1번 자리가 어긋났다).
//
// **끄는 법**: 저장소 variables에 `IMAGE_PLANNING=false`. 빈 값은 "정하지 않음"이라 기본값(켜짐)이다.
// 끄면 집필자 마커 그대로 도는 예전 경로다.

function parseBooleanEnv(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value.trim() === "") return defaultValue;
  return value.trim().toLowerCase() === "true";
}

export type ImagePlanningConfig = {
  enabled: boolean;
};

export const IMAGE_PLANNING_CONFIG: ImagePlanningConfig = {
  enabled: parseBooleanEnv(process.env.IMAGE_PLANNING, true),
};
