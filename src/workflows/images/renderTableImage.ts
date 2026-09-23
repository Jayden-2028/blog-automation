// 표·목록 데이터를 16:9 PNG로 렌더한다(headless Chromium).
//
// 왜 이미지 모델이 아니라 브라우저인가(2026-09-18): gpt-image-2는 한글을 거의 항상 깨뜨려
// `no text, no letters`가 규칙이다(output-format.md §8). 그래서 일정표·순위표처럼 **정보가 글자로
// 전달되는 이미지**는 생성으로 못 만들고, 웹 검색으로도 못 찾는다(실측 전패). 우리가 가진 데이터를
// 우리가 그리면 한글도 수치도 정확하다.
//
// 폰트: 러너(ubuntu-latest)에는 한글 폰트가 없어 그대로 두면 네모(두부)로 나온다 - 워크플로에서
// `fonts-noto-cjk`를 설치한다(job-publish-prepare.yml).

import type { TableData } from "./extractTableData.js";
import { barPercents, pickPictogram, toNumericRows } from "./tableVisuals.js";

/** 구글 디스커버 큰 썸네일 조건(너비 1200px 이상 + 16:9). 생성 이미지와 같은 규격이다. */
export const TABLE_IMAGE_SIZE = { width: 1536, height: 864 };

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * 렌더할 HTML. 뷰어(manuscripts/index.html)와 같은 오렌지 포인트를 써서 블로그 전체 톤을 맞춘다.
 * 행이 많으면 글자를 줄여 한 화면에 담는다 - 잘리는 것보다 작은 편이 낫다.
 */
