// 규격 모드 해석 테스트. 실행: npm run test:writing-mode
//
// 지켜야 할 것: ① 기본은 spec(안 건드리면 기존 동작) ② job.metadata가 환경변수를 이긴다
// ③ 모르는 값은 조용히 무시하고 기본으로 떨어진다(오타 하나로 전 원고가 자율 모드로 가면 안 된다).
import { DEFAULT_WRITING_MODE, WRITING_MODE_KEY, resolveWritingMode } from "./writingMode.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

function withEnv(value: string | undefined, run: () => void): void {
  const before = process.env.WRITING_MODE;
  if (value === undefined) delete process.env.WRITING_MODE;
  else process.env.WRITING_MODE = value;
  try {
    run();
  } finally {
    if (before === undefined) delete process.env.WRITING_MODE;
    else process.env.WRITING_MODE = before;
  }
}

console.log("▶ 규격 모드 테스트 시작\n");

// 1) 아무것도 안 주면 spec이다 - 이 플래그를 모르는 코드 경로가 기존 동작을 유지해야 한다.
withEnv(undefined, () => {
  assert(resolveWritingMode(null) === "spec", "기본값은 spec이어야 한다");
  assert(resolveWritingMode({}) === "spec", "빈 metadata도 spec");
  assert(DEFAULT_WRITING_MODE === "spec", "DEFAULT_WRITING_MODE가 spec이어야 한다");
});
console.log("✅ 기본값 spec - 아무것도 안 주면 기존 동작");

// 2) 환경변수로 전역 전환.
withEnv("auto", () => {
  assert(resolveWritingMode(null) === "auto", "환경변수 auto가 반영돼야 한다");
  assert(resolveWritingMode({}) === "auto", "metadata가 비면 환경변수를 쓴다");
});
console.log("✅ 환경변수 WRITING_MODE=auto 전역 전환");

// 3) metadata가 환경변수를 이긴다 - A/B는 한 런에서 키워드별로 갈려야 한다.
withEnv("spec", () => {
  assert(resolveWritingMode({ [WRITING_MODE_KEY]: "auto" }) === "auto", "metadata가 환경변수를 이겨야 한다");
});
withEnv("auto", () => {
  assert(resolveWritingMode({ [WRITING_MODE_KEY]: "spec" }) === "spec", "metadata로 되돌릴 수도 있어야 한다");
});
console.log("✅ job.metadata가 환경변수보다 우선 - 한 런에서 두 모드");

// 4) 모르는 값·대소문자·공백. 오타가 조용히 auto로 가면 전 원고가 검증 모드로 발행된다.
withEnv("AUTO", () => assert(resolveWritingMode(null) === "auto", "대문자도 읽어야 한다"));
withEnv(" auto ", () => assert(resolveWritingMode(null) === "auto", "공백은 무시한다"));
withEnv("autonomous", () => assert(resolveWritingMode(null) === "spec", "모르는 값은 기본으로 떨어진다"));
withEnv("", () => assert(resolveWritingMode(null) === "spec", "빈 문자열은 기본으로 떨어진다"));
withEnv("spec", () => {
  assert(resolveWritingMode({ [WRITING_MODE_KEY]: 7 }) === "spec", "문자열이 아니면 무시한다");
  assert(resolveWritingMode({ [WRITING_MODE_KEY]: "autooo" }) === "spec", "모르는 metadata 값도 무시한다");
});
console.log("✅ 대소문자·공백 허용, 모르는 값은 기본으로 폴백");

console.log("\n🎉 규격 모드 테스트 통과");
