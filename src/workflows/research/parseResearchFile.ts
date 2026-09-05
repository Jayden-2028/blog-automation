// researcher.md §7 규격으로 쓰인 research/[키워드].md를 파싱한다.
//
// 정본은 여전히 DB(sources 테이블)다 - 이 파서는 (a) frontmatter의 verdict/source_counts를 읽고,
// (b) §10 전체 출처 목록에서 baseline(NAVER API 수집)에 없던 에이전트 인용 출처를 뽑아 sources에
// 추가하고(감사기록 유지), (c) §1 요약 / §4 통설을 체크포인트 알림 텍스트로 옮긴다.
//
// YAML 라이브러리를 안 쓰는 이유: 의존성이 dotenv/supabase/playwright/node-html-parser뿐이고,
// frontmatter가 얕은 구조(스칼라 + source_counts 1단 중첩)라 줄 파서로 충분하다.

import type { SourceAuthorityLevel } from "../../types/database.js";

const AUTHORITY_VALUES: readonly SourceAuthorityLevel[] = ["official", "medical", "news", "community"];

export type ResearchVerdict = "ok" | "thin" | "blocked";

export type ResearchSourceRow = {
  rank: number | null;
  authority: SourceAuthorityLevel | null;
  title: string | null;
  url: string | null;
  publishedAt: string | null;
};

export type ParsedResearchFile = {
  keyword: string | null;
  topic: string | null;
  researchedAt: string | null;
  verdict: ResearchVerdict;
  sourceCounts: Record<SourceAuthorityLevel, number>;
  /** §1 요약 본문(마크다운 헤더 제외, 일반 텍스트). */
  summary: string;
  /** §4 확인되지 않은 통설 항목(불릿 텍스트). 알림에서 "커뮤니티만 확인" 경고로 쓴다. */
  unverifiedClaims: string[];
  /** §10 전체 출처 목록 표. */
  sourceTable: ResearchSourceRow[];
};

function emptyCounts(): Record<SourceAuthorityLevel, number> {
  return { official: 0, medical: 0, news: 0, community: 0 };
}

function coerceVerdict(value: string | undefined): ResearchVerdict {
  const v = (value ?? "").trim().toLowerCase();
  return v === "ok" || v === "thin" || v === "blocked" ? v : "thin";
}

function coerceAuthority(value: string | undefined): SourceAuthorityLevel | null {
  const v = (value ?? "").trim().toLowerCase().replace(/[`[\]]/g, "");
  return AUTHORITY_VALUES.includes(v as SourceAuthorityLevel) ? (v as SourceAuthorityLevel) : null;
}

/** `---` 프론트매터 블록과 본문을 분리한다. 프론트매터가 없으면 frontmatter는 빈 문자열. */
function splitFrontmatter(text: string): { frontmatter: string; body: string } {
  const match = text.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { frontmatter: "", body: text };
  return { frontmatter: match[1], body: text.slice(match[0].length) };
}

function parseFrontmatter(fm: string): {
  keyword: string | null;
  topic: string | null;
  researchedAt: string | null;
  verdict: ResearchVerdict;
  sourceCounts: Record<SourceAuthorityLevel, number>;
} {
  const lines = fm.split(/\r?\n/);
  const scalars: Record<string, string> = {};
  const counts = emptyCounts();
  let inCounts = false;

  for (const line of lines) {
    if (/^\s*#/.test(line) || line.trim() === "") continue;

    // source_counts: 아래 들여쓴 줄들
    if (/^source_counts\s*:/.test(line)) {
      inCounts = true;
      continue;
    }
    if (inCounts && /^\s+\S/.test(line)) {
      const m = line.match(/^\s+([A-Za-z_]+)\s*:\s*(\d+)/);
      if (m) {
        const key = m[1].toLowerCase();
        if ((AUTHORITY_VALUES as readonly string[]).includes(key)) {
          counts[key as SourceAuthorityLevel] = Number.parseInt(m[2], 10);
        }
        continue;
      }
    }
    inCounts = false;

    const m = line.match(/^([A-Za-z_]+)\s*:\s*(.*)$/);
    if (m) {
      // researcher.md §7 템플릿 자체가 `verdict: ok        # ok | thin | blocked`처럼 인라인
      // 주석을 예시로 보여준다 - 에이전트가 그 형태를 그대로 남기면 값에 주석까지 섞여
      // coerceVerdict가 "ok # ..."를 못 알아보고 기본값(thin)으로 떨어진다(2026-09-03 실측 발견).
      const withoutComment = m[2].replace(/\s+#.*$/, "");
      scalars[m[1].toLowerCase()] = withoutComment.trim().replace(/^["']|["']$/g, "");
    }
  }

  return {
    keyword: scalars.keyword || null,
    topic: scalars.topic || null,
    researchedAt: scalars.researched_at || null,
    verdict: coerceVerdict(scalars.verdict),
    sourceCounts: counts,
  };
}

/** "## N. 제목" 헤더로 섹션을 나눠, 헤더 텍스트에 keyword가 포함된 첫 섹션의 본문을 돌려준다. */
function sectionBody(body: string, keywords: string[]): string {
  const parts = body.split(/^##\s+/m);
  for (const part of parts) {
    const firstLine = part.split(/\r?\n/, 1)[0] ?? "";
    if (keywords.some((k) => firstLine.includes(k))) {
      return part.slice(firstLine.length).trim();
    }
  }
  return "";
}

function parseSourceTable(body: string): ResearchSourceRow[] {
  const section = sectionBody(body, ["전체 출처 목록", "출처 목록"]);
  const rows: ResearchSourceRow[] = [];
  for (const line of section.split(/\r?\n/)) {
    if (!line.trim().startsWith("|")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length < 4) continue;
    // 헤더 행 / 구분선 행 건너뛰기
    if (/^#$|^번호$|^등급$/.test(cells[0]) || /^-+$/.test(cells[0].replace(/[:\s]/g, ""))) continue;

    const rank = Number.parseInt(cells[0], 10);
    const urlCell = cells[3] ?? "";
    const urlMatch = urlCell.match(/https?:\/\/[^\s)|\]]+/);
    rows.push({
      rank: Number.isNaN(rank) ? null : rank,
      authority: coerceAuthority(cells[1]),
      title: cells[2] || null,
      url: urlMatch ? urlMatch[0] : urlCell || null,
      publishedAt: cells[4]?.trim() || null,
    });
  }
  return rows;
}

function parseUnverifiedClaims(body: string): string[] {
  const section = sectionBody(body, ["확인되지 않은 통설", "확인되지않은 통설"]);
  return section
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- ") || l.startsWith("* "))
    .map((l) => l.replace(/^[-*]\s+/, "").trim())
    .filter(Boolean);
}

export function parseResearchFile(text: string): ParsedResearchFile {
  const { frontmatter, body } = splitFrontmatter(text);
  const fm = parseFrontmatter(frontmatter);
  const summary = sectionBody(body, ["요약"]) || body.trim().slice(0, 600);

  return {
    keyword: fm.keyword,
    topic: fm.topic,
    researchedAt: fm.researchedAt,
    verdict: fm.verdict,
    sourceCounts: fm.sourceCounts,
    summary: summary.replace(/^\(.*\)$/gm, "").trim(),
    unverifiedClaims: parseUnverifiedClaims(body),
    sourceTable: parseSourceTable(body),
  };
}
