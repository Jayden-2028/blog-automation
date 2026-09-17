// 기획 브리프 테스트. 자동완성 HTTP와 Claude 호출을 주입해 외부 호출 없이 질의 생성·파싱·서식만 본다.

import { buildAutocompleteQueries, collectAutocomplete } from "./fetchNaverAutocomplete.js";
import { buildBriefPrompt, buildKeywordBrief, formatBriefForPrompt, parseBriefOutput, readJobBrief } from "./buildKeywordBrief.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

// --- 1. 긴 키워드에서 자동완성 질의를 여러 창으로 만든다 -------------------------------------
{
  const queries = buildAutocompleteQueries("사람이 유물로 변신 국중박 분장놀이 본선행 25팀 공개", "국립중앙박물관 분장놀이");
  assert(queries[0] === "국립중앙박물관 분장놀이", "seed_query가 첫 질의여야 합니다");
  assert(queries.includes("국중박 분장놀이"), "2어절 창 '국중박 분장놀이'가 있어야 합니다");
  assert(queries.length <= 10, `질의가 10개를 넘습니다(${queries.length})`);
  assert(!queries.some((q) => q.includes("?")), "문장부호가 질의에 남았습니다");
  assert(!queries.includes("사람이"), "긴 키워드에서 단일 어절 질의가 남았습니다(잡음 실측)");
  assert(buildAutocompleteQueries("이재시", null).includes("이재시"), "짧은 키워드는 단일 어절을 던져야 합니다");
  console.log("✅ 자동완성 질의 - seed 우선, 2어절 창, 상한 10");
}

// --- 2. 자동완성 그룹 - 질의 자체 제외, 중복 제거, 실패 그룹 버림 ----------------------------
{
  const groups = await collectAutocomplete("국중박 분장놀이 결선", null, async (q) => {
    if (q === "국중박 분장놀이") return ["국중박 분장놀이", "국중박 분장놀이 결선", "국중박 분장놀이 상금"];
    if (q === "분장놀이 결선") return ["국중박 분장놀이 결선", "분장놀이 결선 일정"];
    return [];
  });
  const all = groups.flatMap((g) => g.suggestions);
  assert(!all.includes("국중박 분장놀이"), "질의와 같은 문구가 남았습니다");
  assert(all.filter((s) => s === "국중박 분장놀이 결선").length === 1, "중복이 제거되지 않았습니다");
  assert(all.includes("분장놀이 결선 일정"), "두 번째 그룹의 새 항목이 빠졌습니다");
  assert(groups.every((g) => g.suggestions.length > 0), "빈 그룹이 남았습니다");
  console.log("✅ 자동완성 그룹 - 질의 제외·중복 제거·빈 그룹 제거");
}

// --- 3. 프롬프트에 자동완성·제목·유형 기준·예시가 실린다 --------------------------------------
{
  const prompt = buildBriefPrompt({
    keyword: "국중박 분장놀이 결선",
    headline: "사람이 유물로 변신…'국중박 분장놀이' 본선행 25팀 공개",
    category: "entertainment",
    seedQuery: "국립중앙박물관 분장놀이",
    autocomplete: [{ query: "국중박 분장놀이", suggestions: ["국중박 분장놀이 결선", "국중박 분장놀이 상금"] }],
    baselineTitles: ["이혜정, 간돌검 분장으로 결선行"],
    kinQuestions: ["국중박 분장놀이 일반인도 볼 수 있나요?"],
    today: "2026-09-17",
  });
  assert(prompt.includes("국중박 분장놀이 상금"), "자동완성이 프롬프트에 없습니다");
  assert(prompt.includes("지식iN·카페에 실제로 올린 질문") && prompt.includes("일반인도 볼 수 있나요"), "지식iN 질문 섹션이 없습니다");
  assert(prompt.includes("이혜정, 간돌검"), "baseline 제목이 프롬프트에 없습니다");
  assert(prompt.includes("직접 가서 볼 수 있나"), "독자 기획 예시가 프롬프트에 없습니다");
  assert(prompt.includes("TYPE:") && prompt.includes("Q5:") && prompt.includes("ACTION:"), "출력 형식 지시가 빠졌습니다");
  console.log("✅ 브리프 프롬프트 - 자동완성·제목·예시·출력 형식");
}

