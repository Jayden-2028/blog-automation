// Gemini 자료조사 결과에서 official/medical로 표기된 항목이 실제로 grounding된 URL을 쓰고
// 있는지 코드로 강제 검증한다.
//
// 왜 필요한가(2026-09-03 실측, docs/ai-handoff/CURRENT_STATE.md): "2026년 추석 연휴 기간"
// job에서 Gemini가 §2 "확인된 사실"(official 등급, 단정 서술 가능)에 `https://www.msit.go.kr`,
// `https://www.law.go.kr`처럼 특정 게시물 경로 없는 최상위 도메인을 붙이고 거기에 구체적인
// "원문 근거" 인용문까지 달아놨다. 실제 Gemini grounding API가 돌려주는 진짜 근거 URL은 전부
// `vertexaisearch.cloud.google.com/grounding-api-redirect/...` 형태인데(별도 확인 완료), 저
// URL들은 그 형태가 아니었다 - grounding되지 않은, 모델이 기억으로 채운 URL로 보인다.
// 프롬프트로 "URL을 지어내지 마라"고 요청하는 것만으로는 못 막았으니(researcher.md §2에도 이미
// 있는 규칙이다) 코드로 막는다: runGeminiResearch가 돌려주는 groundingChunks + baseline URL만
// "실제로 grounding된 URL"로 인정하고, 그 목록에 없는 URL로 된 official/medical 항목은 전부
// community로 강등한다.
//
// 강등 대상 두 곳:
//   1) §2/§3 본문의 "- [official] ..." 불릿 - writer가 이 태그로 서술 강도를 정한다
//      (researcher.md §3: official/medical은 단정 서술, community는 "~라고 알려져 있다").
//   2) §10 전체 출처 목록 표 - Node가 이 표를 그대로 sources DB에 반영한다(runArticleJob.ts).
// 강등이 일어나면 frontmatter의 verdict/source_counts도 §7 공식대로 재계산해 다시 쓴다 - 안
// 그러면 강등 전(부풀려진) 개수로 계산된 verdict: ok가 강등 사실과 모순된 채로 남는다.

import type { SourceAuthorityLevel } from "../../types/database.js";

export type GroundingEnforcementResult = {
  text: string;
  /** official/medical -> community로 강등된 항목 수(§2/§3 불릿 + §10 표 행 합계). */
  downgradedCount: number;
  recomputedVerdict: "ok" | "thin" | "blocked";
  recomputedSourceCounts: Record<SourceAuthorityLevel, number>;
};

const URL_PATTERN = /https?:\/\/[^\s)|\]]+/g;

function normalizeUrl(url: string): string {
  return url.replace(/[),.]+$/, "").replace(/\/$/, "");
}

function extractUrls(text: string): string[] {
  return (text.match(URL_PATTERN) ?? []).map(normalizeUrl);
}

