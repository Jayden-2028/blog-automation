// 원고가 저장되기 직전에 core-rules.md의 금지 규칙을 코드로 한 번 더 집행한다(2026-09-30).
//
// 왜 필요한가: 규칙을 프롬프트에 적는 것만으로는 위반이 계속 재발했다(같은 종류의 문장이 모양만
// 바꿔 여러 번 나왔다). 규칙에는 실행자가 있어야 한다 - 이 모듈이 그 실행자다.
//
// 두 단계다.
//  1) 결정적 교정(applyDeterministicFixes): 문장을 지워도 사실이 사라지지 않는 것만 코드가 직접 지운다
//     (댓글 유도 문장, "○월 기준" 시점 표기, 연결어미 뒤 쉼표). 판단이 필요한 것은 건드리지 않는다.
//  2) 에이전트 교정(enforceWritingRules): 남은 위반(보도 인용·확인 여부 서술·비공개 서술·경위·한정·계산 서술·구어 어미)은
//     문장 목록을 주고 헤드리스 에이전트에게 한 번만 고치게 한다. 고친 결과가 위반을 줄이지 못했거나
//     이미지 마커 수가 달라지면 원본을 그대로 쓴다(fail-open + 로그).

import { PIPELINE_ROOT } from "../../config/pipelinePaths.js";
import { runHeadlessClaude } from "../../services/llm/runHeadlessClaude.js";
import type { RunHeadlessClaudeResult } from "../../services/llm/runHeadlessClaude.js";
import {
  AS_OF_PATTERN,
  currentYearInDatePattern,
  kstYear,
  BANNED_COLLOQUIAL_ENDINGS,
  findColloquialEndings,
  maskQuotedSpans,
  COMMENT_INVITE_PATTERN,
  COVERAGE_NARRATIVE_PATTERN,
  MEDIA_ATTRIBUTION_PATTERN,
  PARTIAL_GAP_PATTERN,
  PROVENANCE_NARRATIVE_PATTERN,
  UNPUBLISHED_PATTERN,
  VERIFICATION_STATUS_PATTERN,
} from "./bannedPatterns.js";

export type RuleViolation = { rule: string; sentence: string };

const AGENT_RULES: Array<{ rule: string; pattern: RegExp }> = [
  { rule: "보도·매체 인용 금지(사실로 단정하거나, 실제 인물·기관을 주어로 직접 쓴다)", pattern: MEDIA_ATTRIBUTION_PATTERN },
  { rule: "보도 경위 서술 금지(삭제)", pattern: COVERAGE_NARRATIVE_PATTERN },
  { rule: "확인·확정 여부 서술 금지(삭제)", pattern: VERIFICATION_STATUS_PATTERN },
  { rule: "자료에 없는 항목 언급 금지(삭제)", pattern: PARTIAL_GAP_PATTERN },
  { rule: "비공개·미정 서술 금지(삭제)", pattern: UNPUBLISHED_PATTERN },
  { rule: "경위·한정·계산 서술 금지(사실을 사건 문장으로 고친다)", pattern: PROVENANCE_NARRATIVE_PATTERN },
  { rule: "구어 어미 금지(합니다체·해요체로 고친다)", pattern: BANNED_COLLOQUIAL_ENDINGS },
];

/** 검사하지 않는 줄: frontmatter 구분선, 주석, 이미지 마커, 소제목, 해시태그, 참고 자료 링크. */
function isProtectedLine(line: string): boolean {
  const t = line.trim();
  return (
    t === "" ||
    t === "---" ||
    t.startsWith("<!--") ||
    t.startsWith("[IMAGE") ||
    t.startsWith("#") ||
    /^\*\*[^*]+\*\*$/.test(t)
  );
}

function splitSentences(line: string): string[] {
  return line.split(/(?<=[.!?。])\s+/).filter((part) => part.length > 0);
}

