// 한 원고 안에서 **같은 컷**이 두 번 들어가는 것을 막는다(2026-09-23 사용자 결정).
//
// 왜 URL 비교로는 안 되나(실측, 장윤주 원고): 1번과 2번이 같은 사진 두 장을 나란히 붙인
// 합성컷이었고 좌우 순서만 서로 반대였다. 출처 매체가 달라 URL·크기·포맷이 전부 달랐다.
//
//   1번  714x716   sports.khan.co.kr    [전신샷 | 상반신샷]
//   2번  1200x882  xportsnews.com       [상반신샷 | 전신샷]   ← 사람 눈에는 같은 컷
//
// 그래서 **픽셀을 본다.** dHash(difference hash)는 크기·포맷·재압축이 달라도 같은 그림이면
// 거의 같은 값이 나온다. 좌우가 바뀐 합성컷을 잡으려고 **좌우 절반을 맞바꾼 변형**의 해시도
// 함께 계산해 비교한다.
//
// 디코딩은 Chromium으로 한다 - 이 저장소에 이미지 라이브러리가 없고(playwright만 있다),
// cropTallImage.ts가 쓰는 것과 같은 패턴이다. 브라우저는 한 번만 띄워 재사용한다.
//
// **고장 나면 통과시킨다.** 지문을 못 구했다고 멀쩡한 이미지를 버리면 자리가 빈다 - 빈 자리가
// 중복보다 나쁘다(실측으로 여러 번 확인했다).

import { chromium } from "playwright";
import type { Browser, Page } from "playwright";

/** dHash 8x8 = 64비트를 16진수 16자로. 좌우를 맞바꾼 변형도 같이 들고 다닌다. */
export type ImageFingerprint = { hash: string; swapped: string };

/**
 * 같은 컷으로 볼 해밍 거리 상한.
 *
 * **실측으로 보정했다(2026-09-23).**
 *
 * ```
 * 같은 사진을 축소 + jpeg 재압축         10      ← 이건 잡아야 한다
 * 서로 다른 사진(장윤주 원고 1 vs 6)      28~36   ← 이건 통과시켜야 한다
 * ```
 *
 * 그래서 12로 둔다. 10은 잡고 28은 놓친다.
 *
 * **이 값이 무엇을 못 잡는지 분명히 해둔다.** 같은 사진 두 장을 나란히 붙인 합성컷이 매체마다
 * 다르게 잘린 경우(장윤주 1 vs 2)는 **27~31**이 나와 대조군과 완전히 겹친다. 전체 dHash로도,
 * 좌우 절반을 맞바꿔도, 패널을 나눠 교차 비교해도(24~27 vs 29~36) 가르지 못했다.
 * 그 사례는 여기서 못 막는다 - 검증 단계(chooseImage)나 집필 규칙(§8-8 "합성컷을 쓰지 않는다")이
 * 맡아야 한다.
 */
export const DUPLICATE_MAX_DISTANCE = 12;

/** 16진수 해시 두 개의 해밍 거리. 길이가 다르면 비교 불가로 보고 64(최대)를 준다. */
export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) return 64;
  let distance = 0;
  for (let i = 0; i < a.length; i += 1) {
    const diff = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    // 4비트 팝카운트.
    distance += ((diff >> 3) & 1) + ((diff >> 2) & 1) + ((diff >> 1) & 1) + (diff & 1);
  }
  return distance;
}

/**
 * 두 지문이 같은 컷인가.
 *
 * 원본끼리, 그리고 **한쪽을 좌우로 맞바꾼 것**과도 비교한다 - 합성컷의 좌우가 뒤집힌 경우가
 * 실제로 나왔기 때문이다.
 */
export function isSameCut(a: ImageFingerprint, b: ImageFingerprint, maxDistance = DUPLICATE_MAX_DISTANCE): boolean {
  return (
    hammingDistance(a.hash, b.hash) <= maxDistance ||
    hammingDistance(a.swapped, b.hash) <= maxDistance ||
    hammingDistance(a.hash, b.swapped) <= maxDistance
  );
}

/**
 * 브라우저 안에서 도는 코드. 9x8로 줄여 흑백으로 만든 뒤 가로 이웃 픽셀을 비교해 64비트를 만든다.
 * 같은 일을 좌우 절반을 맞바꾼 캔버스에 한 번 더 한다.
 *
 * tsx/esbuild가 함수를 넘기면 `__name is not defined`로 터지므로 **문자열로** 넘긴다
 * (2026-09-22 실측, NaverBlogPublisher에서 같은 문제를 겪었다).
 */
