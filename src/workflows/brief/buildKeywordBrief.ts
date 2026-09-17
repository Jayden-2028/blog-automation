// 기획 브리프 - 자료조사 전에 "이 키워드를 검색한 사람이 알고 싶은 것"을 먼저 정한다(2026-09-17).
//
// 왜 생겼나(기획 품질 딥다이브, 사용자 보고): 분장놀이 원고는 "예선에서 25팀이 남은 과정", "시상
// 규모", "지난해 모습"을 다뤘다 - 전부 기사에 있는 내용이다. 정작 독자가 원하는 "직접 가서 볼 수
// 있나 / 온라인으로 어디서 보나"는 원고에도, 리서치의 '확인 실패' 목록에도 없었다. 못 찾은 게
// 아니라 **찾을 생각을 안 한 것**이다. researcher.md §6 필수 항목이 정책 템플릿(정의·수치·이력·
// 예외)이라 행사·연예엔 맞는 항목이 없고, writer는 리서치 목차를 따라 쓴다.
//
// 그래서 사후 검증이 아니라 **사전 기획**이다. 사후 검증은 "관람 정보 빠짐"을 지적할 수는 있어도
// 채울 재료가 없다(리서치가 안 됐으니까). 리서치 앞에서 질문을 정해야 리서치가 그걸 찾으러 간다.
//
// 이 브리프는 사람이 보는 문서가 아니다 - researcher와 writer가 읽는 지시서다(사용자 결정: 판단
// 단계를 추가하지 않는다). 사람이 보는 건 리뷰 카드의 "독자 질문 5개 중 N개 답함" 한 줄뿐이다.
//
// 입력 재료: keyword·headline·category + 네이버 자동완성(사람들이 실제로 붙여 검색하는 조합) +
// baseline 제목(이미 collectSourcesForJob이 모아 둔 뉴스·블로그 제목). LLM 1콜, 웹 검색 없음.

import { runHeadlessClaude } from "../../services/llm/runHeadlessClaude.js";
import type { RunHeadlessClaudeResult } from "../../services/llm/runHeadlessClaude.js";
import type { AutocompleteGroup } from "./fetchNaverAutocomplete.js";

export const BRIEF_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * 키워드 유형. researcher.md §4-1의 소스 프로파일과 1:1이다(사용자가 정한 4구분 + 나머지).
 * 유형 이름을 바꾸면 researcher.md도 같이 바꿔야 한다 - 프롬프트가 이 값으로 프로파일을 고른다.
 */
export const BRIEF_TYPES = ["policy", "incident", "celebrity", "drama", "event", "product", "other"] as const;
export type BriefType = (typeof BRIEF_TYPES)[number];

export type KeywordBrief = {
  type: BriefType;
  /** 이 키워드에서 가장 센 후킹 포인트 한 줄. 제목·오프닝의 근거. */
  hook: string;
  /** 독자가 알고 싶은 질문 5개. 원고 소제목의 뼈대이고, 리서치가 답을 찾아야 하는 목록이다. */
  questions: string[];
  /** 읽고 나서 독자가 할 수 있는 행동(예매·신청·시청·관람). 없으면 빈 문자열. */
  action: string;
  /** 자동완성에서 모은 실제 검색 조합. 감사·디버깅용으로 함께 저장한다. */
  autocomplete: string[];
  generatedAt: string;
};

export type BuildKeywordBriefInput = {
  keyword: string;
  headline: string | null;
  category: string | null;
  seedQuery: string | null;
  autocomplete: AutocompleteGroup[];
  /** baseline 출처 제목(뉴스·블로그). 없으면 빈 배열. */
  baselineTitles: string[];
  today: string;
};

export type BuildKeywordBriefResult =
  | { status: "success"; brief: KeywordBrief; durationMs: number }
  | { status: "failed"; error: string };

