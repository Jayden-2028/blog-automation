// 문장 diff를 Claude Code CLI(`claude -p`)에 넘겨 유형 분류 + 규격 개정안을 받는다.
// 규격 파일은 읽기만 한다(개정안은 보고서 안의 diff 블록으로만 남고 적용하지 않는다).
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { runHeadlessClaude } from "../../services/llm/runHeadlessClaude.js";
import type { RunHeadlessClaudeResult } from "../../services/llm/runHeadlessClaude.js";
import type { SentenceDiff } from "./sentenceDiff.js";

export const SPEC_FILES = {
  core: "prompts/writing/core-rules.md",
  entertainment: "prompts/writing/style/entertainment.md",
  person: "prompts/writing/style/person.md",
  voice: "prompts/writing/style/voice.md",
} as const;

/** STYLE-TUNING-2026-10.md §A(2026-10-16 7쌍 실측)의 유형 4가지. 참고용이며 새 유형을 막지 않는다. */
export const KNOWN_ADDED_TYPES = [
  "1인칭 감상·해석 — \"가끔 저는 이런 류의 작품이 굉장히 신선하게 느껴지는 경우가 있는데요\", \"너무 로맨틱하네요\"",
  "업계 경험칙 전망 — \"~하는 경우가 많은 편입니다\", \"~이 될 것이라는 예상이 듭니다\"",
  "짧은 리듬 문장 — \"바로 어제죠.\", \"무려 코미디 장르입니다.\"",
  "맥락 재료 — 전작 케미·흥행, 원고 이후 새 전개 묘사",
];

export type PairSample = { label: string; category: string; diff: SentenceDiff };
export type PureSample = { label: string; sentences: string[] };

export type TypeFinding = { type: string; count: number; examples: string[]; cause: { file: string; section: string } | null };
export type Proposal = { file: string; section: string; rationale: string; before: string; after: string };
export type Classification = {
  summary: string;
  removedTypes: TypeFinding[];
  addedTypes: TypeFinding[];
  proposals: Proposal[];
};

const clip = (s: string, n = 220) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** 쌍들을 돌아가며 한 문장씩 뽑아 전체 상한을 지킨다(한 글이 샘플을 독점하지 않게). */
export function sampleRoundRobin<T>(lists: T[][], cap: number): T[] {
  const out: T[] = [];
  for (let round = 0; out.length < cap; round += 1) {
    let any = false;
    for (const list of lists) {
      if (round < list.length) {
        any = true;
        out.push(list[round] as T);
        if (out.length >= cap) break;
      }
    }
    if (!any) break;
  }
  return out;
}

export async function loadSpecs(root: string, categories: string[]): Promise<Record<string, string>> {
  const files: string[] = [SPEC_FILES.core, SPEC_FILES.voice];
  if (categories.some((c) => c === "person")) files.push(SPEC_FILES.person);
  if (categories.some((c) => c !== "person")) files.push(SPEC_FILES.entertainment);
  const out: Record<string, string> = {};
  for (const f of files) out[f] = await readFile(join(root, f), "utf8");
  return out;
}

