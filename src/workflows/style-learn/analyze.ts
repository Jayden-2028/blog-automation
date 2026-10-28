// 쌍(발행본 vs 원고) 하나의 분석: 지표·제목·첫/마지막 문단·문장 diff.
import { computeMetrics, bodySentences } from "./metrics.js";
import type { StyleMetrics } from "./metrics.js";
import { diffSentences } from "./sentenceDiff.js";
import type { SentenceDiff } from "./sentenceDiff.js";
import type { PostParagraph } from "./naverPost.js";
import { diceSimilarity } from "./text.js";

export type ParagraphDiff = { before: string; after: string; similarity: number };

export type PairAnalysis = {
  before: StyleMetrics;
  after: StyleMetrics;
  titleBefore: string;
  titleAfter: string;
  titleChanged: boolean;
  firstParagraph: ParagraphDiff;
  lastParagraph: ParagraphDiff;
  diff: SentenceDiff;
};

const bodyParas = (ps: PostParagraph[]) => ps.filter((p) => !p.heading).map((p) => p.text);

function paragraphDiff(before: string | undefined, after: string | undefined): ParagraphDiff {
  const b = before ?? "";
  const a = after ?? "";
  return { before: b, after: a, similarity: Math.round(diceSimilarity(b, a) * 100) / 100 };
}

export function analyzePair(
  manuscript: { title: string; paragraphs: PostParagraph[] },
  published: { title: string; paragraphs: PostParagraph[] }
): PairAnalysis {
  const mb = bodyParas(manuscript.paragraphs);
  const pb = bodyParas(published.paragraphs);
  return {
    before: computeMetrics(manuscript.paragraphs),
    after: computeMetrics(published.paragraphs),
    titleBefore: manuscript.title,
    titleAfter: published.title,
    titleChanged: manuscript.title.replace(/\s+/g, "") !== published.title.replace(/\s+/g, ""),
    firstParagraph: paragraphDiff(mb[0], pb[0]),
    lastParagraph: paragraphDiff(mb[mb.length - 1], pb[pb.length - 1]),
    diff: diffSentences(bodySentences(manuscript.paragraphs), bodySentences(published.paragraphs)),
  };
}
