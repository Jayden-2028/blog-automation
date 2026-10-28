// 주간 문체 학습 오케스트레이션: 수집 -> 매칭 -> 분석 -> (Claude 분류) -> 보고서 문자열.
// 파일 쓰기·PR·텔레그램은 호출부(job)가 한다. 규격 파일은 읽기만 하고 DB는 읽기 전용이다.
import { analyzePair } from "./analyze.js";
import { buildClassifyPrompt, classifyWithClaude, loadSpecs, verifyProposalAnchors } from "./classify.js";
import type { ClassifyOutcome } from "./classify.js";
import { collectNaverPosts } from "./collect.js";
import type { CollectResult } from "./collect.js";
import { loadArticleCandidates } from "./loadArticles.js";
import type { ArticleCandidate } from "./loadArticles.js";
import { MATCH_THRESHOLD, MATCH_WINDOW_DAYS, matchPosts } from "./match.js";
import { computeMetrics, bodySentences } from "./metrics.js";
import { renderReport } from "./report.js";
import type { ReportInput, ReportPair, ReportPure } from "./report.js";
import { isoWeekLabel, kstDate } from "./text.js";

export const DEFAULT_DAYS = 7;

export type StyleLearnDeps = {
  collect?: (days: number) => Promise<CollectResult>;
  loadArticles?: (sinceIso: string) => Promise<ArticleCandidate[]>;
  classify?: (prompt: string) => Promise<ClassifyOutcome>;
  readSpecs?: (categories: string[]) => Promise<Record<string, string>>;
  now?: Date;
};

export type StyleLearnResult = { input: ReportInput; markdown: string; classifyPrompt: string | null };

export async function runStyleLearn(options: { days?: number; skipClaude?: boolean } & StyleLearnDeps = {}): Promise<StyleLearnResult> {
  const days = options.days ?? DEFAULT_DAYS;
  const now = options.now ?? new Date();
  const collected = await (options.collect ?? ((d) => collectNaverPosts(d, { now })))(days);
  if (collected.posts.length === 0 && collected.errors.some((e) => e.startsWith("RSS 실패"))) {
    throw new Error(collected.errors.join("; "));
  }
  const sinceIso = new Date(now.getTime() - (days + MATCH_WINDOW_DAYS + 2) * 86400000).toISOString();
  const articles = await (options.loadArticles ?? loadArticleCandidates)(sinceIso);
  const byId = new Map(articles.map((a) => [a.id, a]));

  const matchPostsIn = collected.posts.map((c) => ({
    id: c.logNo,
    title: c.post.title,
    publishedDate: c.publishedDate,
    text: c.post.paragraphs.map((p) => p.text).join("\n"),
  }));
  const matches = matchPosts(matchPostsIn, articles);

  const pairs: ReportPair[] = [];
  const pure: ReportPure[] = [];
  const pureParas: Array<{ label: string; sentences: string[] }> = [];
  for (const c of collected.posts) {
    const m = matches.find((x) => x.postId === c.logNo);
    const article = m?.matched && m.best ? byId.get(m.best.articleId) : undefined;
    if (article && m?.best) {
      pairs.push({
        logNo: c.logNo,
        link: `https://blog.naver.com/whyissuenow/${c.logNo}`,
        category: c.category,
        publishedDate: c.publishedDate,
        articleId: article.id,
        articleCategory: article.category,
        score: m.best,
        analysis: analyzePair({ title: article.title, paragraphs: article.paragraphs }, c.post),
      });
    } else {
      const metrics = computeMetrics(c.post.paragraphs);
      pure.push({ logNo: c.logNo, link: `https://blog.naver.com/whyissuenow/${c.logNo}`, title: c.post.title, publishedDate: c.publishedDate, metrics, best: m?.best ?? null });
      pureParas.push({ label: c.post.title, sentences: bodySentences(c.post.paragraphs).filter((s) => s.length >= 25).slice(0, 6) });
    }
  }
  pairs.sort((a, b) => b.publishedDate.localeCompare(a.publishedDate));

  let classification = null as ReportInput["classification"];
  let classifyError: string | null = null;
  let anchors: ReportInput["anchors"] = [];
  let classifyPrompt: string | null = null;
  if (pairs.length === 0) classifyError = "이번 기간에 짝지어진 글이 없음";
  else if (options.skipClaude) classifyError = "--no-claude";
  else {
    try {
      const categories = pairs.map((p) => p.articleCategory);
      const specs = await (options.readSpecs ?? ((c) => loadSpecs(process.cwd(), c)))(categories);
      classifyPrompt = buildClassifyPrompt(
        pairs.map((p) => ({ label: p.analysis.titleAfter.slice(0, 20), category: p.articleCategory, diff: p.analysis.diff })),
        pureParas,
        specs
      );
      const outcome = await (options.classify ?? classifyWithClaude)(classifyPrompt);
      if (outcome.ok) {
        classification = outcome.classification;
        anchors = verifyProposalAnchors(outcome.classification.proposals, specs);
      } else classifyError = outcome.error;
    } catch (error) {
      classifyError = error instanceof Error ? error.message : String(error);
    }
  }

  const input: ReportInput = {
    // 월요일 실행이 지난주를 다루므로 라벨은 "어제"가 속한 주로 붙인다.
    label: isoWeekLabel(kstDate(new Date(now.getTime() - 86400000))),
    days,
    generatedAt: `${kstDate(now)} KST`,
    listed: collected.listed,
    collected: collected.posts.length,
    threshold: MATCH_THRESHOLD,
    pairs,
    pure,
    errors: collected.errors,
    classification,
    classifyError,
    anchors,
  };
  return { input, markdown: renderReport(input), classifyPrompt };
}
