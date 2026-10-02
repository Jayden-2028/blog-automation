// 이미지 기획 단계 스위치(2026-10-02). 설계: docs/ai-handoff/IMAGE_PLANNING_DESIGN.md
//
// **기본은 꺼짐이다.** 켜면 원고마다 LLM을 한 번 더 부르고 검색어가 집필자 마커와 달라진다 -
// 품질이 좋아질 것으로 보지만(드라이런 10건 중 8건에서 검색어가 달라졌다) 실제 이미지가 더
// 나은지는 돌려봐야 안다. 운영에 영향 없이 병합해 두고, 확인한 뒤 켠다.
//
// 끄면 지금 동작 그대로다 - 집필자 마커의 설명·검색어·획득 방식을 쓴다.

export type ImagePlanningConfig = {
  enabled: boolean;
};

export const IMAGE_PLANNING_CONFIG: ImagePlanningConfig = {
  enabled: (process.env.IMAGE_PLANNING ?? "").trim().toLowerCase() === "true",
};
