// 사용설명서 트랙 job의 진행 단계(job.metadata.ksceneStage). 상태 기계 설명은 runTranslateJob.ts 머리말.
// 가벼운 모듈로 분리한 이유: TelegramBot(콜백 처리)이 단계를 읽을 때 번역 실행 코드(헤드리스·Telegraph 등)까지 끌고 오지 않게.

export type KsceneStage = "translating" | "english_review" | "translation_failed";

export function ksceneStageOf(job: { metadata?: unknown } | null | undefined): KsceneStage | null {
  const stage = (job?.metadata as Record<string, unknown> | null | undefined)?.ksceneStage;
  return stage === "translating" || stage === "english_review" || stage === "translation_failed" ? stage : null;
}

/** 영어본 생성이 이 시간을 넘겨 translating에 머물면 죽은 것으로 보고 다시 시작을 허용한다(번역 타임아웃 15분 + 여유). */
export const TRANSLATING_STALE_MS = 25 * 60 * 1000;

/** 한글 ✅ 승인을 다시 눌렀을 때 "이미 번역 중"으로 막아야 하는가. */
export function isTranslationInProgress(job: { metadata?: unknown }, now: Date = new Date()): boolean {
  if (ksceneStageOf(job) !== "translating") return false;
  const startedAt = Date.parse(String((job.metadata as Record<string, unknown> | null)?.translateStartedAt ?? ""));
  // 시작 시각을 모르면(방금 TelegramBot이 표시만 한 상태) 진행 중으로 본다.
  return Number.isNaN(startedAt) ? true : now.getTime() - startedAt < TRANSLATING_STALE_MS;
}