function fingerprintScript(dataUrl: string): string {
  return `
(async () => {
  try {
    const image = new Image();
    image.src = ${JSON.stringify(dataUrl)};
    await image.decode();
    const W = 9, H = 8;

    const hashOf = (swap) => {
      const canvas = document.createElement("canvas");
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (swap) {
        // 오른쪽 절반을 왼쪽에, 왼쪽 절반을 오른쪽에 그린다.
        const halfSrc = Math.floor(image.width / 2);
        const halfDst = W / 2;
        ctx.drawImage(image, halfSrc, 0, image.width - halfSrc, image.height, 0, 0, halfDst, H);
        ctx.drawImage(image, 0, 0, halfSrc, image.height, halfDst, 0, W - halfDst, H);
      } else {
        ctx.drawImage(image, 0, 0, W, H);
      }
      const { data } = ctx.getImageData(0, 0, W, H);
      const gray = [];
      for (let i = 0; i < W * H; i += 1) {
        const o = i * 4;
        gray.push(0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2]);
      }
      let bits = "";
      for (let y = 0; y < H; y += 1) {
        for (let x = 0; x < W - 1; x += 1) {
          bits += gray[y * W + x] < gray[y * W + x + 1] ? "1" : "0";
        }
      }
      let hex = "";
      for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
      return hex;
    };

    window.__fingerprint = { hash: hashOf(false), swapped: hashOf(true) };
  } catch (error) {
    window.__fingerprint = { error: String(error) };
  }
})();
`;
}

/**
 * dHash로 "확실히 다르다"고 말할 수 있는 거리(2026-09-23 실측 보정).
 *
 * 이 위는 눈으로 봐도 다른 그림이라 비전에 묻지 않는다. `DUPLICATE_MAX_DISTANCE`(12)와 이 값
 * 사이가 **애매한 구간**이고, 장윤주 합성컷 쌍이 정확히 여기(27~31) 있었다. 그 구간만 비전에
 * 물어보면 호출 수를 아주 적게 유지하면서 실제 사례를 잡을 수 있다.
 */
export const CLEARLY_DIFFERENT_DISTANCE = 34;

export type DeduperOptions = {
  maxDistance?: number;
  /** 테스트 주입. 넣으면 Chromium을 띄우지 않는다. */
  fingerprint?: (buffer: Buffer, mimeType: string) => Promise<ImageFingerprint | null>;
  /**
   * 애매한 구간에서 "사람 눈에 같은 컷인가"를 묻는다(2026-09-23 사용자 결정 A안).
   * 같은 컷이면 상대 key를, 아니면 null을 돌려준다. 없으면 그 구간은 통과시킨다.
   */
  askSameCut?: (input: { candidatePath: string; against: { key: string; filePath: string }[] }) => Promise<string | null>;
};

export type DuplicateCheck =
  | { duplicate: false }
  /** 이미 이 키(자리 번호 등)가 같은 컷을 썼다. */
  | { duplicate: true; against: string };

/**
 * 한 원고(=한 실행) 동안 채택된 컷의 지문을 들고 있으면서 중복을 막는다.
 *
 * 자리들이 동시에 돌기 때문에 **검사와 등록 사이를 직렬화**한다 - 안 그러면 두 자리가 같은
 * 이미지를 동시에 통과시킨다.
 */
export class ImageDeduper {
  private readonly registered: { key: string; filePath: string; fingerprint: ImageFingerprint }[] = [];
  private readonly maxDistance: number;
  private readonly fingerprintOne: (buffer: Buffer, mimeType: string) => Promise<ImageFingerprint | null>;
  private readonly askSameCut: DeduperOptions["askSameCut"];
  private browser: Browser | null = null;
  private page: Page | null = null;
  /** 검사-등록 구간의 뮤텍스. */
  private queue: Promise<unknown> = Promise.resolve();
  /**
   * 자리 순서 게이트(2026-09-23). 자리들이 **동시에 3개씩** 돌기 때문에, 그냥 두면 2번이 1번보다
   * 먼저 등록해 서로를 못 본다 - 실측(장윤주)의 중복이 정확히 1·2번, 즉 같은 물결이었다.
   * 무거운 부분(다운로드·비전 검증)은 그대로 병렬로 두고 **등록만** 자리 번호 순서로 줄 세운다.
   */
  private gate = new Map<number, Promise<void>>();
  private openNext = new Map<number, () => void>();

  constructor(options: DeduperOptions = {}) {
    this.maxDistance = options.maxDistance ?? DUPLICATE_MAX_DISTANCE;
    this.fingerprintOne = options.fingerprint ?? ((buffer, mimeType) => this.fingerprintWithChromium(buffer, mimeType));
    this.askSameCut = options.askSameCut;
  }

  /**
   * 등록을 자리 번호 순서로 처리하겠다고 예고한다. 호출하지 않으면 순서 없이(먼저 온 순서로) 돈다.
   * `collectWebImages`가 자리 목록을 알고 있으므로 거기서 한 번 불러 준다.
   */
  planOrder(indexes: readonly number[]): void {
    const sorted = [...indexes].sort((a, b) => a - b);
    let previous = Promise.resolve();
    for (const index of sorted) {
      this.gate.set(index, previous);
      previous = new Promise<void>((resolve) => this.openNext.set(index, resolve));
    }
  }

  /** 내 차례를 기다린다. 예고하지 않은 자리는 바로 통과한다. */
  private async waitTurn(index: number | undefined): Promise<void> {
    if (index === undefined) return;
    await this.gate.get(index);
  }