export function buildClassifyPrompt(pairs: PairSample[], pure: PureSample[], specs: Record<string, string>): string {
  const removed = sampleRoundRobin(pairs.map((p) => p.diff.removed), 70);
  const added = sampleRoundRobin(pairs.map((p) => p.diff.added), 70);
  const rewritten = sampleRoundRobin(pairs.map((p) => p.diff.rewritten), 40);
  const pureLines = pure.flatMap((p) => p.sentences.slice(0, 4));
  const specBlock = Object.entries(specs)
    .map(([file, body]) => `### 파일: ${file}\n\`\`\`\n${body}\n\`\`\``)
    .join("\n\n");
  return [
    "당신은 한국어 블로그 집필 규격 편집자입니다. 아래는 파이프라인이 쓴 원고와, 블로그 운영자가 네이버에 직접 윤문해 발행한 글을 문장 단위로 대조한 결과입니다.",
    "운영자의 윤문 전후 차이가 곧 '원하는 문체'입니다. 지운 문장·보탠 문장의 유형을 분류하고, 현행 집필 규격 중 어느 절이 그 원인인지 찾아 규격 개정안을 제안하세요.",
    "",
    "## 규칙",
    "- 근거 없는 일반론 금지. 아래 샘플에서 2회 이상 반복되거나 여러 글에 걸친 경향만 유형으로 인정합니다.",
    "- 개정안은 최대 4건, 작고 점진적으로. before는 현행 파일에서 **글자 그대로** 복사한 문구(검증에 쓰입니다), after는 교체 문구입니다. 새 문구를 더하는 경우 before는 그 앞 기준 문장 하나를 그대로 쓰고 after에 기준 문장+추가 문구를 적습니다.",
    "- 이미 완화된 규격을 되돌리는 제안, 사실 단정·수치 근거 규칙(core-rules의 사실 규칙)을 약화시키는 제안, 사회(incident) 트랙의 무죄추정·신원보호 규칙을 건드리는 제안은 하지 않습니다.",
    "- 표본이 적거나(쌍 3건 미만) 증거가 약하면 proposals를 비워도 됩니다. 억지로 채우지 마세요.",
    "- 규격 파일은 수정하지 않습니다. 제안만 JSON으로 답합니다.",
    "",
    "## 참고: 2026-10-16 수동 대조(7쌍)에서 확인된, 사용자가 보태는 문장 유형 4가지 (새 유형을 막지 않음)",
    ...KNOWN_ADDED_TYPES.map((t) => `- ${t}`),
    "",
    `## 대조 대상 (쌍 ${pairs.length}건: ${pairs.map((p) => `${p.label}[${p.category}]`).join(", ")})`,
    "",
    `### 사용자가 지운 문장 (원고에 있고 발행본에 없음, ${removed.length}건 샘플)`,
    ...removed.map((s, i) => `${i + 1}. ${clip(s)}`),
    "",
    `### 사용자가 보탠 문장 (발행본에만 있음, ${added.length}건 샘플)`,
    ...added.map((s, i) => `${i + 1}. ${clip(s)}`),
    "",
    `### 사용자가 고쳐 쓴 문장 (원고 → 발행본, ${rewritten.length}건 샘플)`,
    ...rewritten.map((r, i) => `${i + 1}. [${r.similarity}] ${clip(r.before, 160)}\n   → ${clip(r.after, 160)}`),
    "",
    ...(pureLines.length > 0 ? ["### 사용자 순수작 문체 샘플 (짝 없는 직접 작성글에서 발췌)", ...pureLines.map((s, i) => `${i + 1}. ${clip(s)}`), ""] : []),
    "## 현행 집필 규격 (읽기 전용)",
    specBlock,
    "",
    "## 출력 형식 (JSON 하나만, 앞뒤 설명·코드펜스 금지)",
    '{"summary":"3줄 이내 한국어 요약","removedTypes":[{"type":"유형명","count":정수,"examples":["샘플 문장 최대 2개"],"cause":{"file":"파일 경로","section":"절 이름"}|null}],"addedTypes":[같은 형식],"proposals":[{"file":"파일 경로","section":"절 이름","rationale":"근거 1~2문장","before":"현행 문구(글자 그대로)","after":"교체 문구"}]}',
  ].join("\n");
}

function asArray(x: unknown): unknown[] {
  return Array.isArray(x) ? x : [];
}
const str = (x: unknown) => (typeof x === "string" ? x : "");

function toFindings(x: unknown): TypeFinding[] {
  return asArray(x).flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const o = raw as Record<string, unknown>;
    const c = o.cause && typeof o.cause === "object" ? (o.cause as Record<string, unknown>) : null;
    const type = str(o.type);
    if (!type) return [];
    return [{
      type,
      count: typeof o.count === "number" ? o.count : 0,
      examples: asArray(o.examples).map(str).filter(Boolean).slice(0, 3),
      cause: c && str(c.file) ? { file: str(c.file), section: str(c.section) } : null,
    }];
  });
}

/** CLI 출력 -> Classification. JSON을 못 읽으면 null. */
export function parseClassification(output: string): Classification | null {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(output.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const proposals = asArray(o.proposals).flatMap((raw): Proposal[] => {
    if (!raw || typeof raw !== "object") return [];
    const p = raw as Record<string, unknown>;
    if (!str(p.file) || !str(p.after)) return [];
    return [{ file: str(p.file), section: str(p.section), rationale: str(p.rationale), before: str(p.before), after: str(p.after) }];
  });
  return { summary: str(o.summary), removedTypes: toFindings(o.removedTypes), addedTypes: toFindings(o.addedTypes), proposals: proposals.slice(0, 4) };
}

/** before 문구가 현행 규격 파일에 그대로 있는지(모델이 문구를 지어내지 않았는지) 확인한다. */
export function verifyProposalAnchors(proposals: Proposal[], specs: Record<string, string>): Array<Proposal & { anchorFound: boolean }> {
  return proposals.map((p) => {
    const body = specs[p.file];
    return { ...p, anchorFound: p.before.trim().length > 0 && body !== undefined && body.includes(p.before.trim()) };
  });
}

export type ClassifyOutcome = { ok: true; classification: Classification; durationMs: number } | { ok: false; error: string };

export async function classifyWithClaude(
  prompt: string,
  run: (opts: { prompt: string; timeoutMs: number }) => Promise<RunHeadlessClaudeResult> = runHeadlessClaude
): Promise<ClassifyOutcome> {
  const res = await run({ prompt, timeoutMs: 600_000 });
  if (!res.ok) return { ok: false, error: res.error };
  const classification = parseClassification(res.output);
  if (!classification) return { ok: false, error: `CLI 출력을 JSON으로 읽지 못했습니다: ${res.output.slice(0, 200)}` };
  return { ok: true, classification, durationMs: res.durationMs };
}