// --- 4. 출력 파싱 - 잡음 견딤, 유형 폴백, 질문 3개 미만이면 실패 ----------------------------
{
  const ok = parseBriefOutput(
    [
      "정리했습니다.",
      "TYPE: event",
      "HOOK: 모델 이혜정이 간돌검으로 분장해 결선에 올랐다",
      "Q1: 국중박 분장놀이가 무슨 행사인가",
      "Q2: 왜 화제가 됐나",
      "Q3: 가장 눈에 띄는 출품작은",
      "Q4: 결선은 언제 어디서 열리나",
      "Q5: 직접 가서 볼 수 있나, 온라인으로는 어디서 보나",
      "ACTION: 9월 19일 국립중앙박물관 열린마당 현장 관람 또는 유튜브 생중계 시청",
    ].join("\n")
  );
  assert(ok && ok.type === "event" && ok.questions.length === 5, "정상 출력이 파싱되지 않았습니다");
  assert(ok.action.includes("열린마당"), "ACTION이 파싱되지 않았습니다");

  const fallbackType = parseBriefOutput("TYPE: festival\nHOOK: 훅\nQ1: 무엇인가\nQ2: 왜 화제인가\nQ3: 누가 나오나\nACTION: 없음");
  assert(fallbackType && fallbackType.type === "other", "모르는 유형이 other로 폴백되지 않았습니다");
  assert(fallbackType.action === "", "'없음'이 빈 문자열로 정규화되지 않았습니다");

  assert(parseBriefOutput("TYPE: event\nHOOK: 훅\nQ1: 질문 하나뿐") === null, "질문 3개 미만이 통과됐습니다");
  console.log("✅ 브리프 파싱 - 잡음·유형 폴백·최소 질문 수");
}

// --- 5. 생성 결과에 자동완성이 붙고, 서식이 두 프롬프트에 같은 문장을 준다 -------------------
{
  const result = await buildKeywordBrief(
    {
      keyword: "k",
      headline: null,
      category: "entertainment",
      seedQuery: null,
      autocomplete: [{ query: "k", suggestions: ["k 결선", "k 상금"] }],
      baselineTitles: [],
      today: "2026-09-17",
    },
    {
      generate: async () => ({
        ok: true as const,
        output: "TYPE: event\nHOOK: 훅\nQ1: 무엇인가\nQ2: 왜 화제인가\nQ3: 누가 나오나\nQ4: 언제 하나\nQ5: 어떻게 보나\nACTION: 예매",
        durationMs: 1,
      }),
    }
  );
  assert(result.status === "success", "생성이 실패했습니다");
  assert(result.brief.autocomplete.join(",") === "k 결선,k 상금", "자동완성이 브리프에 붙지 않았습니다");

  const text = formatBriefForPrompt(result.brief);
  assert(text.includes("Q5. 어떻게 보나") && text.includes("독자 행동: 예매"), "프롬프트 서식이 틀렸습니다");

  const roundTrip = readJobBrief({ brief: JSON.parse(JSON.stringify(result.brief)) });
  assert(roundTrip && roundTrip.questions.length === 5, "metadata 왕복이 깨졌습니다");
  assert(readJobBrief({ brief: { hook: "x" } }) === null, "질문 없는 브리프가 통과됐습니다");
  assert(readJobBrief(null) === null, "metadata 없음이 null이 아닙니다");
  console.log("✅ 브리프 생성·서식·metadata 왕복");
}

console.log("\n🎉 기획 브리프 테스트 통과");