export function buildBriefPrompt(input: BuildKeywordBriefInput): string {
  const autocompleteLines =
    input.autocomplete.length === 0
      ? ["(자동완성 결과 없음)"]
      : input.autocomplete.map((g) => `- "${g.query}" 뒤에 붙는 검색어: ${g.suggestions.join(" / ")}`);
  const titleLines =
    input.baselineTitles.length === 0
      ? ["(없음)"]
      : input.baselineTitles.slice(0, 20).map((t, i) => `${i + 1}. ${t}`);

  return [
    "너는 블로그 편집장이다. 아래 키워드로 글을 쓰기 **전에**, 이 키워드를 검색한 사람이 정말 알고 싶은",
    "것이 무엇인지 정한다. 자료조사와 집필은 네가 정한 질문에 답하는 방식으로 진행된다.",
    "",
    "## 키워드",
    `- keyword: ${input.keyword}`,
    input.headline && input.headline !== input.keyword ? `- 원문 기사 제목: ${input.headline}` : null,
    input.seedQuery ? `- 발굴 시드: ${input.seedQuery}` : null,
    input.category ? `- 분류: ${input.category}` : null,
    `- 오늘: ${input.today}`,
    "",
    "## 사람들이 실제로 붙여 검색하는 조합 (네이버 자동완성)",
    ...autocompleteLines,
    "",
    "## 이미 나와 있는 글 제목 (뉴스·블로그)",
    ...titleLines,
    "",
    "## 기준 - 뉴스 요약이 아니라 독자의 질문에 답하는 글",
    "뉴스를 메인 정보원으로 삼으면 원고가 기사 요약이 된다(실측: '예선에서 25팀이 남은 과정', '시상",
    "규모', '지난해 모습' - 전부 기사에 있는 내용이지 독자가 검색한 이유가 아니다).",
    "독자 입장에서 기획한 예시를 그대로 따른다:",
    "",
    "```",
    "키워드: 국중박 분장놀이 결선 25팀",
    "Q1 유물놀이가 무슨 행사인가                    (키워드 정의)",
    "Q2 왜 화제인가, 어떤 사례가 퍼졌나              (키워드로 뜬 이유)",
    "Q3 가장 눈에 띄는 출품작은 무엇인가              (핵심 후킹)",
    "Q4 결선 일정과 장소는                           (그래서 언제·어디서)",
    "Q5 일반인이 직접 가서 볼 수 있나, 온라인 시청은 어디서 (그래서 내가 뭘 할 수 있나)",
    "```",
    "",
    "유형별로 독자가 원하는 것이 다르다:",
    "- policy(정책·지원금·제도) / incident(사건·사고): 정확한 사실 - 조건·금액·기간·절차·현재 상태.",
    "- celebrity(연예인·가십): 대중의 반응과 궁금증 - 누구인지·얼굴·SNS·전후 맥락·사람들이 뭐라 하나.",
    "  (실측: '이재시' 검색자는 휴학 사유 분석보다 그가 누구인지·사진·SNS에 반응했다.)",
    "- drama(드라마·영화·OTT): 출연진·케미·줄거리·회차·어디서 보나. 이미지가 핵심이다.",
    "- event(행사·이벤트·공연·전시): 일정·장소·예매처·예매 방법·직접 관람 가능 여부·온라인 시청처.",
    "- product(제품·서비스·할인): 가격·조건·받는 방법·비교.",
    "",
    "질문 규칙:",
    "- 5개. **독자가 검색창에 칠 법한 말**로 쓴다. 자동완성 조합이 있으면 그것이 최우선 근거다.",
    "- Q1은 항상 '이게 뭔가/누군가'(정의)다. 마지막 질문은 항상 '그래서 나는 뭘 할 수 있나'(행동)다 -",
    "  policy/event/product는 신청·예매·관람·구매, drama는 어디서 보나, celebrity/incident는 앞으로 뭘 지켜볼지.",
    "- 기사에 답이 있을 것 같은 질문이 아니라 **독자가 궁금한 질문**을 쓴다. 답이 없을 수도 있다 -",
    "  그건 리서치가 확인할 일이지 네가 걸러낼 일이 아니다.",
    "",
    "## 출력 (이 형식만, 다른 말 없이)",
    `TYPE: ${BRIEF_TYPES.join("|")} 중 하나`,
    "HOOK: 이 키워드에서 가장 센 한 줄 (사람들이 클릭하는 이유)",
    "Q1: ...",
    "Q2: ...",
    "Q3: ...",
    "Q4: ...",
    "Q5: ...",
    "ACTION: 읽고 나서 독자가 할 수 있는 행동 한 줄 (없으면 '없음')",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

export function parseBriefOutput(raw: string): Omit<KeywordBrief, "autocomplete" | "generatedAt"> | null {
  const get = (key: string): string | null => {
    const m = raw.match(new RegExp(`^\\s*${key}:\\s*(.+)$`, "m"));
    return m ? m[1].trim() : null;
  };
  const typeRaw = (get("TYPE") ?? "").toLowerCase().replace(/[^a-z]/g, "");
  const type = (BRIEF_TYPES as readonly string[]).includes(typeRaw) ? (typeRaw as BriefType) : "other";
  const hook = get("HOOK") ?? "";
  const questions = [1, 2, 3, 4, 5].map((n) => get(`Q${n}`)).filter((q): q is string => !!q && q.length > 2);
  if (questions.length < 3 || !hook) return null;
  const actionRaw = get("ACTION") ?? "";
  const action = /^(없음|none|-)$/i.test(actionRaw) ? "" : actionRaw;
  return { type, hook, questions, action };
}

/** researcher·writer 프롬프트에 박아 넣는 공통 서식. 두 프롬프트가 같은 문장을 봐야 한다. */
export function formatBriefForPrompt(brief: KeywordBrief): string {
  return [
    `- 키워드 유형: ${brief.type}`,
    `- 후킹 포인트: ${brief.hook}`,
    "- 독자가 알고 싶은 질문(이 순서가 원고의 뼈대다):",
    ...brief.questions.map((q, i) => `  Q${i + 1}. ${q}`),
    brief.action ? `- 독자 행동: ${brief.action}` : "- 독자 행동: (없음)",
    brief.autocomplete.length > 0 ? `- 실제 검색 조합(자동완성): ${brief.autocomplete.slice(0, 15).join(" / ")}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

export async function buildKeywordBrief(
  input: BuildKeywordBriefInput,
  options: { generate?: (prompt: string) => Promise<RunHeadlessClaudeResult> } = {}
): Promise<BuildKeywordBriefResult> {
  const startedAt = Date.now();
  const generate =
    options.generate ??
    ((prompt: string) => runHeadlessClaude({ prompt, timeoutMs: BRIEF_TIMEOUT_MS, allowedTools: [] }));

  const result = await generate(buildBriefPrompt(input));
  if (!result.ok) return { status: "failed", error: result.error };

  const parsed = parseBriefOutput(result.output);
  if (!parsed) {
    return { status: "failed", error: `브리프 형식을 받지 못했습니다: ${result.output.trim().slice(0, 200)}` };
  }

  return {
    status: "success",
    brief: {
      ...parsed,
      autocomplete: input.autocomplete.flatMap((g) => g.suggestions),
      generatedAt: new Date().toISOString(),
    },
    durationMs: Date.now() - startedAt,
  };
}

/** job.metadata.brief에서 읽는다. 형태가 깨졌으면 null - 브리프 없이도 파이프라인은 돈다. */
export function readJobBrief(metadata: Record<string, unknown> | null | undefined): KeywordBrief | null {
  const raw = metadata?.brief;
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Partial<KeywordBrief>;
  if (!Array.isArray(b.questions) || b.questions.length === 0 || typeof b.hook !== "string") return null;
  return {
    type: (BRIEF_TYPES as readonly string[]).includes(b.type ?? "") ? (b.type as BriefType) : "other",
    hook: b.hook,
    questions: b.questions.filter((q): q is string => typeof q === "string"),
    action: typeof b.action === "string" ? b.action : "",
    autocomplete: Array.isArray(b.autocomplete) ? b.autocomplete.filter((s): s is string => typeof s === "string") : [],
    generatedAt: typeof b.generatedAt === "string" ? b.generatedAt : "",
  };
}
