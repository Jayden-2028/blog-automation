// 수정 요청이 요구한 **그 항목만** 좁혀 조사한다(2026-11-06). planRevisionResearch가 뽑은 목록이 곧 범위다.
//
// 재료 두 다리를 쓴다 - 둘 다 기존 조사 기계다:
//  ① 이미 받아 둔 인물 소스팩(`job.metadata.researchSourcePack`, collectPersonSourcePack이 맥에서 채운다).
//     네트워크를 쓰지 않는다. 인물 문서의 **출연 목록 표**(personWorkCast.parseFilmographyRows)와 대표작
//     `등장인물` 발췌(workCasts)가 그대로 재료다 - 신민아 사례의 "마들렌·달콤한 인생"은 여기 이미 있다.
//     왜 나무위키를 지금 다시 받지 않는가: 이 단계는 GitHub Actions 러너에서 돈다(job-revise.yml) -
//     클라우드 IP에서 namu.wiki·search.naver.com 인물 검색은 403이다(personSourcePack.ts 머리글 실측).
//     받아 둔 팩을 쓰는 것이 같은 출처를 쓰면서 러너에서 실제로 되는 유일한 길이다.
//  ② 좁힌 조사 에이전트 1콜(WebSearch/WebFetch). 본 조사와 같은 경로·같은 도구이고, 프롬프트만
//     "이 항목만, 이 주제 안에서"로 묶는다.
//
// 드리프트 방지: 모든 질의에 글의 주제(keyword)를 붙이고, 항목 밖 내용은 출력 형식으로 받지 않으며,
// 못 찾은 항목은 **못 찾았다고 적게** 한다(지어내기보다 빠뜨리는 쪽이 맞다 - 인물 실명 글 원칙).

import { classifySourceAuthority } from "../../config/sourceAuthorityRules.js";
import { PIPELINE_ROOT } from "../../config/pipelinePaths.js";
import { runHeadlessClaude } from "../../services/llm/runHeadlessClaude.js";
import { parseFilmographyRows } from "./personWorkCast.js";
import type { PersonSourcePack } from "./personSourcePack.js";
import type { RunHeadlessClaudeResult } from "../../services/llm/runHeadlessClaude.js";
import type { SourceAuthorityLevel, SourceInsert } from "../../types/database.js";

/**
 * 보충 조사 자체의 상한. 본 조사(18분)보다 짧게 둔다 - 항목 몇 개짜리 좁은 조사이고, 뒤에 재작성
 * 20분이 남아 있어야 한다(job-revise.yml 러너 상한 45분: 판정 3 + 조사 8 + 재작성 20).
 */
export const SUPPLEMENTAL_RESEARCH_TIMEOUT_MS = 8 * 60 * 1000;

export const SUPPLEMENT_MARKERS = {
  found: "### FOUND",
  item: "#### ",
  sources: "### SOURCES",
  missing: "### MISSING",
} as const;

const AUTHORITY_LEVELS: readonly SourceAuthorityLevel[] = ["official", "medical", "news", "community"];

export type SupplementFinding = {
  /** planRevisionResearch가 뽑은 항목 그대로. */
  item: string;
  /** 그 항목에 관해 확인된 사실(마크다운 몇 줄). */
  body: string;
};

export type SupplementMissing = {
  item: string;
  /** 왜 못 찾았는지. 사용자 알림에 그대로 나간다. */
  reason: string;
};

export type SupplementSource = {
  title: string;
  url: string;
  authority: SourceAuthorityLevel;
  publishedAt: string | null;
};

export type CollectSupplementalResearchResult = {
  /** 팩에서 바로 나온 재료(네트워크 없음). 조사 기록에 "소스팩" 출처로 적는다. */
  packFindings: SupplementFinding[];
  /** 에이전트가 조사한 재료. */
  agentFindings: SupplementFinding[];
  missing: SupplementMissing[];
  sources: SupplementSource[];
  /** 에이전트 호출 자체가 실패한 사유. 이때 agentFindings는 비어 있다. */
  agentError?: string;
};

