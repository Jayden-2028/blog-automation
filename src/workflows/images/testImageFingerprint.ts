// 같은 컷 검출 테스트. 실행: npm run test:image-fingerprint
//
// 지켜야 할 것: ① 해밍 거리 계산 ② 좌우가 뒤바뀐 합성컷도 같은 컷으로 본다 ③ 다른 그림은
// 통과시킨다 ④ 지문을 못 구하면 통과시킨다(fail-open - 빈 자리가 중복보다 나쁘다)
// ⑤ 동시에 들어와도 두 자리가 같은 컷을 통과시키지 않는다(뮤텍스).
import { ImageDeduper, hammingDistance, isSameCut } from "./imageFingerprint.js";
import type { ImageFingerprint } from "./imageFingerprint.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const buf = (s: string) => Buffer.from(s);

async function main(): Promise<void> {
  console.log("▶ 같은 컷 검출 테스트 시작\n");

  // 1) 해밍 거리.
  {
    assert(hammingDistance("0000000000000000", "0000000000000000") === 0, "같은 해시는 0");
    assert(hammingDistance("0000000000000000", "0000000000000001") === 1, "1비트 차이는 1");
    assert(hammingDistance("ffffffffffffffff", "0000000000000000") === 64, "전부 다르면 64");
    assert(hammingDistance("abc", "abcd") === 64, "길이가 다르면 비교 불가(64)");
    console.log("✅ 해밍 거리");
  }

  // 2) 좌우가 뒤바뀐 합성컷 - 실측(장윤주)에서 1·2번이 이 관계였다.
  {
    const a: ImageFingerprint = { hash: "1111111111111111", swapped: "2222222222222222" };
    const b: ImageFingerprint = { hash: "2222222222222222", swapped: "1111111111111111" };
    assert(isSameCut(a, b), "좌우가 뒤바뀐 컷은 같은 컷이어야 한다");
    assert(hammingDistance(a.hash, b.hash) > 12, "원본끼리는 멀어야 한다(그래서 swapped가 필요하다)");
    console.log("✅ 좌우가 뒤바뀐 합성컷을 같은 컷으로 판정");
  }

  // 3) 재압축·리사이즈만 다른 같은 사진(몇 비트 차이)은 같은 컷, 다른 사진은 아니다.
  {
    const base: ImageFingerprint = { hash: "0f0f0f0f0f0f0f0f", swapped: "f0f0f0f0f0f0f0f0" };
    const nearlySame: ImageFingerprint = { hash: "0f0f0f0f0f0f0f0e", swapped: "f0f0f0f0f0f0f0f1" };
    const different: ImageFingerprint = { hash: "a5c3719e24bd6f08", swapped: "3e91load".slice(0, 16).padEnd(16, "0") };
    assert(isSameCut(base, nearlySame), "1비트 차이는 같은 컷");
    assert(!isSameCut(base, different), "다른 그림은 통과해야 한다");
    console.log("✅ 재압축 차이는 같은 컷, 다른 그림은 통과");
  }

  // 4) claim - 같은 지문이면 두 번째가 막히고, 누구와 겹쳤는지 알려준다.
  {
    const fixed = new Map<string, ImageFingerprint>([
      ["A", { hash: "1111111111111111", swapped: "2222222222222222" }],
      ["A2", { hash: "2222222222222222", swapped: "1111111111111111" }],
      ["B", { hash: "a5c3719e24bd6f08", swapped: "084b6d29e917c35a" }],
    ]);
    const deduper = new ImageDeduper({
      fingerprint: async (buffer) => fixed.get(buffer.toString()) ?? null,
    });

    const first = await deduper.claim("자리 1", buf("A"), "image/png");
    assert(!first.duplicate, "첫 이미지는 통과해야 한다");

    const second = await deduper.claim("자리 2", buf("A2"), "image/webp");
    assert(second.duplicate, "좌우만 바뀐 같은 컷은 막혀야 한다");
    assert(second.duplicate && second.against === "자리 1", "누구와 겹쳤는지 알려줘야 한다");

    const third = await deduper.claim("자리 3", buf("B"), "image/jpeg");
    assert(!third.duplicate, "다른 그림은 통과해야 한다");
    console.log("✅ claim - 같은 컷 차단 + 겹친 상대 표시");
  }

  // 5) fail-open. 지문을 못 구했다고 멀쩡한 이미지를 버리면 자리가 빈다.
  {
    const deduper = new ImageDeduper({ fingerprint: async () => null });
    const a = await deduper.claim("자리 1", buf("x"), "image/png");
    const b = await deduper.claim("자리 2", buf("x"), "image/png");
    assert(!a.duplicate && !b.duplicate, "지문을 못 구하면 전부 통과시킨다");
    console.log("✅ 지문 실패는 통과(fail-open)");
  }

  // 6) 동시 호출. 자리들이 병렬로 도는 실제 조건이다 - 검사와 등록 사이가 갈리면 둘 다 통과한다.
  {
    let calls = 0;
    const deduper = new ImageDeduper({
      fingerprint: async () => {
        calls += 1;
        await new Promise((r) => setTimeout(r, 5)); // 지문 계산 지연을 흉내낸다
        return { hash: "1111111111111111", swapped: "1111111111111111" };
      },
    });
    const [x, y] = await Promise.all([
      deduper.claim("자리 1", buf("same"), "image/png"),
      deduper.claim("자리 2", buf("same"), "image/png"),
    ]);
    assert(calls === 2, "둘 다 지문을 계산해야 한다");
    const blocked = [x, y].filter((r) => r.duplicate).length;
    assert(blocked === 1, `동시에 들어와도 하나만 통과해야 한다 (막힌 수: ${blocked})`);
    console.log("✅ 동시 호출에서도 하나만 통과(뮤텍스)");
  }

  // 7) 자리 순서 게이트 - 뒤 자리가 앞 자리보다 먼저 와도 앞 자리가 먼저 등록된다.
  //    실측(장윤주)의 중복이 1·2번, 즉 동시에 도는 같은 물결이었다.
  {
    const order: string[] = [];
    const deduper = new ImageDeduper({
      fingerprint: async (buffer) => {
        order.push(buffer.toString());
        return { hash: "1111111111111111", swapped: "1111111111111111" };
      },
    });
    deduper.planOrder([1, 2, 3]);

    // 3번과 2번을 먼저 부르고 1번을 마지막에 부른다.
    const p3 = deduper.claim("자리 3", buf("three"), "image/png", { index: 3, filePath: "/3.png" });
    const p2 = deduper.claim("자리 2", buf("two"), "image/png", { index: 2, filePath: "/2.png" });
    const p1 = deduper.claim("자리 1", buf("one"), "image/png", { index: 1, filePath: "/1.png" });
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    assert(order.join(",") === "one,two,three", `자리 번호 순서로 등록해야 한다 (${order.join(",")})`);
    assert(!r1.duplicate, "1번이 먼저 등록돼야 한다");
    assert(r2.duplicate && r2.against === "자리 1", "2번은 1번과 겹쳐야 한다");
    assert(r3.duplicate, "3번도 겹쳐야 한다");
    console.log("✅ 자리 순서 게이트 - 늦게 불러도 번호 순서로 등록");
  }

  // 8) 게이트를 안 열고 끝난 자리가 있어도 뒤가 막히지 않는다(후보를 못 구해 claim을 건너뛴 경우).
  {
    const deduper = new ImageDeduper({
      fingerprint: async () => ({ hash: "abcdabcdabcdabcd", swapped: "abcdabcdabcdabcd" }),
    });
    deduper.planOrder([1, 2]);
    deduper.releaseTurn(1); // 1번이 후보를 못 구해 그냥 끝났다
    const r2 = await Promise.race([
      deduper.claim("자리 2", buf("x"), "image/png", { index: 2, filePath: "/2.png" }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("게이트에 막혔습니다")), 2000)),
    ]);
    assert(r2 && typeof r2 === "object", "앞 자리가 건너뛰어도 진행돼야 한다");
    console.log("✅ 앞 자리가 건너뛰어도 뒤가 막히지 않는다");
  }

  // 9) 애매한 구간에서만 비전에 묻는다. 확실히 먼 것은 묻지 않는다(호출 비용).
  {
    const asked: number[] = [];
    const fps: Record<string, ImageFingerprint> = {
      base: { hash: "0000000000000000", swapped: "0000000000000000" },
      // 거리 24 - 애매한 구간(12 < d < 34)
      ambiguous: { hash: "0f0f0f0f0f0f0f0f", swapped: "0f0f0f0f0f0f0f0f" },
      // 거리 64 - 확실히 다르다
      far: { hash: "ffffffffffffffff", swapped: "ffffffffffffffff" },
    };
    const deduper = new ImageDeduper({
      fingerprint: async (b) => fps[b.toString()] ?? null,
      askSameCut: async ({ against }) => {
        asked.push(against.length);
        return against[0]?.key ?? null; // 비전이 "같은 컷"이라고 답한다
      },
    });
    await deduper.claim("자리 1", buf("base"), "image/png", { index: 1, filePath: "/1.png" });

    const far = await deduper.claim("자리 2", buf("far"), "image/png", { index: 2, filePath: "/2.png" });
    assert(!far.duplicate, "확실히 다른 것은 통과");
    // assert가 asked.length를 리터럴 0으로 좁혀 버리므로 값을 따로 담아 비교한다.
    const afterFar = asked.length;
    assert(afterFar === 0, "확실히 먼 것에는 비전을 부르지 않는다");

    const amb = await deduper.claim("자리 3", buf("ambiguous"), "image/png", { index: 3, filePath: "/3.png" });
    const afterAmbiguous = asked.length;
    assert(afterAmbiguous === 1, "애매한 구간에서는 비전을 부른다");
    assert(amb.duplicate && amb.against === "자리 1", "비전이 같다고 하면 막는다");
    console.log("✅ 애매한 구간에서만 비전 호출 - 장윤주 케이스 경로");
  }

  console.log("\n🎉 같은 컷 검출 테스트 통과");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
