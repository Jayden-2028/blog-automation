// deployManuscriptsPage 테스트. 실제 wrangler 프로세스는 절대 띄우지 않는다(runWrangler 주입).
// config도 주입 가능해서 CLOUDFLARE_PAGES_CONFIG(환경변수 기반)와 무관하게 테스트한다
// (publishArticleToBlogspot.ts 테스트가 enabled를 옵션으로 주입하는 것과 같은 관례).
import { deployManuscriptsPage } from "./deployManuscriptsPage.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const disabledConfig = { enabled: false, projectName: undefined, accountId: undefined, apiToken: undefined };
const enabledConfig = { enabled: true, projectName: "test-project", accountId: "test-account", apiToken: "test-token" };

async function main(): Promise<void> {
  console.log("▶ deployManuscriptsPage 테스트 시작\n");

  // 1) 미설정 -> skip, wrangler 호출 안 함
  let called = false;
  const r1 = await deployManuscriptsPage({
    config: disabledConfig,
    runWrangler: async () => {
      called = true;
      return { stdout: "", stderr: "" };
    },
  });
  assert(r1.status === "skipped", `환경변수 없으면 skip이어야 한다 (${r1.status})`);
  assert(!called, "미설정 상태에서는 wrangler를 호출하면 안 된다");
  console.log("✅ 환경변수 미설정 -> skip, wrangler 미호출");

  // 2) 설정됨 + 성공
  let calledArgs: string[] | null = null;
  let calledEnv: NodeJS.ProcessEnv | null = null;
  const r2 = await deployManuscriptsPage({
    config: enabledConfig,
    runWrangler: async (args, env) => {
      calledArgs = args;
      calledEnv = env;
      return { stdout: "Deployment complete", stderr: "" };
    },
  });
  assert(r2.status === "success" && r2.url === "https://test-project.pages.dev", `성공 케이스 실패 (${JSON.stringify(r2)})`);
  assert(calledArgs !== null && (calledArgs as string[]).includes("test-project"), "project-name이 인자에 전달돼야 한다");
  assert(calledEnv !== null && (calledEnv as NodeJS.ProcessEnv).CLOUDFLARE_API_TOKEN === "test-token", "API 토큰이 env로 전달돼야 한다");
  console.log("✅ 설정됨 + 성공 -> pages.dev URL 반환, 토큰이 env로 전달됨");

  // 3) 설정됨 + wrangler 실패 -> failed로 전파(예외 던지지 않음)
  const r3 = await deployManuscriptsPage({
    config: enabledConfig,
    runWrangler: async () => {
      throw new Error("network error");
    },
  });
  assert(r3.status === "failed" && r3.error.includes("network error"), `실패 케이스 실패 (${JSON.stringify(r3)})`);
  console.log("✅ wrangler 실패 -> failed로 전파(예외 아님)");

  console.log("\n✅ deployManuscriptsPage 테스트 전체 통과");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
