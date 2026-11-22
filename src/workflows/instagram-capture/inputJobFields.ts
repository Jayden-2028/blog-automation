// 직접 입력 항목(source=text) -> article_jobs 입력값. 순수 함수라 DB 없이 테스트한다(createInputJob이 이 값으로 저장한다).
import { capUtf8 } from "../research/personSourcePack.js";
import { scenepickJobFields } from "../scenepick/scenepickIntake.js";
import type { ScenepickJobFields } from "../scenepick/scenepickIntake.js";
import { SCENEPICK_ORIGIN_CONVERTER } from "../scenepick/scenepickTypes.js";
import { categoryForTrack, jobMetadataForTrack } from "./instagramTrack.js";
import type { InstagramCaptureResult, InstagramQueueEntry } from "./types.js";

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

// ---- 💡 상식(scenepick, 2026-11-22) ----
// 변환기에서 상식을 고르면 우리 researcher/writer 대신 사회 봇 scenepick과 **같은 모양**의 Codex 발주 job을 만든다
// (scenepickJobFields: category living, metadata {track:"scenepick", source:"scenepick_input", inputTopic, scenepickCodex:requested}).
// Codex 주문서는 inputTopic 글자만 받으므로 주제·같이 보낸 말·원 링크·확보한 소스 본문을 한 덩어리로 묶는다. 주제가 첫 줄이어야 한다 -
// scenepickKeyword가 첫 줄로 job keyword(알림·뷰어 이름)를 만든다. 4KB 상한(INPUT_TOPIC_MAX_BYTES)에서 잘리는 건 뒤쪽 본문이다.

export type ScenepickMaterial = {
  /** 주제 한 줄(첫 줄 = keyword). */
  topic: string;
  /** 사용자가 링크와 같이 보낸 말(주제와 같으면 생략). */
  note?: string | null;
  /** 원 링크. */
  url?: string | null;
  /** 링크에서 읽어 온 본문·붙여넣은 긴 글·인스타 캡션/이미지 속 글자. */
  sourceText?: string | null;
  /** 소스 본문 머리말(어디서 온 글인지). */
  sourceLabel?: string;
};

export function scenepickInputText(material: ScenepickMaterial): string {
  const topic = material.topic.trim();
  const note = (material.note ?? "").trim();
  const url = (material.url ?? "").trim();
  const sourceText = (material.sourceText ?? "").trim();
  const parts = [topic];
  if (note && note !== topic) parts.push(`같이 보낸 말: ${note}`);
  if (url) parts.push(`원 링크: ${url}`);
  if (sourceText && sourceText !== topic) parts.push(`${material.sourceLabel ?? "참고 자료"} (사실은 웹 검색으로 다시 확인):\n${sourceText}`);
  return parts.join("\n\n");
}

/** 변환기 출처 표시. scenepickMessageId는 넣지 않는다(scenepickTypes.SCENEPICK_ORIGIN_CONVERTER 주석). */
function withConverterOrigin(fields: ScenepickJobFields, queue: { id: string; telegramMessageId?: number }): ScenepickJobFields {
  const metadata = { ...fields.metadata };
  delete metadata.scenepickMessageId;
  return {
    ...fields,
    metadata: {
      ...metadata,
      scenepickOrigin: SCENEPICK_ORIGIN_CONVERTER,
      converterQueueId: queue.id,
      ...(typeof queue.telegramMessageId === "number" ? { converterMessageId: queue.telegramMessageId } : {}),
    },
  };
}

/**
 * 큐 항목(source=text: 직접 입력 또는 링크 자동 추출) -> scenepick job 입력값. 직접 입력은 주제(+붙여넣은 긴 글),
 * 링크 추출은 주제(메모 또는 제목) + 원 링크 + 읽어 온 본문(사용자 요점 포함 - queueFieldsForLinkSource)이다.
 */
export function scenepickConverterJobFields(
  entry: Pick<InstagramQueueEntry, "id" | "telegramMessageId" | "userTopic" | "sourceText" | "sourceUrl">,
  now: Date
): ScenepickJobFields {
  const text = scenepickInputText({
    topic: entry.userTopic ?? "",
    url: entry.sourceUrl,
    sourceText: entry.sourceText,
    sourceLabel: entry.sourceUrl ? "링크에서 읽은 본문" : "사용자가 붙여넣은 글",
  });
  return withConverterOrigin(scenepickJobFields({ text, messageId: null, now }), entry);
}

/** 인스타 캡처 결과 -> scenepick job 입력값. 캡션·이미지 속 글자가 소스 본문이다(캡처 이미지 자체는 넘기지 않는다). */
export function scenepickCaptureJobFields(
  capture: Pick<InstagramCaptureResult, "queueEntryId" | "instagramUrl" | "caption" | "burnedInText" | "searchKeyword">,
  options: { now: Date; userNote?: string | null; telegramMessageId?: number }
): ScenepickJobFields {
  const caption = capture.caption.trim();
  const topic = capture.searchKeyword.trim() || caption.split("\n")[0] || capture.instagramUrl;
  const sourceText = [caption, ...capture.burnedInText.map((line) => line.trim())].filter(Boolean).join("\n");
  const text = scenepickInputText({
    topic,
    note: options.userNote,
    url: capture.instagramUrl,
    sourceText,
    sourceLabel: "게시물 캡션·이미지 속 글자",
  });
  return withConverterOrigin(scenepickJobFields({ text, messageId: null, now: options.now }), {
    id: capture.queueEntryId,
    telegramMessageId: options.telegramMessageId,
  });
}