/** 참고 자료 섹션 이전만 본다(남의 글 제목이 섞이는 구간). */
function splitAtReferences(body: string): { main: string; rest: string } {
  const at = body.search(/^#{1,3}\s*참고\s*자료|^\*\*참고\s*자료\*\*/m);
  return at < 0 ? { main: body, rest: "" } : { main: body.slice(0, at), rest: body.slice(at) };
}

/** "○월 기준입니다"처럼 기준 시점 자체가 서술어인 문장은 표기만 지우면 문장이 깨지므로 통째로 지운다. */
const AS_OF_DISCLAIMER_SENTENCE = /(?:\d{4}년|\d{1,2}월|\d{1,2}일)[^.!?\n]{0,14}기준(?:입니다|이에요|이예요|임)\.?$|\d{1,2}일자로\s*확인[^.!?\n]{0,15}(?:입니다|이에요)\.?$/;

export type DeterministicFixResult = { body: string; removed: string[] };

/**
 * C-11 연결어미 직후 습관성 쉼표(2026-10-15, rules/humanize.md §2). "교제를 인정했고, 약 8개월" -> "인정했고 약 8개월".
 * 과교정이 더 나쁘므로 **확실한 경우만** 지운다:
 *  - 연결어미는 앞 음절이 과거·존재 표지인 것만 본다(받침 ㅆ 음절·겠 + 고·으며·지만, 없/같 + 고·지만, 없 + 으며, 하/되 + 며, 아/어/해/여 + 서).
 *    "신고, 광고"(명사)·"하지만, 그래서, 따라서"(문두 접속부사)·"이고/이며"(명사 병렬)는 건드리지 않는다.
 *  - 직접 인용(따옴표 안)은 보지 않는다. 문장에 인용 밖 쉼표(뒤에 공백이 오는 것)가 **정확히 하나**일 때만 지운다 -
 *    둘 이상이면 나열 구문이라 둔다. 숫자 천 단위 쉼표("1,200")는 뒤에 공백이 없어 세지 않는다.
 */
// 받침 ㅆ으로 끝나는 모든 음절(았·었·였·했·됐·갔·썼·왔·있 ...) = 과거형 어간. 명사가 이 음절로 끝나고 바로 고·으며·지만이 붙는 일은 없다.
const PAST_SYLLABLE = Array.from({ length: 19 * 21 }, (_, i) => String.fromCharCode(0xac00 + i * 28 + 20)).join("");
const CONNECTIVE_TOKEN = new RegExp(
  `(?:[${PAST_SYLLABLE}겠]고|[없같]고|[${PAST_SYLLABLE}겠]으며|없으며|[하되]며|[${PAST_SYLLABLE}겠]지만|[없같]지만|[아어해여]서)$`
);
const NOT_CONNECTIVE_TOKENS = new Set(["이어서"]);

export function removeConnectiveCommas(line: string): { text: string; removed: string[] } {
  const t = line.trim();
  if (t.startsWith("-") || t.startsWith("|") || t.startsWith(">") || /^[a-z_]+:\s/i.test(t) || /^\d+[.)]\s/.test(t)) {
    return { text: line, removed: [] };
  }
  const masked = maskQuotedSpans(line);
  const removed: string[] = [];
  const dropAt: number[] = [];
  let cursor = 0;
  for (const sentence of splitSentences(line)) {
    const at = line.indexOf(sentence, cursor);
    cursor = at + sentence.length;
    const m = masked.slice(at, at + sentence.length);
    const commas = [...m.matchAll(/,(?=\s)/g)];
    if (commas.length !== 1) continue;
    const idx = commas[0].index ?? 0;
    const token = m.slice(0, idx).split(/\s/).pop() ?? "";
    if (!CONNECTIVE_TOKEN.test(token) || NOT_CONNECTIVE_TOKENS.has(token)) continue;
    dropAt.push(at + idx);
    removed.push(`연결어미 뒤 쉼표: ${token},`);
  }
  if (dropAt.length === 0) return { text: line, removed };
  let text = line;
  for (const i of dropAt.reverse()) text = text.slice(0, i) + text.slice(i + 1);
  return { text, removed };
}

/**
 * 코드가 직접 지워도 안전한 것만 지운다.
 *  - 댓글·의견 유도 문장 -> 문장 삭제
 *  - "2026년 8월 기준", "9월 18일 기준" 같은 시점 표기 -> 표기만 삭제(값 문장은 남긴다)
 *  - 연결어미 직후 습관성 쉼표(C-11) -> 쉼표만 삭제(인용·나열 구문 제외, removeConnectiveCommas 참고)
 */
