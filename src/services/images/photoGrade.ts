// Korea Plain(koreaplain) 실제 사진의 **톤앤무드 일괄 보정**(2026-11-25).
//
// 왜: 이 트랙의 실제 사진은 출처가 여럿이다(한국관광공사 관광사진, 지자체·공공기관, 위키미디어). 촬영자·연도·장비가 제각각이라
// 한 글 안에서 밝기·색감·비율이 들쭉날쭉하다. 사진을 바꾸지 않는 선에서 **같은 틀**에 맞춘다:
//   1. 16:9 중앙 크롭 → 1600×900(원본이 작으면 확대하지 않고 16:9로만 자른다)
//   2. 밝기 정규화 - 평균 휘도를 목표값 쪽으로(상한 ±12%)
//   3. 대비 정규화 - 휘도 표준편차를 목표값 쪽으로(0.95~1.12배)
//   4. 약간 따뜻한 색온도 - R +3.5%, B -3.5%
// 강도는 **`KOREAPLAIN_PHOTO_GRADE` 한 곳**에서 정한다(`strength` 하나로 2~4를 함께 줄이거나 키운다).
//
// 실행은 기존 WebP 변환 경로(optimizeImage.ts의 Chromium canvas) 위에서 한다 - sharp 같은 라이브러리를 새로 넣지 않는다
// (optimizeImage.ts·cropTallImage.ts와 같은 이유: 러너와 맥에 playwright가 이미 있다).
//
// 픽셀 계산은 **아래 JS 소스 문자열 한 벌**이다. 브라우저에는 그대로 박아 넣고, Node 테스트는 같은 문자열을 Function으로 만들어
// 검증한다 - TS 함수를 toString()으로 넘기면 번들러가 끼워 넣는 도우미(__name 등) 때문에 브라우저에서 깨질 수 있다.
//
// 적용 범위: koreaplain의 **실제 사진**(관광사진 + 허용 출처 웹 수집)만. AI 일러스트·페이지 캡처·다른 트랙은 건드리지 않는다
// (collectWebImagesForJob.ts가 koreaplain일 때만 `grade`를 넘긴다). 변경 금지 라이선스는 보정 대신 수집에서 제외한다
// (koreaplainImageSources.ts isNoDerivativesLicense).

export type PhotoGrade = {
  /** 출력 비율 가로/세로. */
  aspect: number;
  /** 출력 최대 크기(확대하지 않는다). */
  width: number;
  height: number;
  /** 보정 강도 배율. 0이면 크롭·변환만, 1이 기본. */
  strength: number;
  /** 평균 휘도 목표(0~1). */
  targetMeanLuma: number;
  /** 밝기 배율 상한(1 ± 이 값). */
  maxBrightnessShift: number;
  /** 휘도 표준편차 목표(0~1). */
  targetLumaStd: number;
  /** 대비 배율 범위. */
  minContrast: number;
  maxContrast: number;
  /** 따뜻함: R에 +w, B에 -w 배율. */
  warmth: number;
  /** WebP 화질(0~1). */
  quality: number;
};

/** **보정 강도는 여기 한 곳이다.** */
export const KOREAPLAIN_PHOTO_GRADE: PhotoGrade = {
  aspect: 16 / 9,
  width: 1600,
  height: 900,
  strength: 1,
  targetMeanLuma: 0.5,
  maxBrightnessShift: 0.12,
  targetLumaStd: 0.22,
  minContrast: 0.95,
  maxContrast: 1.12,
  warmth: 0.035,
  quality: 0.86,
};

export type GradeParams = { gain: number; contrast: number; pivot: number; warmth: number };
export type LumaStats = { mean: number; std: number };

/**
 * 브라우저와 Node가 함께 쓰는 순수 JS. 이름이 `__pg`로 시작하는 함수 다섯 개를 정의한다.
 *   __pgCropRect(w, h, aspect)              → {sx, sy, sw, sh} 중앙 크롭
 *   __pgOutputSize(sw, sh, maxW, maxH)      → {width, height} 확대 없는 축소
 *   __pgLumaStats(data, step)               → {mean, std} (0~1, RGBA 배열을 step 픽셀 간격으로 표본)
 *   __pgParams(stats, grade)                → {gain, contrast, pivot, warmth}
 *   __pgApply(data, params)                 → data를 제자리에서 보정
 */