export function buildTableHtml(data: TableData): string {
  const count = data.rows.length;
  // 행이 적으면 크게 키워 화면을 채운다 - 3행짜리가 위쪽에만 몰려 있으면 썸네일에서 빈약해 보인다.
  const bodySize = count <= 3 ? 48 : count <= 5 ? 40 : count <= 7 ? 33 : count <= 9 ? 27 : 23;
  const gap = count <= 3 ? 18 : count <= 5 ? 14 : 10;

  // label/value가 갈리는 항목만 주황 키 컬럼을 쓴다. 값이 없는 나열형은 전폭 본문색으로 둔다 -
  // 안 그러면 긴 문장이 좁은 키 컬럼에서 주황색으로 줄바꿈돼 읽기 나쁘다(실측).
  // 값이 전부 **같은 단위의 숫자**면 막대그래프로 그린다(2026-09-23 Q6=C안). 아니면 기존 표다 -
  // 단위가 섞였는데 막대를 그리면 길이 비교가 거짓말이 된다.
  const numeric = toNumericRows(data.rows);
  const icon = (label: string): string => {
    const picto = pickPictogram(label);
    return picto
      ? `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="${picto.path}"/></svg>`
      : `<span class="dot"></span>`;
  };

  // 막대 경로에서는 픽토그램을 쓰지 않는다(실측 2026-09-23): 라벨이 지역·업체명이라 규칙에
  // 우연히 걸린 한 줄만 아이콘을 받아 나머지와 어긋난다("신세계 본점"만 핀 아이콘이 붙었다).
  // 항목 성격을 가리키는 라벨이 아니므로 전부 점으로 통일한다.
  const rows = numeric
    ? numeric
        .map((row, i) => {
          const percent = barPercents(numeric)[i];
          return `<div class="bar-row">
            <div class="bar-label"><span class="dot"></span><span>${escapeHtml(row.label)}</span></div>
            <div class="bar-track"><div class="bar-fill" style="width:${percent}%"></div></div>
            <div class="bar-value">${escapeHtml(row.display)}</div>
          </div>`;
        })
        .join("")
    : data.rows
        .map((row) =>
          row.value
            ? `<div class="row">${icon(row.label)}<div class="label">${escapeHtml(row.label)}</div><div class="value">${escapeHtml(row.value)}</div></div>`
            : `<div class="row">${icon(row.label)}<div class="single">${escapeHtml(row.label)}</div></div>`
        )
        .join("");

  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: ${TABLE_IMAGE_SIZE.width}px; height: ${TABLE_IMAGE_SIZE.height}px;
    font-family: "Noto Sans CJK KR", "Noto Sans KR", "Apple SD Gothic Neo", sans-serif;
    background: #fdfbf7; color: #1f2933;
    padding: 64px 80px; display: flex; flex-direction: column;
  }
  h1 {
    font-size: 54px; font-weight: 800; line-height: 1.25; letter-spacing: -0.02em;
    padding-bottom: 28px; border-bottom: 6px solid #f0783c;
  }
  .rows { flex: 1; display: flex; flex-direction: column; justify-content: center; gap: ${gap}px; padding-top: 28px; }
  .row {
    display: flex; align-items: center; gap: 20px;
    padding: ${Math.round(gap * 0.7)}px 24px; border-radius: 14px; background: #f6f1e8;
  }
  .label {
    font-size: ${bodySize}px; font-weight: 700; color: #f0783c;
    flex: 0 0 auto; max-width: 46%; word-break: keep-all;
  }
  .value { font-size: ${bodySize}px; font-weight: 500; color: #33404d; word-break: keep-all; flex: 1; }
  .single { font-size: ${bodySize}px; font-weight: 600; color: #33404d; word-break: keep-all; flex: 1; }
  /* 픽토그램 - 라벨 성격에 맞는 아이콘. 못 고른 항목은 아래 .dot으로 떨어진다. */
  .ico { width: ${Math.round(bodySize * 1.05)}px; height: ${Math.round(bodySize * 1.05)}px;
    flex: 0 0 auto; stroke: #f0783c; stroke-width: 2; fill: none;
    stroke-linecap: round; stroke-linejoin: round; }
  .dot { display: inline-block; width: 12px; height: 12px; border-radius: 50%;
    background: #f0783c; flex: 0 0 auto; margin: 0 2px; }

  /* 막대그래프 - 값이 전부 같은 단위의 숫자일 때만 쓴다. */
  .bar-row { display: flex; align-items: center; gap: 24px;
    padding: ${Math.round(gap * 0.7)}px 24px; border-radius: 14px; background: #f6f1e8; }
  .bar-label { display: flex; align-items: center; gap: 14px; flex: 0 0 34%;
    font-size: ${bodySize}px; font-weight: 700; color: #33404d; word-break: keep-all; }
  .bar-track { flex: 1; height: ${Math.round(bodySize * 0.72)}px; border-radius: 999px; background: #e7ddcd; }
  .bar-fill { height: 100%; border-radius: 999px;
    background: linear-gradient(90deg, #f0783c, #f5a06a); }
  .bar-value { flex: 0 0 auto; min-width: 18%; text-align: right;
    font-size: ${bodySize}px; font-weight: 800; color: #f0783c; }
</style></head>
<body>
  <h1>${escapeHtml(data.title)}</h1>
  <div class="rows">${rows}</div>
</body></html>`;
}

export type RenderTableImageResult =
  | { ok: true; buffer: Buffer; mimeType: string }
  | { ok: false; error: string };

/**
 * Chromium으로 HTML을 PNG로 굽는다. playwright는 이 저장소에 이미 있다(옛 반자동 업로드 잔재).
 * 브라우저 실행 실패는 예외가 아니라 결과로 돌려준다 - 이미지 하나 때문에 원고가 막히면 안 된다.
 */
export async function renderTableImage(data: TableData): Promise<RenderTableImageResult> {
  let browser;
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ args: ["--no-sandbox", "--font-render-hinting=none"] });
    const page = await browser.newPage({ viewport: TABLE_IMAGE_SIZE, deviceScaleFactor: 1 });
    await page.setContent(buildTableHtml(data), { waitUntil: "load" });
    // 폰트가 실제로 적용된 뒤에 찍어야 한다 - 안 기다리면 폴백 폰트로 찍히는 경우가 있다.
    // 문자열로 넘기는 이유: 화살표 함수로 쓰면 Node 쪽 tsconfig에 DOM 타입이 없어 컴파일이 깨진다.
    await page.evaluate("document.fonts.ready");
    const buffer = await page.screenshot({ type: "png" });
    return { ok: true, buffer: Buffer.from(buffer), mimeType: "image/png" };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await browser?.close().catch(() => {});
  }
}