export function applyDeterministicFixes(body: string, now: Date = new Date()): DeterministicFixResult {
  const { main, rest } = splitAtReferences(body);
  const removed: string[] = [];

  const lines = main.split("\n").map((line) => {
    if (isProtectedLine(line)) return line;
    const kept = splitSentences(line).filter((sentence) => {
      COMMENT_INVITE_PATTERN.lastIndex = 0;
      if (COMMENT_INVITE_PATTERN.test(sentence) || AS_OF_DISCLAIMER_SENTENCE.test(sentence)) {
        removed.push(sentence);
        return false;
      }
      return true;
    });
    let out = kept.join(" ");
    AS_OF_PATTERN.lastIndex = 0;
    const stripped = out.replace(
      /(?:\d{4}년\s*)?\d{1,2}월(?:\s*\d{1,2}일)?\s*(?:시점\s*)?기준(?:으로)?[,\s]*/g,
      ""
    );
    if (stripped !== out) {
      removed.push(out.match(/(?:\d{4}년\s*)?\d{1,2}월(?:\s*\d{1,2}일)?\s*(?:시점\s*)?기준(?:으로)?/)?.[0] ?? "기준 시점");
      out = stripped;
    }
    // 올해 날짜의 연도만 뗀다(2026-10-02). 다른 연도는 정보라 그대로 둔다.
    const year = kstYear(now);
    const withoutYear = out.replace(currentYearInDatePattern(year), "");
    if (withoutYear !== out) {
      removed.push(`${year}년(올해 연도 표기)`);
      out = withoutYear;
    }
    // 연결어미 뒤 습관성 쉼표(C-11) - 인용 제외, 단일 쉼표만
    const commaFix = removeConnectiveCommas(out);
    if (commaFix.removed.length > 0) {
      removed.push(...commaFix.removed);
      out = commaFix.text;
    }
    return out;
  });

  const cleaned = lines.join("\n").replace(/\n{3,}/g, "\n\n");
  return { body: cleaned + rest, removed };
}

/**
 * 에이전트에게 맡길 위반 문장 목록. category가 person이면 허용 어미(~거든요·~고요)는 위반이 아니다.
 * 구어 어미는 직접 인용(따옴표 안)을 제외하고 본다(2026-10-15, 전 카테고리 공통 - checkVoice와 같은 기준).
 * 따옴표가 문장 경계(". ")를 넘을 수 있어 줄 단위로 마스크한 뒤 같은 위치로 문장을 자른다.
 */
export function findRuleViolations(body: string, category?: string | null): RuleViolation[] {
  const { main } = splitAtReferences(body);
  const found: RuleViolation[] = [];
  for (const line of main.split("\n")) {
    if (isProtectedLine(line)) continue;
    const masked = maskQuotedSpans(line);
    let cursor = 0;
    for (const sentence of splitSentences(line)) {
      const at = line.indexOf(sentence, cursor);
      cursor = at + sentence.length;
      const maskedSentence = masked.slice(at, at + sentence.length);
      for (const { rule, pattern } of AGENT_RULES) {
        // incident는 한정·부인 서술이 무죄추정의 일부라 경위·한정 규칙을 적용하지 않는다(core-rules §1-12).
        if (pattern === PROVENANCE_NARRATIVE_PATTERN && category === "incident") continue;
        pattern.lastIndex = 0;
        const hit =
          pattern === BANNED_COLLOQUIAL_ENDINGS
            ? findColloquialEndings(maskedSentence, category).length > 0
            : pattern.test(sentence);
        if (hit) {
          found.push({ rule, sentence: sentence.trim() });
          break;
        }
      }
    }
  }
  return found;
}

