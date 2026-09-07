import { classifyCommunityChannel, resolvePublishChannel } from "./channelRouting.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

function main(): void {
  console.log("▶ channelRouting 테스트 시작\n");

  assert(resolvePublishChannel("incident", "아무 키워드") === "tistory", "incident -> tistory");
  assert(resolvePublishChannel("living", "아무 키워드") === "tistory", "living -> tistory");
  console.log("✅ 사회 이슈 계열(incident/living) -> 티스토리");

  assert(resolvePublishChannel("entertainment", "아무 키워드") === "blogspot", "entertainment -> blogspot");
  assert(resolvePublishChannel("ott", "아무 키워드") === "blogspot", "ott -> blogspot");
  console.log("✅ 연예/OTT 계열(entertainment/ott) -> 블로그스팟");

  assert(resolvePublishChannel("parenting", "아무 키워드") === null, "육아는 배정표에 없어 null이어야 한다");
  assert(resolvePublishChannel(null, "아무 키워드") === null, "category 없으면 null");
  console.log("✅ 배정표에 없는 카테고리(육아)/카테고리 없음 -> null");

  assert(classifyCommunityChannel("어느 유튜버 사생활 논란") === "blogspot", "유튜버 개인 이슈는 블로그스팟");
  assert(classifyCommunityChannel("길고양이 급식 논쟁") === "tistory", "사회적 논쟁은 기본값 티스토리");
  assert(resolvePublishChannel("community", "인플루언서 열애설") === "blogspot", "community + 가십 어휘 -> blogspot");
  assert(resolvePublishChannel("community", "국민청원 갑론을박") === "tistory", "community + 사회 어휘 -> tistory(기본값)");
  console.log("✅ community는 어휘 기반으로 티스토리/블로그스팟 중 하나로 자동 배정");

  console.log("\n✅ 전체 통과");
}

main();
