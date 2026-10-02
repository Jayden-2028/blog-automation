// 단체 사진·2샷·합성컷 허용 스위치 테스트(2026-10-02). 실행: npm run test:group-shots
//
// 지켜야 할 것: ① 기본은 허용(옛 "제외" 문구가 판정·기획 프롬프트에 없다)
// ② IMAGE_GROUP_SHOTS=false면 옛 문구가 **글자 그대로** 돌아온다(되돌리기 보장)
import { groupShotsAllowed } from "../../config/imageGroupShots.js";
import { groupShotRules } from "./collectWebImages.js";
import { buildPlanPrompt, r7Lines } from "./planImageSlots.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

async function main(): Promise<void> {
  console.log("▶ 단체 사진 스위치 테스트 시작\n");

  // 1) 환경변수 해석 - 빈 값은 기본(허용), false만 끈다.
  assert(groupShotsAllowed({}) === true, "미설정은 허용");
  assert(groupShotsAllowed({ IMAGE_GROUP_SHOTS: "" }) === true, "빈 값도 허용(variables 미설정이 빈 문자열로 온다)");
  assert(groupShotsAllowed({ IMAGE_GROUP_SHOTS: "false" }) === false, "false면 옛 규칙");
  assert(groupShotsAllowed({ IMAGE_GROUP_SHOTS: "true" }) === true, "true면 허용");
  console.log("✅ 스위치 해석 - 기본 허용, false로 되돌림");

  // 2) 허용: 판정 기준에서 제외 문구가 사라지고, 비우지 말라는 지시가 실린다.
  {
    const on = groupShotRules(true);
    const text = [...on.group, ...on.composite].join("\n");
    assert(text.includes("2샷·단체샷도 합격"), "단체 사진 합격 지시");
    assert(text.includes("자리를 비우지 않는다"), "비우지 말라는 지시");
    assert(!text.includes("단독 사진이 하나라도 있으면 고르지 않는다"), "옛 합성컷 제외 문구가 없어야 한다");
    assert(!text.includes("단체·그룹 사진이면 제외한다"), "옛 단체 사진 제외 문구가 없어야 한다");
    assert(text.includes("중복 금지는 그대로"), "같은 컷 중복 금지는 유지");
    console.log("✅ 허용 - 판정 기준 5·8번이 새 문구");
  }

  // 3) 되돌림: 옛 문구가 그대로 돌아온다.
  {
    const off = groupShotRules(false);
    assert(off.group[0].includes("단체·그룹 사진이면 제외한다"), "옛 5번 복원");
    assert(off.composite.join("\n").includes("단독 사진이 하나라도 있으면 고르지 않는다"), "옛 8번 복원");
    console.log("✅ 되돌림 - 옛 5·8번 그대로");
  }

  // 4) 기획 R7도 같이 움직인다.
  {
    assert(r7Lines(true).join("\n").includes("함께 나오는 인물은 함께 찾는다"), "허용이면 묶어서 찾기");
    assert(r7Lines(false).join("\n").includes("두 인물을 한 자리에 동시에 요구하지 않는다"), "되돌리면 옛 R7");
    const prompt = buildPlanPrompt(
      { keyword: "k", category: "ott", body: "문단.\n\n[IMAGE: 사진 — 웹 검색]\n[IMAGE PROMPT: 검색어]", imagePrompts: [], today: "2026-10-02" },
      null
    );
    assert(prompt.includes("함께 나오는 인물은 함께 찾는다"), "기본 실행에서 기획 프롬프트가 새 R7을 싣는다");
    assert(!prompt.includes("두 인물을 한 자리에 동시에 요구하지 않는다"), "기본 실행에서 옛 R7이 없어야 한다");
    console.log("✅ 기획 R7 - 기본 허용, 되돌리면 옛 문구");
  }

  console.log("\n✅ 단체 사진 스위치 테스트 전부 통과");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