export const PHOTO_GRADE_JS = `
function __pgCropRect(w, h, aspect) {
  if (!(w > 0) || !(h > 0)) return { sx: 0, sy: 0, sw: w, sh: h };
  if (w / h > aspect) {
    var sw = Math.max(1, Math.round(h * aspect));
    return { sx: Math.floor((w - sw) / 2), sy: 0, sw: sw, sh: h };
  }
  var sh = Math.max(1, Math.round(w / aspect));
  return { sx: 0, sy: Math.floor((h - sh) / 2), sw: w, sh: sh };
}
function __pgOutputSize(sw, sh, maxW, maxH) {
  var scale = Math.min(1, maxW / sw, maxH / sh);
  return { width: Math.max(1, Math.round(sw * scale)), height: Math.max(1, Math.round(sh * scale)) };
}
function __pgLumaStats(data, step) {
  var stride = Math.max(1, step | 0) * 4;
  var n = 0, sum = 0, sumSq = 0;
  for (var i = 0; i + 2 < data.length; i += stride) {
    var y = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
    sum += y; sumSq += y * y; n += 1;
  }
  if (n === 0) return { mean: 0.5, std: 0.22 };
  var mean = sum / n;
  return { mean: mean, std: Math.sqrt(Math.max(0, sumSq / n - mean * mean)) };
}
function __pgParams(stats, grade) {
  var s = Math.max(0, grade.strength);
  var clamp = function (v, lo, hi) { return Math.min(hi, Math.max(lo, v)); };
  var rawGain = stats.mean > 0.02 ? grade.targetMeanLuma / stats.mean : 1 + grade.maxBrightnessShift;
  var gain = clamp(rawGain, 1 - grade.maxBrightnessShift, 1 + grade.maxBrightnessShift);
  var rawContrast = stats.std > 0.02 ? grade.targetLumaStd / stats.std : grade.maxContrast;
  var contrast = clamp(rawContrast, grade.minContrast, grade.maxContrast);
  var pivot = clamp(stats.mean * gain, 0.2, 0.8);
  return { gain: 1 + (gain - 1) * s, contrast: 1 + (contrast - 1) * s, pivot: pivot, warmth: grade.warmth * s };
}
function __pgApply(data, p) {
  var pv = p.pivot * 255;
  var rw = 1 + p.warmth, bw = 1 - p.warmth;
  for (var i = 0; i + 2 < data.length; i += 4) {
    var r = (data[i] * p.gain - pv) * p.contrast + pv;
    var g = (data[i + 1] * p.gain - pv) * p.contrast + pv;
    var b = (data[i + 2] * p.gain - pv) * p.contrast + pv;
    r *= rw; b *= bw;
    data[i] = r < 0 ? 0 : r > 255 ? 255 : Math.round(r);
    data[i + 1] = g < 0 ? 0 : g > 255 ? 255 : Math.round(g);
    data[i + 2] = b < 0 ? 0 : b > 255 ? 255 : Math.round(b);
  }
  return data;
}
`;

type GradeLib = {
  cropRect: (w: number, h: number, aspect: number) => { sx: number; sy: number; sw: number; sh: number };
  outputSize: (sw: number, sh: number, maxW: number, maxH: number) => { width: number; height: number };
  lumaStats: (data: ArrayLike<number>, step: number) => LumaStats;
  params: (stats: LumaStats, grade: PhotoGrade) => GradeParams;
  apply: <T extends { length: number; [index: number]: number }>(data: T, params: GradeParams) => T;
};

let lib: GradeLib | null = null;

/** Node에서 같은 소스를 쓰는 함수 묶음(테스트·로그용). */
export function photoGradeLib(): GradeLib {
  if (!lib) {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    lib = new Function(
      `${PHOTO_GRADE_JS}; return { cropRect: __pgCropRect, outputSize: __pgOutputSize, lumaStats: __pgLumaStats, params: __pgParams, apply: __pgApply };`
    )() as GradeLib;
  }
  return lib;
}

/** 로그 한 줄: "밝기 ×1.06 · 대비 ×1.04 · 따뜻함 +3.5%". */
export function describeGradeParams(params: GradeParams): string {
  return `밝기 ×${params.gain.toFixed(2)} · 대비 ×${params.contrast.toFixed(2)} · 따뜻함 +${(params.warmth * 100).toFixed(1)}%`;
}
