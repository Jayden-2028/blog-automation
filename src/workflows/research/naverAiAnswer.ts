// 네이버 AI 탭 답변 수집(PERSON-RESEARCH-SOURCES-2026-10 §A-1). 맥 person-pack 폴러에서만 쓴다.
//
// 이 답변은 **구조·커버리지 참고용**이다 - 사실 출처가 아니다(2026-10-17 실측: 데뷔 연도·작품 오류 사례).
// plain fetch로는 JS 셸만 오므로 Playwright로 연다. 로그인 불필요, 전용 임시 프로필(발행 세션 프로필 사용 금지).
// 봇 차단("잘못된 접근입니다")이면 우회하지 않고 errors에 남기고 빈 문자열로 끝난다(비치명).
import { capUtf8 } from "./personSourcePack.js";

/** AI 답변 상한(UTF-8 바이트). */
export const NAVER_AI_ANSWER_MAX_BYTES = 6 * 1024;
/** 총 대기 상한 / 텍스트 길이 불변 판정 시간 / 폴링 간격. */
export const NAVER_AI_TOTAL_WAIT_MS = 25_000;
export const NAVER_AI_STABLE_MS = 3_000;
export const NAVER_AI_POLL_MS = 500;
/** 이보다 짧으면 답변이 아니라 셸·오류 화면으로 본다. */
export const NAVER_AI_MIN_CHARS = 120;

export function naverAiTabUrl(keyword: string): string {
  return `https://search.naver.com/search.naver?ssc=tab.ait.all&query=${encodeURIComponent(keyword.trim())}`;
}

/** 봇 차단·오류 화면 문구. 걸리면 수집하지 않고 사유를 남긴다. */
const BLOCKED_MARKERS = ["잘못된 접근입니다", "자동입력 방지", "비정상적인 접근", "captcha"];

/** 상단 탭·UI 고정 문구(줄 전체가 이것이면 버린다). */
const CHROME_LINES = new Set([
  "AI", "AI Tab", "이미지", "블로그", "클립", "카페", "지식iN", "동영상", "쇼핑", "새 창 열림", "더보기", "뒤로가기",
  "복사", "공유", "좋아요", "싫어요", "답변 다시 생성", "출처", "출처 보기", "관련 질문", "추천 질문", "피드백", "신고",
]);

export type NaverAiExtraction = { answer: string; blocked: boolean };

/**
 * 렌더된 페이지 텍스트(innerText) -> 답변 본문. 고정 UI 줄·짧은 칩(추천 질문·버튼)·"?"로 끝나는 추천 질문 줄을 뺀다.
 * 답변 컨테이너 셀렉터는 headless가 막혀 실측하지 못했다 - 텍스트 기반 필터라 DOM이 바뀌어도 깨지지 않지만,
 * 실제 답변 화면 실측 전이라 줄 필터 기준은 보수적이다(2026-10-17).
 */
export function extractNaverAiAnswer(pageText: string): NaverAiExtraction {
  const lowered = pageText.toLowerCase();
  const blocked = BLOCKED_MARKERS.some((m) => lowered.includes(m.toLowerCase()));
  if (blocked) return { answer: "", blocked: true };
  const lines = pageText
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line && !CHROME_LINES.has(line))
    // 출처 칩("blog.naver.com", "출처 3개")·추천 질문("…은 어떤 작품에 출연했나요?")·짧은 버튼 문구
    .filter((line) => !/^출처\s*\d*개?$/.test(line))
    .filter((line) => !/^[\w.-]+\.(com|net|kr|co\.kr)(\/\S*)?$/i.test(line))
    .filter((line) => !(line.length < 40 && /[?？]$/.test(line)))
    .filter((line) => line.length >= 2);
  const text = lines.join("\n").trim();
  return { answer: text.length >= NAVER_AI_MIN_CHARS ? capUtf8(text, NAVER_AI_ANSWER_MAX_BYTES) : "", blocked: false };
}

export type PollOptions = {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  totalWaitMs?: number;
  stableMs?: number;
  pollMs?: number;
};

/**
 * 스트리밍 생성 대기: 텍스트 길이가 stableMs 동안 불변이면 완료. 총 totalWaitMs를 넘으면 그때까지의 텍스트를 돌려준다.
 * 길이가 0~셸 수준(차단 화면 포함)에서 변하지 않아도 "안정"으로 끝난다 - 빈 답변 반복을 오래 붙잡지 않는다.
 */
export async function pollStableText(getText: () => Promise<string>, options: PollOptions = {}): Promise<string> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;
  const totalWaitMs = options.totalWaitMs ?? NAVER_AI_TOTAL_WAIT_MS;
  const stableMs = options.stableMs ?? NAVER_AI_STABLE_MS;
  const pollMs = options.pollMs ?? NAVER_AI_POLL_MS;
  const startedAt = now();
  let text = await getText();
  let lastLen = text.length;
  let lastChangeAt = now();
  while (now() - startedAt < totalWaitMs) {
    await sleep(pollMs);
    text = await getText();
    if (text.length !== lastLen) {
      lastLen = text.length;
      lastChangeAt = now();
    } else if (now() - lastChangeAt >= stableMs) {
      break;
    }
  }
  return text;
}

export type OpenAiTabPage = { goto(url: string): Promise<void>; getText(): Promise<string>; close(): Promise<void> };

/** 실제 Playwright 페이지. headless 기본 - 전용 임시 프로필(로그인 없음), NAVER_PUBLISH_PROFILE_DIR 미사용. */
export async function openPlaywrightAiTab(): Promise<OpenAiTabPage> {
  const { chromium } = await import("playwright");
  // headful 전환은 메인 판단 사항이다(발주서 §A-1). 기본은 headless이고, 명시 env 없이는 바뀌지 않는다.
  const headless = process.env.PERSON_AI_TAB_HEADFUL !== "1";
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({ locale: "ko-KR" }); // 새 컨텍스트 = 빈 임시 프로필
  const page = await context.newPage();
  return {
    goto: async (url) => {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
    },
    // 문자열 평가: tsconfig에 DOM lib가 없어 함수형 evaluate는 타입 오류가 난다.
    getText: async () => String(await page.evaluate("document.body ? document.body.innerText : ''")),
    close: async () => {
      await browser.close();
    },
  };
}

export type FetchNaverAiAnswerOptions = PollOptions & { open?: () => Promise<OpenAiTabPage> };
export type FetchNaverAiAnswerResult = { answer: string; error?: string };

/** 인물 이름 하나의 AI 탭 답변. 어떤 실패도 던지지 않는다(비치명) - 사유는 error에 담는다. */
export async function fetchNaverAiAnswer(keyword: string, options: FetchNaverAiAnswerOptions = {}): Promise<FetchNaverAiAnswerResult> {
  let page: OpenAiTabPage | null = null;
  try {
    page = await (options.open ?? openPlaywrightAiTab)();
    await page.goto(naverAiTabUrl(keyword));
    const text = await pollStableText(() => page!.getText(), options);
    const { answer, blocked } = extractNaverAiAnswer(text);
    if (blocked) return { answer: "", error: "naverAiAnswer: 네이버 봇 차단 화면(잘못된 접근입니다) - 우회하지 않음" };
    if (!answer) return { answer: "", error: `naverAiAnswer: 답변 텍스트 없음(${text.length}자 수신, 최소 ${NAVER_AI_MIN_CHARS}자)` };
    return { answer };
  } catch (error) {
    return { answer: "", error: `naverAiAnswer: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    await page?.close().catch(() => undefined);
  }
}