function extractFrontmatterScalar(frontmatter: string, key: string): string {
  const m = frontmatter.match(new RegExp(`^${key}\\s*:\\s*(.*)$`, "m"));
  if (!m) return "";
  return m[1].replace(/\s+#.*$/, "").trim().replace(/^["']|["']$/g, "");
}

/**
 * §2/§3/§4의 "- [official] ..." / "- [medical] ..." 불릿 블록을 찾아, 블록 안 어디에도 허용된
 * URL이 없으면 태그를 community로 바꾸고 강등 표시를 붙인다. 블록 경계는 다음 "- [" 불릿이나
 * "## " 헤더 직전까지다.
 */
function downgradeBullets(lines: string[], isAllowed: (url: string) => boolean): { lines: string[]; downgraded: number } {
  const out = [...lines];
  let downgraded = 0;
  let i = 0;
  while (i < out.length) {
    const bulletMatch = out[i].match(/^-\s*\[(official|medical)\]/);
    if (!bulletMatch) {
      i++;
      continue;
    }

    let end = i + 1;
    while (end < out.length && !/^-\s*\[/.test(out[end]) && !/^##\s/.test(out[end])) end++;

    const blockUrls = out.slice(i, end).flatMap(extractUrls);
    const hasAllowedUrl = blockUrls.some(isAllowed);

    if (!hasAllowedUrl) {
      out[i] = out[i].replace(/\[(official|medical)\]/, "[community]") + " *(⚠️ grounding 미확인 - 자동 community 강등)*";
      downgraded++;
    }
    i = end;
  }
  return { lines: out, downgraded };
}

/** "| # | 등급 | 제목 | URL | 발행일 |" 표 행 중 official/medical이면서 URL이 미확인이면 강등한다. */
function downgradeSourceTable(lines: string[], isAllowed: (url: string) => boolean): { lines: string[]; downgraded: number } {
  const out = [...lines];
  let downgraded = 0;
  for (let i = 0; i < out.length; i++) {
    if (!out[i].trim().startsWith("|")) continue;
    const cells = out[i].split("|");
    if (cells.length < 6) continue;

    const authority = cells[2]?.trim().toLowerCase();
    if (authority !== "official" && authority !== "medical") continue;

    const urls = extractUrls(cells[4] ?? "");
    if (urls.some(isAllowed)) continue;

    cells[2] = cells[2].replace(new RegExp(authority, "i"), "community");
    out[i] = cells.join("|");
    downgraded++;
  }
  return { lines: out, downgraded };
}

/** 헤더/구분선 행을 건너뛰고 §10 표의 등급 열만 센다. */
function tallySourceTable(lines: string[]): Record<SourceAuthorityLevel, number> {
  const counts: Record<SourceAuthorityLevel, number> = { official: 0, medical: 0, news: 0, community: 0 };
  const valid: readonly string[] = ["official", "medical", "news", "community"];
  for (const line of lines) {
    if (!line.trim().startsWith("|")) continue;
    const cells = line.split("|");
    if (cells.length < 6) continue;
    const authority = cells[2]?.trim().toLowerCase();
    const titleCell = cells[3]?.trim() ?? "";
    if (/^-+$/.test(titleCell.replace(/:/g, ""))) continue; // 구분선 행(|---|---|...)
    if (valid.includes(authority)) counts[authority as SourceAuthorityLevel]++;
  }
  return counts;
}

/** researcher.md §7 verdict 판정 공식. */
function computeVerdict(counts: Record<SourceAuthorityLevel, number>): "ok" | "thin" | "blocked" {
  const total = counts.official + counts.medical + counts.news + counts.community;
  if (counts.official + counts.medical >= 2 && total >= 8) return "ok";
  if (counts.news >= 3) return "thin";
  if (total < 5 || counts.community === total) return "blocked";
  return "thin";
}

export function enforceGeminiGroundingUrls(
  text: string,
  allowedUrls: ReadonlySet<string>
): GroundingEnforcementResult {
  const normalizedAllowed = new Set([...allowedUrls].map(normalizeUrl));
  const isAllowed = (url: string): boolean => normalizedAllowed.has(url);

  const frontmatterMatch = text.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const frontmatter = frontmatterMatch ? frontmatterMatch[1] : "";
  const body = frontmatterMatch ? text.slice(frontmatterMatch[0].length) : text;

  const bulletPass = downgradeBullets(body.split(/\r?\n/), isAllowed);
  const tablePass = downgradeSourceTable(bulletPass.lines, isAllowed);
  const downgradedCount = bulletPass.downgraded + tablePass.downgraded;
  const newBody = tablePass.lines.join("\n");

  if (downgradedCount === 0) {
    return {
      text,
      downgradedCount: 0,
      recomputedVerdict: (extractFrontmatterScalar(frontmatter, "verdict") as "ok" | "thin" | "blocked") || "thin",
      recomputedSourceCounts: tallySourceTable(tablePass.lines),
    };
  }

  const recomputedSourceCounts = tallySourceTable(tablePass.lines);
  const recomputedVerdict = computeVerdict(recomputedSourceCounts);

  const keyword = extractFrontmatterScalar(frontmatter, "keyword");
  const topic = extractFrontmatterScalar(frontmatter, "topic");
  const researchedAt = extractFrontmatterScalar(frontmatter, "researched_at");

  const newFrontmatter = [
    "---",
    `keyword: ${keyword}`,
    topic ? `topic: ${topic}` : null,
    researchedAt ? `researched_at: ${researchedAt}` : null,
    "source_counts:",
    `  official: ${recomputedSourceCounts.official}`,
    `  medical: ${recomputedSourceCounts.medical}`,
    `  news: ${recomputedSourceCounts.news}`,
    `  community: ${recomputedSourceCounts.community}`,
    `verdict: ${recomputedVerdict}`,
    "---",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  return {
    text: `${newFrontmatter}\n${newBody}`,
    downgradedCount,
    recomputedVerdict,
    recomputedSourceCounts,
  };
}
