// 주간 보고서(마크다운) 렌더링. 순수 함수 - 입력 데이터만으로 문자열을 만든다.
import type { PairAnalysis } from "./analyze.js";
import type { Classification, Proposal } from "./classify.js";
import type { StyleMetrics } from "./metrics.js";
import { sumMetrics } from "./metrics.js";
import type { MatchScore } from "./match.js";

export type ReportPair = {
  logNo: string;
  link: string;
  category: string | null;
  publishedDate: string;
  articleId: number;
  articleCategory: string;
  score: MatchScore;
  analysis: PairAnalysis;
};
export type ReportPure = { logNo: string; link: string; title: string; publishedDate: string; metrics: StyleMetrics; best: MatchScore | null };

export type ReportInput = {
  label: string;
  days: number;
  generatedAt: string;
  listed: number;
  collected: number;
  threshold: number;
  pairs: ReportPair[];
  pure: ReportPure[];
  errors: string[];
  classification: Classification | null;
  classifyError: string | null;
  anchors: Array<Proposal & { anchorFound: boolean }>;
};

const pct = (x: number) => `${Math.round(x * 100)}%`;
const fx = (x: number) => (Math.round(x * 10) / 10).toString();
const signed = (x: number) => `${x >= 0 ? "+" : ""}${fx(x)}`;
const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

function endingsLine(e: Record<string, number>): string {
  const parts = Object.entries(e)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v}`);
  return parts.length > 0 ? parts.join(" · ") : "-";
}

function metricsTable(before: StyleMetrics, after: StyleMetrics): string[] {
  const row = (name: string, b: string, a: string, d: string) => `| ${name} | ${b} | ${a} | ${d} |`;
  return [
    "| 지표 | 원고 | 발행본 | 차이 |",
    "|---|---|---|---|",
    row("분량(공백 제외)", String(before.chars), String(after.chars), before.chars ? `${signed(((after.chars - before.chars) / before.chars) * 100)}%` : "-"),
    row("문장 수", String(before.sentences), String(after.sentences), signed(after.sentences - before.sentences)),
    row("평균 문장 길이(자)", fx(before.avgSentenceLen), fx(after.avgSentenceLen), signed(after.avgSentenceLen - before.avgSentenceLen)),
    row("합니다체 종결", pct(before.formalRatio), pct(after.formalRatio), `${signed((after.formalRatio - before.formalRatio) * 100)}%p`),
    row("해요체 종결", pct(before.politeRatio), pct(after.politeRatio), `${signed((after.politeRatio - before.politeRatio) * 100)}%p`),
    row("감탄문(!)", String(before.exclaims), String(after.exclaims), signed(after.exclaims - before.exclaims)),
    row("질문문(?)", String(before.questions), String(after.questions), signed(after.questions - before.questions)),
    row("어미", endingsLine(before.endings), endingsLine(after.endings), ""),
  ];
}

function diffBlock(p: Proposal & { anchorFound: boolean }): string[] {
  const minus = p.before ? p.before.split("\n").map((l) => `- ${l}`) : [];
  const plus = p.after.split("\n").map((l) => `+ ${l}`);
  const lines = [
    `#### ${p.file} — ${p.section || "(절 미지정)"}`,
    "",
    p.rationale ? `근거: ${p.rationale}` : "",
    p.anchorFound ? "현행 문구 일치: ✅" : "현행 문구 일치: ⚠️ 파일에서 그대로 찾지 못함 — 반영 전에 위치를 사람이 확인",
    "",
    "```diff",
    ...minus,
    ...plus,
    "```",
    "",
  ];
  return lines.filter((l, i) => !(l === "" && i === 2 && !p.rationale));
}

