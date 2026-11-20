// 직접 입력 항목(source=text) -> article_jobs 입력값. 순수 함수라 DB 없이 테스트한다(createInputJob이 이 값으로 저장한다).
import { capUtf8 } from "../research/personSourcePack.js";
import { categoryForTrack, jobMetadataForTrack } from "./instagramTrack.js";
import type { InstagramQueueEntry } from "./types.js";

/** 소스 본문 상한(바이트). job.metadata가 비대해지지 않게 자른다. */
export const SOURCE_TEXT_MAX_BYTES = 8 * 1024;

export type InputJobFields = {
  keyword: string;
  headline: string | null;
  category: string | null;
  metadata: Record<string, unknown>;
};

// 변환기 큐 항목뿐 아니라 봇 주제 직접 입력(topic-intake/topicIntake.ts)도 같은 규칙으로 job을 만든다 - 필요한 필드만 받는다(2026-11-21).
export type InputJobSource = Pick<InstagramQueueEntry, "userTopic" | "sourceText" | "sourceUrl" | "track">;

export function inputJobFields(entry: InputJobSource): InputJobFields {
  const topic = (entry.userTopic ?? "").trim();
  return {
    // 질문형 주제는 가공 없이 그대로 keyword가 된다(researcher가 질문을 푼다).
    keyword: topic.split("\n")[0].slice(0, 60).trim(),
    headline: topic.slice(0, 120) || null,
    category: categoryForTrack(entry.track),
    metadata: {
      source: "keyword_input",
      inputTopic: topic,
      ...(entry.sourceText ? { sourceText: capUtf8(entry.sourceText, SOURCE_TEXT_MAX_BYTES) } : {}),
      ...(entry.sourceUrl ? { sourceUrl: entry.sourceUrl } : {}),
      ...jobMetadataForTrack(entry.track),
    },
  };
}
