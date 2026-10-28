// 문체 지표: 한 글(문단 목록) -> 분량·종결 비율·감탄/질문·어미 빈도·문장 길이.
import type { PostParagraph } from "./naverPost.js";
import { countChars, countEndings, sentenceStyle, splitSentences } from "./text.js";

export type StyleMetrics = {
  chars: number;
  sentences: number;
  formalRatio: number;
  politeRatio: number;
  exclaims: number;
  questions: number;
  avgSentenceLen: number;
  endings: Record<string, number>;
};

/** 본문 문장만(소제목 제외) 센다. 분량(chars)은 소제목 포함. */
export function bodySentences(paragraphs: PostParagraph[]): string[] {
  return paragraphs.filter((p) => !p.heading).flatMap((p) => splitSentences(p.text));
}

export function computeMetrics(paragraphs: PostParagraph[]): StyleMetrics {
  const sentences = bodySentences(paragraphs);
  const n = sentences.length;
  const body = sentences.join(" ");
  const styles = sentences.map(sentenceStyle);
  const ratio = (k: string) => (n === 0 ? 0 : styles.filter((s) => s === k).length / n);
  return {
    chars: countChars(paragraphs.map((p) => p.text).join("")),
    sentences: n,
    formalRatio: ratio("formal"),
    politeRatio: ratio("polite"),
    exclaims: sentences.filter((s) => /!["'”’)\]]*$/.test(s)).length,
    questions: sentences.filter((s) => /\?["'”’)\]]*$/.test(s)).length,
    avgSentenceLen: n === 0 ? 0 : Math.round((countChars(body) / n) * 10) / 10,
    endings: countEndings(body),
  };
}

/** 주간 합계: 분량·문장·감탄·질문·어미는 합, 비율·평균 문장 길이는 문장 수 가중 평균. */
export function sumMetrics(list: StyleMetrics[]): StyleMetrics {
  const total = list.reduce((a, m) => a + m.sentences, 0);
  const w = (pick: (m: StyleMetrics) => number) => (total === 0 ? 0 : list.reduce((a, m) => a + pick(m) * m.sentences, 0) / total);
  const endings: Record<string, number> = {};
  for (const m of list) for (const [k, v] of Object.entries(m.endings)) endings[k] = (endings[k] ?? 0) + v;
  return {
    chars: list.reduce((a, m) => a + m.chars, 0),
    sentences: total,
    formalRatio: w((m) => m.formalRatio),
    politeRatio: w((m) => m.politeRatio),
    exclaims: list.reduce((a, m) => a + m.exclaims, 0),
    questions: list.reduce((a, m) => a + m.questions, 0),
    avgSentenceLen: Math.round(w((m) => m.avgSentenceLen) * 10) / 10,
    endings,
  };
}