function typeSection(title: string, items: Classification["removedTypes"]): string[] {
  if (items.length === 0) return [`**${title}**: 없음`, ""];
  return [
    `**${title}**`,
    "",
    ...items.flatMap((t) => [
      `- ${t.type} (${t.count}회)${t.cause ? ` — 원인 후보: \`${t.cause.file}\` ${t.cause.section}` : ""}`,
      ...t.examples.map((e) => `  - "${clip(e, 140)}"`),
    ]),
    "",
  ];
}

export function renderReport(input: ReportInput): string {
  const { pairs, pure } = input;
  const total = { before: sumMetrics(pairs.map((p) => p.analysis.before)), after: sumMetrics(pairs.map((p) => p.analysis.after)) };
  const counts = pairs.reduce(
    (a, p) => ({
      removed: a.removed + p.analysis.diff.removed.length,
      added: a.added + p.analysis.diff.added.length,
      rewritten: a.rewritten + p.analysis.diff.rewritten.length,
      unchanged: a.unchanged + p.analysis.diff.unchanged,
    }),
    { removed: 0, added: 0, rewritten: 0, unchanged: 0 }
  );
  const titleChanged = pairs.filter((p) => p.analysis.titleChanged).length;
  const out: string[] = [
    `# 네이버 문체 학습 보고 ${input.label}`,
    "",
    `> 자동 생성(style-learn, ${input.generatedAt}). 대상 매체: 네이버 whyissuenow. **규격 파일은 수정하지 않았다** — 아래 제안은 사람이 보고 반영한다.`,
    "",
    "## 요약",
    "",
    `- 기간: 최근 ${input.days}일 · RSS 대상 ${input.listed}건 · 본문 수집 ${input.collected}건`,
    `- 원고와 짝지어진 글 **${pairs.length}건**, 짝 없는 글(사용자 순수작) **${pure.length}건** (매칭 임계 ${input.threshold})`,
    `- 문장 단위 변화(쌍 합계): 지운 ${counts.removed} · 보탠 ${counts.added} · 고쳐 쓴 ${counts.rewritten} · 그대로 ${counts.unchanged}`,
    `- 제목 재작성: ${titleChanged}/${pairs.length}건`,
    "",
  ];

  if (pairs.length > 0) {
    out.push("## 주간 합계 지표 (쌍 합계)", "", ...metricsTable(total.before, total.after), "");
    out.push(
      "## 쌍 목록",
      "",
      "| 발행일 | 발행본 | 원고 | 점수(제목·키워드·본문J·본문C) | 제목 변경 |",
      "|---|---|---|---|---|",
      ...pairs.map((p) => {
        const s = p.score;
        return `| ${p.publishedDate} | [${esc(clip(p.analysis.titleAfter, 34))}](${p.link}) | #${p.articleId} (${p.articleCategory}) ${esc(clip(p.analysis.titleBefore, 28))} | **${s.score.toFixed(2)}** (${s.titleDice.toFixed(2)}·${s.keywordHit.toFixed(2)}·${s.bodyJaccard.toFixed(2)}·${s.bodyContainment.toFixed(2)}) | ${p.analysis.titleChanged ? "예" : "아니오"} |`;
      }),
      ""
    );
    out.push("## 쌍별 상세", "");
    for (const p of pairs) {
      const a = p.analysis;
      out.push(
        `### ${p.publishedDate} · ${a.titleAfter}`,
        "",
        `- 원고 #${p.articleId} (${p.articleCategory}) / 발행본 [${p.logNo}](${p.link}) / 매칭 ${p.score.score.toFixed(2)}`,
        `- 제목: 원고 "${a.titleBefore}" → 발행 "${a.titleAfter}"`,
        "",
        ...metricsTable(a.before, a.after),
        "",
        `첫 문단 (유사도 ${a.firstParagraph.similarity})`,
        `- 원고: ${clip(a.firstParagraph.before, 260)}`,
        `- 발행: ${clip(a.firstParagraph.after, 260)}`,
        "",
        `마지막 문단 (유사도 ${a.lastParagraph.similarity})`,
        `- 원고: ${clip(a.lastParagraph.before, 260)}`,
        `- 발행: ${clip(a.lastParagraph.after, 260)}`,
        ""
      );
      const d = a.diff;
      out.push(`문장 diff — 지운 ${d.removed.length} · 보탠 ${d.added.length} · 고쳐 쓴 ${d.rewritten.length} · 그대로 ${d.unchanged}`, "", "<details><summary>샘플 보기</summary>", "");
      if (d.removed.length) out.push("지운 문장", ...d.removed.slice(0, 6).map((s) => `- ~~${clip(s, 200)}~~`), "");
      if (d.added.length) out.push("보탠 문장", ...d.added.slice(0, 8).map((s) => `- ${clip(s, 200)}`), "");
      if (d.rewritten.length) out.push("고쳐 쓴 문장", ...d.rewritten.slice(0, 5).flatMap((r) => [`- (${r.similarity}) ${clip(r.before, 140)}`, `  → ${clip(r.after, 140)}`]), "");
      out.push("</details>", "");
    }
  }

  out.push("## 사용자 순수작 (짝 없는 글 — 문체 샘플로만 사용)", "");
  if (pure.length === 0) out.push("없음", "");
  else {
    out.push(
      "| 발행일 | 제목 | 분량 | 합니다체 | 해요체 | 감탄/질문 | 최고 후보 점수 |",
      "|---|---|---|---|---|---|---|",
      ...pure.map(
        (p) =>
          `| ${p.publishedDate} | [${esc(clip(p.title, 36))}](${p.link}) | ${p.metrics.chars} | ${pct(p.metrics.formalRatio)} | ${pct(p.metrics.politeRatio)} | ${p.metrics.exclaims}/${p.metrics.questions} | ${p.best ? p.best.score.toFixed(2) : "-"} |`
      ),
      ""
    );
  }

  out.push("## 분류·규격 개정 제안 (Claude)", "");
  if (!input.classification) {
    out.push(`분류를 건너뛰었다${input.classifyError ? ` — ${input.classifyError}` : ""}. 위 지표·diff만으로 판단한다.`, "");
  } else {
    const c = input.classification;
    if (c.summary) out.push(c.summary, "");
    out.push(...typeSection("지운 문장 유형", c.removedTypes), ...typeSection("보탠 문장 유형", c.addedTypes));
    out.push("### 규격 개정안 (적용하지 않음 — diff로만 제시)", "");
    if (input.anchors.length === 0) out.push("이번 주는 제안 없음(증거 부족 또는 현행 규격 유지).", "");
    else for (const p of input.anchors) out.push(...diffBlock(p));
  }

  if (input.errors.length > 0) out.push("## 수집 경고", "", ...input.errors.map((e) => `- ${e}`), "");
  out.push(
    "## 반영 방법",
    "",
    "1. 위 diff 중 받아들일 것만 `prompts/writing/` 해당 파일에 직접 반영한다(이 PR은 보고서만 담는다).",
    "2. 반영 후 `npm run test:spec-files`·`npm run build`로 규격 테스트를 확인한다.",
    "3. 보고서는 병합하거나 닫는다. 병합하면 `docs/style-learning/`에 주간 기록이 쌓인다.",
    ""
  );
  return out.join("\n");
}

/** 텔레그램 3줄 요약(HTML 이스케이프는 호출부). */
export function renderTelegramSummary(input: ReportInput, prUrl: string | null): string {
  const pairs = input.pairs;
  const b = sumMetrics(pairs.map((p) => p.analysis.before));
  const a = sumMetrics(pairs.map((p) => p.analysis.after));
  const removed = pairs.reduce((n, p) => n + p.analysis.diff.removed.length, 0);
  const added = pairs.reduce((n, p) => n + p.analysis.diff.added.length, 0);
  const growth = b.chars ? `${signed(((a.chars - b.chars) / b.chars) * 100)}%` : "-";
  return [
    `📝 style-learn ${input.label}: 발행 ${input.collected}건 중 쌍 ${pairs.length} · 순수작 ${input.pure.length}`,
    `윤문 경향: 분량 ${growth} · 합니다체 ${pct(b.formalRatio)}→${pct(a.formalRatio)} · 지운 ${removed}/보탠 ${added}문장 · 제안 ${input.anchors.length}건`,
    prUrl ? `검토 PR: ${prUrl}` : "PR 없음(dry-run 또는 생성 실패)",
  ].join("\n");
}