function countMarkers(body: string): number {
  return body.split("\n").filter((line) => /^\[IMAGE:/.test(line.trim())).length;
}

function buildFixPrompt(body: string, violations: RuleViolation[], category: string | null): string {
  return [
    "아래 블로그 원고에서 금지 규칙을 어긴 문장만 고친다. 다른 문장은 한 글자도 바꾸지 않는다.",
    "먼저 prompts/writing/core-rules.md를 Read하고 그 규칙대로 고친다." +
      (category === "incident"
        ? " 어투는 prompts/writing/style/incident.md(습니다체·1인칭 금지)를 따른다."
        : category === "person"
          ? " 어투는 prompts/writing/style/voice.md를 따르되, 인물 백과는 `~거든요`·`~고요`를 허용하므로 그 어미는 고치지 않는다."
          : " 어투는 prompts/writing/style/voice.md를 따른다."),
    "",
    "고치는 방법:",
    "- '삭제'로 표시된 규칙: 그 문장을 통째로 뺀다. 문단이 비면 문단도 뺀다. 새 문장으로 대체하지 않는다.",
    "- 보도·매체 인용: 그 사실을 단정문으로 쓰거나, 실제 인물·기관이 한 말이면 그 사람·기관을 주어로 직접 쓴다.",
    "- 경위·한정·계산 서술: 그 사실을 '누가 무엇을 했다'는 사건 문장 하나로 다시 쓴다. 소식이 나온 경로는 주어·부사구로",
    "  한 번만 넣고(\"~영상에서 나왔습니다\"), '~한 명이고/~는 아닙니다' 같은 한정·부인과 '~로 따지면 약 N년' 같은",
    "  계산 과정은 뺀다. 계산으로 만든 값은 쓰지 않고 자료에 있는 값만 남긴다(facts-and-hedging.md §4-3).",
    "- 구어 어미: 정보 문장은 합니다체, 반응 문장은 해요체로 바꾼다.",
    "- 사실(수치·날짜·고유명사)은 바꾸지 않는다. 새 사실을 더하지 않는다.",
    "- `[IMAGE: ...]`/`[IMAGE PROMPT: ...]` 줄, 소제목(**...**), 해시태그, 참고 자료는 그대로 둔다.",
    "",
    "고칠 문장:",
    ...violations.map((v, i) => `${i + 1}. [${v.rule}] ${v.sentence}`),
    "",
    "출력은 고친 원고 본문 전체만. 설명·머리말·코드펜스를 붙이지 않는다. 본문은 `### BODY` 다음 줄부터 쓴다.",
    "",
    "### 원고",
    body,
  ].join("\n");
}

export type EnforceWritingRulesInput = {
  body: string;
  category: string | null;
  /** "올해"를 정하는 기준 시각(테스트 주입용). 생략하면 현재 시각. */
  now?: Date;
  /** 테스트 주입 지점. 기본은 runHeadlessClaude(claude -p, Read만 허용). */
  runFixer?: (prompt: string) => Promise<RunHeadlessClaudeResult>;
};

export type EnforceWritingRulesResult = {
  body: string;
  deterministicRemoved: string[];
  violationsBefore: number;
  violationsAfter: number;
  agentApplied: boolean;
};

const FIXER_TIMEOUT_MS = 10 * 60 * 1000;

export async function enforceWritingRules(input: EnforceWritingRulesInput): Promise<EnforceWritingRulesResult> {
  const det = applyDeterministicFixes(input.body, input.now);
  let body = det.body;
  const violations = findRuleViolations(body, input.category);
  const result: EnforceWritingRulesResult = {
    body,
    deterministicRemoved: det.removed,
    violationsBefore: violations.length,
    violationsAfter: violations.length,
    agentApplied: false,
  };
  if (det.removed.length > 0) {
    console.log(`ℹ️ [rules] 코드 교정: ${det.removed.length}건(댓글 유도·기준 시점·올해 연도·연결어미 뒤 쉼표)`);
  }
  if (violations.length === 0) return result;

  const run =
    input.runFixer ??
    ((prompt: string) =>
      runHeadlessClaude({ prompt, allowedTools: ["Read"], permissionMode: "acceptEdits", cwd: PIPELINE_ROOT, timeoutMs: FIXER_TIMEOUT_MS }));

  const ran = await run(buildFixPrompt(body, violations, input.category));
  if (!ran.ok) {
    console.warn(`⚠️ [rules] 자동 교정 호출 실패(원본 유지, 위반 ${violations.length}건): ${ran.error}`);
    return result;
  }

  const marker = "### BODY";
  const at = ran.output.indexOf(marker);
  const candidate = (at >= 0 ? ran.output.slice(at + marker.length) : ran.output).trim();
  const after = findRuleViolations(candidate, input.category);
  const okLength = candidate.length >= body.length * 0.7;
  const okMarkers = countMarkers(candidate) === countMarkers(body);
  if (!okLength || !okMarkers || after.length >= violations.length) {
    console.warn(
      `⚠️ [rules] 자동 교정 결과를 버립니다(길이 ${okLength ? "ok" : "너무 짧음"}, 마커 ${okMarkers ? "ok" : "달라짐"}, 위반 ${violations.length}→${after.length}). 원본 유지`
    );
    return result;
  }

  console.log(`ℹ️ [rules] 자동 교정 적용: 위반 ${violations.length}→${after.length}건`);
  return { ...result, body: candidate, violationsAfter: after.length, agentApplied: true };
}
