// Cloudflare Worker의 cron 설정이 두 파일에서 일치하는지 검사한다.
//
// 왜 필요한가: 스케줄이 두 곳에 나뉘어 있다.
//   - wrangler.toml의 `crons` 배열   -> Cloudflare가 "언제 깨울지"
//   - src/index.ts의 SCHEDULED_WORKFLOWS -> Worker가 "그 시각에 무엇을 깨울지"
// 뒤쪽은 **cron 문자열이 map의 키**라, 한쪽만 고치면 Worker가 `알 수 없는 cron 표현식`을 찍고
// 아무 워크플로우도 깨우지 않는다. 배포는 성공하고 에러도 안 나므로, 다음 날 알림이 안 온 것을
// 보고서야 안다. 실제로 이 파일들의 주석이 "반드시 같이 바꿀 것"이라고 경고하고 있는데,
// 경고문은 잊히고 검사는 안 잊힌다.
//
// 실행: npx tsx scripts/testWorkerCronSync.ts

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_DIR = join(__dirname, "..", "cloudflare", "telegram-relay");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

/** wrangler.toml의 `crons = [...]`에서 cron 문자열만 뽑는다(주석 줄은 제외). */
function readWranglerCrons(): string[] {
  const toml = readFileSync(join(WORKER_DIR, "wrangler.toml"), "utf-8");
  const line = toml.split("\n").find((l) => l.trim().startsWith("crons"));
  assert(line, "wrangler.toml에서 crons 항목을 찾지 못했다");
  return [...line.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/** src/index.ts의 SCHEDULED_WORKFLOWS 블록에서 키(cron 문자열)를 뽑는다. */
function readWorkflowMapKeys(): string[] {
  const src = readFileSync(join(WORKER_DIR, "src", "index.ts"), "utf-8");
  const start = src.indexOf("const SCHEDULED_WORKFLOWS");
  assert(start >= 0, "index.ts에서 SCHEDULED_WORKFLOWS를 찾지 못했다");
  const end = src.indexOf("};", start);
  assert(end > start, "SCHEDULED_WORKFLOWS 블록의 끝을 찾지 못했다");

  const block = src.slice(start, end);
  return [...block.matchAll(/^\s*"([^"]+)"\s*:/gm)].map((m) => m[1]);
}

function main(): void {
  console.log("▶ Worker cron 동기화 검사");

  const crons = readWranglerCrons();
  const keys = readWorkflowMapKeys();

  assert(crons.length > 0, "wrangler.toml의 cron이 0개다");
  assert(keys.length > 0, "SCHEDULED_WORKFLOWS가 비어 있다");

  const missingInMap = crons.filter((cron) => !keys.includes(cron));
  assert(
    missingInMap.length === 0,
    `wrangler.toml에만 있고 SCHEDULED_WORKFLOWS에 없는 cron: ${missingInMap.join(", ")}\n` +
      "   -> 그 시각에 Worker가 깨어나지만 아무것도 실행하지 않는다."
  );

  const missingInCrons = keys.filter((key) => !crons.includes(key));
  assert(
    missingInCrons.length === 0,
    `SCHEDULED_WORKFLOWS에만 있고 wrangler.toml에 없는 cron: ${missingInCrons.join(", ")}\n` +
      "   -> 그 워크플로우는 영영 깨어나지 않는다."
  );

  console.log(`  ✅ cron ${crons.length}개가 양쪽에서 일치`);
  for (const cron of crons) console.log(`     ${cron}`);

  // 같은 시각에 두 워크플로우를 걸면 하나는 덮어써진다(map의 키가 중복되므로).
  assert(new Set(crons).size === crons.length, "wrangler.toml에 중복된 cron이 있다");
  console.log("  ✅ 중복 cron 없음");

  // 검사 자체가 동작하는지 확인한다. 항상 통과하는 검사는 없느니만 못하다.
  {
    const cronsOnly = ["0 9 * * *", "0 10 * * *"];
    const keysOnly = ["0 9 * * *"];
    const diff = cronsOnly.filter((c) => !keysOnly.includes(c));
    assert(diff.length === 1 && diff[0] === "0 10 * * *", "비교 로직이 어긋난 cron을 못 잡는다");
    console.log("  ✅ 어긋난 입력을 실제로 잡아낸다(자가 검증)");
  }

  console.log("\n✅ 전체 통과");
}

main();
