// 병렬 상한 헬퍼 테스트. 실행: npm run test:concurrency
//
// 이 헬퍼가 깨지면 이미지가 엉뚱한 문단에 붙거나(순서) rate limit에 걸린다(상한). 둘 다
// 조용히 잘못되는 유형이라 불변식으로 고정한다.
import { mapWithConcurrency } from "./mapWithConcurrency.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

// --- 1. 결과 순서는 입력 순서를 유지한다(자리 번호로 짝을 맞추므로 핵심) --------------------
{
  const out = await mapWithConcurrency([5, 1, 4, 2, 3], 3, async (n) => {
    // 일부러 늦게 끝나는 것을 앞에 둔다 - 완료 순서로 담으면 여기서 깨진다.
    await new Promise((r) => setTimeout(r, n * 5));
    return `v${n}`;
  });
  assert(JSON.stringify(out) === JSON.stringify(["v5", "v1", "v4", "v2", "v3"]), `순서가 섞였다: ${JSON.stringify(out)}`);
  console.log("✅ 완료 순서와 무관하게 입력 순서를 유지한다");
}

// --- 2. 동시 실행 수가 상한을 넘지 않는다 ------------------------------------------------------
{
  let running = 0;
  let peak = 0;
  await mapWithConcurrency(Array.from({ length: 12 }, (_, i) => i), 3, async () => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 10));
    running -= 1;
  });
  assert(peak <= 3, `상한 3을 넘었다(최대 ${peak})`);
  assert(peak === 3, `상한만큼은 실제로 동시에 돌아야 한다(최대 ${peak})`);
  console.log("✅ 동시 실행이 상한을 지키고, 상한만큼은 실제로 병렬이다");
}

// --- 3. 실제로 빨라진다(순차 대비) -------------------------------------------------------------
{
  const started = Date.now();
  await mapWithConcurrency(Array.from({ length: 6 }, (_, i) => i), 3, async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
  const elapsed = Date.now() - started;
  // 순차면 180ms, 상한 3이면 60ms 근처. 여유를 두고 절반 미만이면 병렬이 맞다.
  assert(elapsed < 150, `병렬로 줄지 않았다(${elapsed}ms)`);
  console.log(`✅ 6건을 상한 3으로 ${elapsed}ms에 처리(순차라면 180ms)`);
}

// --- 4. 경계값 ---------------------------------------------------------------------------------
{
  assert((await mapWithConcurrency([], 3, async () => 1)).length === 0, "빈 배열은 빈 배열");
  assert(JSON.stringify(await mapWithConcurrency([1, 2], 0, async (n) => n)) === "[1,2]", "상한 0이어도 최소 1로 돈다");
  assert(JSON.stringify(await mapWithConcurrency([1], 99, async (n) => n)) === "[1]", "상한이 항목 수보다 커도 안전");
  console.log("✅ 경계값 - 빈 배열·상한 0·과대 상한");
}

// --- 5. 하나가 실패하면 전체가 실패한다(조용히 삼키지 않는다) -----------------------------------
{
  let threw = false;
  try {
    await mapWithConcurrency([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error("의도된 실패");
      return n;
    });
  } catch (error) {
    threw = (error as Error).message === "의도된 실패";
  }
  assert(threw, "예외가 그대로 올라와야 한다 - 호출부가 실패를 알아야 한다");
  console.log("✅ 예외를 삼키지 않는다");
}

console.log("\n🎉 병렬 상한 헬퍼 테스트 통과");