  /**
   * 다음 자리의 문을 연다. **무슨 일이 있어도 열어야 한다** - 한 자리가 후보를 못 구해 claim을
   * 아예 부르지 않으면 뒤 자리가 영원히 기다린다. 그래서 호출부가 자리 처리 끝에서 무조건 부르고,
   * 여러 번 불러도 안전하게 멱등으로 만든다.
   */
  releaseTurn(index: number | undefined): void {
    if (index === undefined) return;
    const open = this.openNext.get(index);
    if (!open) return;
    this.openNext.delete(index);
    open();
  }

  private async ensurePage(): Promise<Page> {
    if (this.page) return this.page;
    this.browser = await chromium.launch({ args: ["--no-sandbox"] });
    this.page = await this.browser.newPage();
    return this.page;
  }

  private async fingerprintWithChromium(buffer: Buffer, mimeType: string): Promise<ImageFingerprint | null> {
    try {
      const page = await this.ensurePage();
      const dataUrl = `data:${mimeType || "image/png"};base64,${buffer.toString("base64")}`;
      // 데이터 URL을 스크립트에 **박아 넣는다**. page.evaluate에 문자열을 주면 그것을 식으로만
      // 평가하고 **인자는 전달하지 않는다** - 2026-09-23 실측에서 이것 때문에 지문이 항상 null로
      // 나왔고, fail-open이라 중복이 조용히 전부 통과했다. cropTallImage.ts와 같은 방식으로 바꿨다.
      await page.setContent(
        `<!doctype html><meta charset="utf-8"><script>${fingerprintScript(dataUrl)}</script>`,
        { waitUntil: "load" }
      );
      await page.waitForFunction("window.__fingerprint !== undefined", null, { timeout: 30_000 });
      const result = (await page.evaluate("window.__fingerprint")) as
        | { hash: string; swapped: string }
        | { error: string };
      if (!("hash" in result)) return null;
      return { hash: result.hash, swapped: result.swapped };
    } catch {
      return null;
    }
  }

  /**
   * 이 이미지가 이미 쓴 컷인지 본다. 아니면 **등록하고** false를 돌려준다.
   *
   * 지문을 못 구하면 통과시킨다(fail-open) - 빈 자리가 중복보다 나쁘다.
   */
  async claim(
    key: string,
    buffer: Buffer,
    mimeType: string,
    slot?: { index: number; filePath: string }
  ): Promise<DuplicateCheck> {
    // **뮤텍스 밖에서** 차례를 기다린다. 안에서 기다리면 뒤 자리가 뮤텍스를 쥔 채 앞 자리를
    // 기다리고, 앞 자리는 뮤텍스를 못 잡아 서로 막힌다(데드락).
    await this.waitTurn(slot?.index);

    const run = this.queue.then(async (): Promise<DuplicateCheck> => {
      try {
        const fingerprint = await this.fingerprintOne(buffer, mimeType);
        if (!fingerprint) return { duplicate: false };

        // 1) 거리가 확실히 가까우면 비전에 묻지 않고 막는다.
        const ambiguous: { key: string; filePath: string }[] = [];
        for (const entry of this.registered) {
          if (isSameCut(fingerprint, entry.fingerprint, this.maxDistance)) {
            return { duplicate: true, against: entry.key };
          }
          // 2) 애매한 구간만 모은다. 확실히 먼 것은 묻지 않는다 - 호출 수를 줄이는 지점이다.
          const nearest = Math.min(
            hammingDistance(fingerprint.hash, entry.fingerprint.hash),
            hammingDistance(fingerprint.swapped, entry.fingerprint.hash),
            hammingDistance(fingerprint.hash, entry.fingerprint.swapped)
          );
          if (nearest < CLEARLY_DIFFERENT_DISTANCE && entry.filePath) ambiguous.push(entry);
        }

        // 3) 애매하면 사람 눈에 준하는 판정을 받는다(사용자 결정 A안). dHash로는 합성컷의
        //    좌우 순서가 바뀐 경우를 못 가린다는 것이 실측으로 확인됐다.
        if (ambiguous.length > 0 && this.askSameCut && slot?.filePath) {
          const matched = await this.askSameCut({ candidatePath: slot.filePath, against: ambiguous }).catch(() => null);
          if (matched) return { duplicate: true, against: matched };
        }

        this.registered.push({ key, filePath: slot?.filePath ?? "", fingerprint });
        return { duplicate: false };
      } finally {
        // 이 자리의 판정이 끝났으니 다음 자리를 연다. 예외가 나도 반드시 연다.
        this.releaseTurn(slot?.index);
      }
    });
    // 다음 호출이 이 작업 뒤에 오도록 체인을 잇는다. 실패해도 체인이 끊기지 않게 삼킨다.
    this.queue = run.catch(() => undefined);
    return run;
  }

  async close(): Promise<void> {
    await this.page?.close().catch(() => {});
    await this.browser?.close().catch(() => {});
    this.page = null;
    this.browser = null;
  }
}
