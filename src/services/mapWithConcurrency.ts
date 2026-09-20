// 상한을 둔 병렬 실행. Promise.all과 달리 **동시에 도는 개수를 제한**한다.
//
// 왜 무제한 Promise.all이 아닌가(2026-09-21): 병렬로 돌릴 대상이 전부 외부 호출이다 -
// 헤드리스 LLM(이미지 판정), 유료 이미지 생성 API, 남의 서버에서 이미지 내려받기. 자리 8개를
// 한꺼번에 던지면 rate limit·429·일시 차단을 부르고, 그러면 순차보다 느려진다(재시도 때문에).
// 3~4개 정도가 체감상 가장 크게 줄이면서 한도를 건드리지 않는 구간이다.
//
// 결과 순서는 입력 순서를 그대로 유지한다 - 자리 번호로 짝을 맞추는 코드가 많아 순서가 섞이면
// 엉뚱한 문단에 이미지가 붙는다.

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];
  const safeLimit = Math.max(1, Math.min(limit, items.length));
  const results = new Array<R>(items.length);
  let next = 0;

  async function runner(): Promise<void> {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: safeLimit }, () => runner()));
  return results;
}
