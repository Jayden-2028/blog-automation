// 캡션 묶음 -> 주제 후보. LLM 1회 호출로 **추출과 클러스터링을 한 번에** 한다.
//
// 왜 한 번에 하는가: 주제를 먼저 뽑고 나중에 묶으면, 같은 사건을 두 페이지가 다른 표현으로
// 쓴 경우(예: "국중박 분장놀이" vs "국립중앙박물관 코스프레 대회")를 문자열로는 못 묶는다.
// 전체 캡션을 한 화면에 놓고 판단해야 묶인다.
//
// query를 따로 받는 이유: label은 사람이 읽는 제목이라 길어도 되지만, 블로그 포화도를 재려면
// 실제로 사람들이 검색창에 칠 **짧은 핵심어**가 필요하다. 긴 문장으로 조회하면 문서 수가 0으로
// 나와 "빈틈"으로 오판한다(기존 파이프라인에서 겪은 문제 - extractTopicQueries.ts 참고).

import { PIPELINE_ROOT } from "../../config/pipelinePaths.js";
import { runHeadlessClaude } from "../../services/llm/runHeadlessClaude.js";
import type { RunHeadlessClaudeResult } from "../../services/llm/runHeadlessClaude.js";
import type { PostSignal, TopicCandidate } from "./types.js";

export const EXTRACT_TIMEOUT_MS = 5 * 60 * 1000;

/** 라벨만 다는 용도. 순위에는 쓰지 않는다(2026-09-21 사용자 결정). */
export const TOPIC_CATEGORIES = [
  "entertainment", // 연예·아이돌·방송
  "issue", // 사건·사고·사회 이슈
  "life", // 생활·정책·소비
  "culture", // 전시·공연·문화행사
  "food", // 맛집·먹거리
  "place", // 장소·여행·나들이
  "etc",
] as const;

export function buildExtractPrompt(posts: PostSignal[]): string {
  const lines = posts.map((post, i) => {
    const caption = post.caption.replace(/\s+/g, " ").trim().slice(0, 300);
    return `[${i + 1}] @${post.username} | 좋아요 ${post.likes} 댓글 ${post.comments}\n${caption || "(캡션 없음)"}`;
  });

  return [
    "아래는 한국 이슈 인스타그램 페이지들이 최근 이틀간 올린 게시물이다.",
    "네 일은 **블로그 글감이 될 만한 주제 단위로 묶는 것**이다.",
    "",
    "## 규칙",
    "- 같은 사건을 다룬 게시물은 표현이 달라도 **하나의 주제로 묶는다**. 이게 이 작업의 핵심이다.",
    "- 서로 다른 사건이면 절대 묶지 않는다. 같은 인물이 나와도 사건이 다르면 별개다.",
    "- 블로그 글감이 안 되는 것은 **제외한다**: 페이지 공지, 이벤트 응모, 광고, 단순 감성 사진,",
    "  '오늘의 날씨' 같은 반복 코너.",
    "- label: 사람이 읽는 주제명. 무슨 일인지 한 줄로 알 수 있게 쓴다(20자 안팎).",
    "- query: **사람들이 검색창에 실제로 칠 짧은 핵심어**(2~4어절). 조사·수식어를 뺀 고유명사 중심.",
    "  예) label '국립중앙박물관 분장놀이 결선 25팀 공개' -> query '국중박 분장놀이'",
    `- category: 다음 중 하나만. ${TOPIC_CATEGORIES.join(" / ")}`,
    "- posts: 그 주제에 속한 게시물 번호를 쉼표로.",
    "",
    "## 출력 형식 (이 형식만, 설명 금지)",
    "### TOPIC",
    "label: ...",
    "query: ...",
    "category: ...",
    "posts: 1, 5, 12",
    "",
    "(주제 수만큼 ### TOPIC 블록을 반복한다)",
    "",
    "## 게시물",
    ...lines,
  ].join("\n");
}

/**
 * LLM 출력 -> 주제 후보. 형식이 조금 흔들려도(공백·대소문자·번호 표기) 받아들인다.
 * 존재하지 않는 게시물 번호는 조용히 버린다 - 모델이 번호를 지어내도 파이프라인이 죽지 않게.
 */
export function parseTopicOutput(raw: string, posts: PostSignal[]): TopicCandidate[] {
  const blocks = raw.split(/^###\s*TOPIC.*$/gim).slice(1);
  const topics: TopicCandidate[] = [];

  for (const block of blocks) {
    const field = (name: string): string => {
      const matched = block.match(new RegExp(`^\\s*${name}\\s*[:：]\\s*(.+)$`, "im"));
      return matched ? matched[1].trim() : "";
    };

    const label = field("label");
    const query = field("query") || label;
    if (!label) continue;

    const indexes = [...field("posts").matchAll(/\d+/g)]
      .map((m) => Number(m[0]) - 1)
      .filter((i) => i >= 0 && i < posts.length);

    const unique = [...new Set(indexes)];
    if (unique.length === 0) continue; // 근거 게시물이 없는 주제는 버린다

    const category = TOPIC_CATEGORIES.includes(field("category") as (typeof TOPIC_CATEGORIES)[number])
      ? field("category")
      : "etc";

    topics.push({ label, query, category, posts: unique.map((i) => posts[i]) });
  }

  return topics;
}

export type ExtractTopicsResult =
  | { status: "success"; topics: TopicCandidate[]; durationMs: number }
  | { status: "failed"; error: string };

export async function extractTopics(
  posts: PostSignal[],
  options: { generate?: (prompt: string) => Promise<RunHeadlessClaudeResult> } = {}
): Promise<ExtractTopicsResult> {
  if (posts.length === 0) return { status: "failed", error: "게시물이 없습니다." };

  const generate =
    options.generate ??
    ((prompt: string) =>
      runHeadlessClaude({
        prompt,
        // 캡션이 유일한 입력이다 - 웹 검색이나 파일 접근을 줄 이유가 없다.
        allowedTools: [],
        cwd: PIPELINE_ROOT,
        timeoutMs: EXTRACT_TIMEOUT_MS,
      }));

  const startedAt = Date.now();
  const result = await generate(buildExtractPrompt(posts));
  if (!result.ok) return { status: "failed", error: result.error };

  const topics = parseTopicOutput(result.output, posts);
  if (topics.length === 0) {
    return { status: "failed", error: `주제를 하나도 못 뽑았습니다. 응답 앞부분: ${result.output.slice(0, 200)}` };
  }

  return { status: "success", topics, durationMs: Date.now() - startedAt };
}