/** 기존 조사 자료에 그 항목이 이미 있는지 거칠게 본다(항목 문자열이 그대로 나오는가). */
export function researchTextCovers(researchText: string | null, item: string): boolean {
  if (!researchText) return false;
  const needle = item.replace(/[(（].*$/, "").trim();
  return needle.length > 1 && researchText.includes(needle);
}

/**
 * 받아 둔 인물 소스팩에서 그 항목에 해당하는 재료를 떠낸다. 네트워크·LLM 없음.
 *
 * 항목이 작품명이면 출연 목록 표의 그 행(작품·배역·비중·시청률)과, 팩에 이미 있는 그 작품의
 * `등장인물` 발췌를 묶어 돌려준다. 못 찾으면 null - 그 항목은 에이전트 다리로 넘어간다.
 */
export function findInPersonPack(item: string, pack: PersonSourcePack | null): SupplementFinding | null {
  if (!pack) return null;
  // 항목에 괄호 수식("마들렌(2003년 영화)")이 붙어 와도 작품명으로 맞춘다.
  const needle = item.replace(/[(（].*$/, "").trim();
  if (needle.length < 2) return null;

  const rows = pack.namuwiki ? parseFilmographyRows(pack.namuwiki) : [];
  const row = rows.find((pick) => pick.work === needle) ?? rows.find((pick) => pick.work.includes(needle));
  const cast = (pack.workCasts ?? []).find((c) => c.work === needle || c.work.includes(needle));
  if (!row && !cast) return null;

  const lines: string[] = [];
  if (row) {
    const bits = [`배역 ${row.role}`];
    if (row.weight) bits.push(row.weight);
    if (row.rating !== undefined) bits.push(`시청률 ${row.rating}%`);
    lines.push(`- 출연 목록(나무위키 인물 문서): ${row.work} — ${bits.join(" · ")}`);
  }
  if (cast) {
    lines.push(`- 등장인물 발췌(${cast.namuwikiTitle}, 배역 ${cast.role}):`);
    lines.push(cast.excerpt.trim());
  }
  return { item, body: lines.join("\n") };
}

export type CollectSupplementalResearchInput = {
  keyword: string;
  category: string | null;
  originalTitle: string;
  /** planRevisionResearch가 뽑은 항목. 이것이 조사 범위의 전부다. */
  items: string[];
  /** job.metadata.researchSourcePack(인물 트랙). 없으면 ① 다리를 건너뛴다. */
  sourcePack?: PersonSourcePack | null;
  /** 이미 조사 자료에 있는 항목은 에이전트에게 다시 묻지 않는다. */
  researchText?: string | null;
  /** 테스트 주입 지점. 기본은 runHeadlessClaude(WebSearch/WebFetch 허용 - 본 조사와 같은 경로). */
  runAgent?: (prompt: string) => Promise<RunHeadlessClaudeResult>;
};

/** `| 제목 | URL | 등급 | 날짜 |` 표 한 줄을 출처로 읽는다. URL이 없으면 버린다(감사 기록이 안 된다). */
function parseSourceRow(line: string): SupplementSource | null {
  const cells = line.split("|").map((cell) => cell.trim());
  const body = cells[0] === "" ? cells.slice(1) : cells;
  const [title, url, authority, publishedAt] = body;
  if (!url || !/^https?:\/\//.test(url)) return null;
  const declared = (authority ?? "").toLowerCase() as SourceAuthorityLevel;
  return {
    title: title || url,
    url,
    authority: AUTHORITY_LEVELS.includes(declared) ? declared : classifySourceAuthority({ url, searchSource: "naver_web" }),
    publishedAt: publishedAt && !/^[-–—]*$/.test(publishedAt) ? publishedAt : null,
  };
}

/** 에이전트 출력(마커 형식)을 항목별 재료·출처·못 찾음으로 가른다. 순수 함수. */
export function parseSupplementalOutput(raw: string): {
  findings: SupplementFinding[];
  sources: SupplementSource[];
  missing: SupplementMissing[];
} {
  const findings: SupplementFinding[] = [];
  const sources: SupplementSource[] = [];
  const missing: SupplementMissing[] = [];

  let section: "none" | "found" | "sources" | "missing" = "none";
  let current: SupplementFinding | null = null;
  const pushCurrent = () => {
    if (current && current.body.trim()) findings.push({ item: current.item, body: current.body.trim() });
    current = null;
  };

  for (const line of raw.split("\n")) {
    const text = line.trim();
    if (text.startsWith(SUPPLEMENT_MARKERS.found)) {
      pushCurrent();
      section = "found";
      continue;
    }
    if (text.startsWith(SUPPLEMENT_MARKERS.sources)) {
      pushCurrent();
      section = "sources";
      continue;
    }
    if (text.startsWith(SUPPLEMENT_MARKERS.missing)) {
      pushCurrent();
      section = "missing";
      continue;
    }
    if (section === "found") {
      if (text.startsWith(SUPPLEMENT_MARKERS.item)) {
        pushCurrent();
        current = { item: text.slice(SUPPLEMENT_MARKERS.item.length).trim(), body: "" };
        continue;
      }
      if (current) current.body += `${line}\n`;
      continue;
    }
    if (section === "sources") {
      if (!text.includes("|")) continue;
      // 표 머리글·구분선은 버린다.
      if (/^\|?\s*(제목|title)\s*\|/i.test(text)) continue;
      if (/^\|?[\s:|-]+\|?$/.test(text)) continue;
      const parsed = parseSourceRow(text);
      if (parsed) sources.push(parsed);
      continue;
    }
    if (section === "missing") {
      if (!text) continue;
      const item = text.replace(/^[-*•]\s*/, "").trim();
      if (!item) continue;
      const colon = item.indexOf(":");
      missing.push(
        colon > 0
          ? { item: item.slice(0, colon).trim(), reason: item.slice(colon + 1).trim() || "사유 없음" }
          : { item, reason: "신뢰할 출처를 찾지 못했다" }
      );
    }
  }
  pushCurrent();
  return { findings, sources, missing };
}

function buildAgentPrompt(input: CollectSupplementalResearchInput, items: string[]): string {
  const M = SUPPLEMENT_MARKERS;
  return [
    `당신은 이미 쓴 블로그 원고에 **문단 몇 개를 더하기 위한 보충 자료**를 조사한다. 원고를 쓰지 않는다.`,
    ``,
    `## 범위 (이 밖으로 나가지 않는다)`,
    `- 글의 주제: ${input.keyword}${input.originalTitle ? ` / 제목 "${input.originalTitle}"` : ""}`,
    `- 조사할 항목은 아래 목록이 전부다. 목록에 없는 주제·인물·사건은 조사하지도, 적지도 않는다.`,
    `- 모든 검색 질의에 주제("${input.keyword}")를 함께 넣는다 - 같은 이름의 다른 대상을 집지 않기 위해서다.`,
    `- 이 조사는 기존 글에 문단을 더하기 위한 것이다. 글의 주제를 바꾸거나 넓히는 자료는 버린다.`,
    ``,
    `## 조사 항목`,
    ...items.map((item, i) => `${i + 1}. ${item}`),
    ``,
    `## 사실 규칙`,
    `- 출처로 확인한 것만 적는다. 추측·요약된 통설·기억으로 적지 않는다.`,
    `- 항목마다 **출처 URL을 반드시** 남긴다. URL 없는 사실은 적지 않는다(조사 기록이 감사 기록이다).`,
    `- 확인이 안 되는 항목은 ${M.missing}에 사유와 함께 적는다. **지어내지 않는다** - 실명 인물 글에서`,
    `  근거 없는 서술은 빠뜨리는 것보다 나쁘다.`,
    ``,
    `## 출력 형식 (아래 마커를 정확히 그대로, 순서대로)`,
    M.found,
    `${M.item}<항목 이름(조사 항목과 같은 표기)>`,
    `- 확인한 사실 한 줄`,
    `- 확인한 사실 한 줄 (각 줄 끝에 근거 URL)`,
    M.sources,
    `| 제목 | URL | 등급(official/medical/news/community) | 발행일(YYYY-MM-DD, 모르면 -) |`,
    M.missing,
    `- <항목>: 못 찾은 사유`,
    `(없으면 ${M.missing} 아래를 비워 둔다)`,
  ].join("\n");
}

/**
 * 항목을 좁혀 보충 조사한다. 예외를 던지지 않는다 - 실패는 `agentError`·`missing`으로 돌려주고
 * 호출부가 "일부만 넣고 나머지는 알린다"로 처리한다.
 */
export async function collectSupplementalResearch(
  input: CollectSupplementalResearchInput
): Promise<CollectSupplementalResearchResult> {
  const packFindings: SupplementFinding[] = [];
  const forAgent: string[] = [];

  for (const item of input.items) {
    const fromPack = findInPersonPack(item, input.sourcePack ?? null);
    if (fromPack) {
      packFindings.push(fromPack);
      continue;
    }
    // 조사 자료에 이미 있으면 다시 조사하지 않는다 - 재작성이 그 자료를 사실 출처로 쓴다.
    if (researchTextCovers(input.researchText ?? null, item)) continue;
    forAgent.push(item);
  }

  if (forAgent.length === 0) {
    return { packFindings, agentFindings: [], missing: [], sources: [] };
  }

  const runAgent =
    input.runAgent ??
    ((prompt: string) =>
      runHeadlessClaude({
        prompt,
        allowedTools: ["WebSearch", "WebFetch"],
        permissionMode: "acceptEdits",
        cwd: PIPELINE_ROOT,
        timeoutMs: SUPPLEMENTAL_RESEARCH_TIMEOUT_MS,
      }));

  const result = await runAgent(buildAgentPrompt(input, forAgent));
  if (!result.ok) {
    return {
      packFindings,
      agentFindings: [],
      sources: [],
      missing: forAgent.map((item) => ({ item, reason: `보충 조사 실패: ${result.error}` })),
      agentError: result.error,
    };
  }

  const parsed = parseSupplementalOutput(result.output);
  // 범위 가드(코드): 뽑힌 항목 밖의 재료는 버린다. 모델이 "덤으로" 다른 주제를 물어 와도 원고에 닿지 않는다.
  const allowed = new Set(forAgent.map((item) => item.toLowerCase()));
  const matchesItem = (name: string): string | null => {
    const lower = name.toLowerCase();
    if (allowed.has(lower)) return forAgent.find((item) => item.toLowerCase() === lower) ?? null;
    return forAgent.find((item) => lower.includes(item.toLowerCase()) || item.toLowerCase().includes(lower)) ?? null;
  };

  const agentFindings: SupplementFinding[] = [];
  for (const finding of parsed.findings) {
    const item = matchesItem(finding.item);
    if (!item) continue;
    agentFindings.push({ item, body: finding.body });
  }

  const found = new Set(agentFindings.map((f) => f.item));
  const missing: SupplementMissing[] = [];
  const seenMissing = new Set<string>();
  for (const entry of parsed.missing) {
    const item = matchesItem(entry.item);
    if (!item || found.has(item) || seenMissing.has(item)) continue;
    seenMissing.add(item);
    missing.push({ item, reason: entry.reason });
  }
  // 에이전트가 찾지도, 못 찾았다고 적지도 않은 항목은 "못 찾음"으로 본다 - 조용히 빠지면 안 된다.
  for (const item of forAgent) {
    if (found.has(item) || seenMissing.has(item)) continue;
    missing.push({ item, reason: "조사 결과에 나오지 않았다" });
  }

  return { packFindings, agentFindings, missing, sources: parsed.sources };
}

/** 보충 조사 결과를 sources 행으로 바꾼다. 출처 추적이 원 조사와 같은 표에서 이어진다. */
export function toSupplementSourceInserts(jobId: string, sources: readonly SupplementSource[]): SourceInsert[] {
  const seen = new Set<string>();
  const rows: SourceInsert[] = [];
  for (const source of sources) {
    if (seen.has(source.url)) continue;
    seen.add(source.url);
    rows.push({
      job_id: jobId,
      title: source.title,
      url: source.url,
      // 원 조사의 "researcher"와 구분한다 - 어느 단계에서 들어온 출처인지 나중에 가릴 수 있어야 한다.
      source_name: "revise-researcher",
      authority: source.authority,
      published_at: coerceDate(source.publishedAt),
      content: null,
    });
  }
  return rows;
}

/** published_at은 timestamptz다 - 파싱 가능한 날짜만 남기고 자유 텍스트는 버린다(원문 표기는 조사 기록에 남는다). */
function coerceDate(value: string | null): string | null {
  if (!value) return null;
  const m = value.match(/(\d{4})\D{1,3}(\d{1,2})\D{1,3}(\d{1,2})/);
  if (!m) return null;
  const [, y, mo, d] = m;
  const iso = `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  return Number.isNaN(Date.parse(iso)) ? null : new Date(`${iso}T00:00:00Z`).toISOString();
}
