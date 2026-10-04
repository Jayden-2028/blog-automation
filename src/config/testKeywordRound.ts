// 엔터 회차 판정 테스트 - 외부 호출 없음.
import { formatEntertainmentHeader, getKeywordRoundInfo, inferKeywordRound, resolveKeywordRound } from "./keywordRound.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

// KST 시각 -> UTC Date (KST = UTC+9)
const kst = (hour: number, minute = 0, day = 5) => new Date(Date.UTC(2026, 9, day, hour - 9, minute));

// 1) 정시 및 지연 실행이 자기 회차로 떨어진다
assert(inferKeywordRound(kst(9)) === "morning", "09:00 -> morning");
assert(inferKeywordRound(kst(10, 59)) === "morning", "10:59(지연) -> morning");
assert(inferKeywordRound(kst(13)) === "noon", "13:00 -> noon");
assert(inferKeywordRound(kst(15, 59)) === "noon", "15:59(지연) -> noon");
assert(inferKeywordRound(kst(18)) === "evening", "18:00 -> evening");
assert(inferKeywordRound(kst(23, 30)) === "evening", "23:30 -> evening");
assert(inferKeywordRound(new Date(Date.UTC(2026, 9, 5, 16, 0))) === "evening", "KST 01:00(자정 넘긴 지연) -> evening");

// 2) 명시 값이 시각보다 우선한다
assert(resolveKeywordRound({ KEYWORD_ROUND: "noon" }, kst(9)).round === "noon", "KEYWORD_ROUND가 우선");
assert(resolveKeywordRound({ KEYWORD_ROUND: " evening " }, kst(9)).round === "evening", "공백 허용");

// 3) 빈 값/잘못된 값은 시각 추정으로 떨어진다
assert(resolveKeywordRound({ KEYWORD_ROUND: "" }, kst(13)).round === "noon", "빈 값 -> 시각 추정");
assert(resolveKeywordRound({}, kst(18)).round === "evening", "미설정 -> 시각 추정");
assert(resolveKeywordRound({ KEYWORD_ROUND: "bogus" }, kst(9)).round === "morning", "잘못된 값 -> 시각 추정");

// 4) 제목에 회차 표기
const header = formatEntertainmentHeader(getKeywordRoundInfo("noon"));
assert(header.includes("엔터 키워드") && header.includes("오후(13시) 회차"), `제목: ${header}`);
assert(!header.includes("오전 연예"), "옛 고정 문구가 남지 않는다");

console.log("✅ testKeywordRound 통과");
