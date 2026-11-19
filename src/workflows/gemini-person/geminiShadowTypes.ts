// job.metadata.geminiShadow의 모양. 인물 제미나이 그림자 트랙이 쓰고, 뷰어(manifest 덧입힘)가 읽는다.
// DB 컬럼·테이블은 없다 - article_jobs.metadata jsonb 안의 한 키다(migration 불필요).

export type GeminiShadowSource = {
  title: string | null;
  url: string;
  /** 조사 노트 본문에서 뽑았는가, 집필 결과 본문에서 뽑았는가(agy는 grounding 메타데이터가 없다). */
  via: "notes" | "body";
};

export type GeminiShadowCallUsage = {
  /** agy 봉투가 알려 준 모델. 안 알려 주면 null(기본 모델을 썼다는 뜻일 수 있다). */
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  thinkingTokens: number | null;
  cacheReadTokens: number | null;
  totalTokens: number | null;
  durationMs: number;
  numTurns: number | null;
};

/** 구독으로 돌아 금액은 없다 - 토큰 수만 남긴다(비용 원장에도 기록하지 않는다). */
export type GeminiShadowUsage = {
  research: GeminiShadowCallUsage | null;
  write: GeminiShadowCallUsage | null;
  totalTokens: number | null;
};

export type GeminiShadow = {
  /** 디스패치(또는 수동 실행) 시각. 멱등 가드의 키다 - 이 값이 있으면 다시 디스패치하지 않는다. */
  requestedAt: string;
  model?: string;
  startedAt?: string;
  /** 맥미니 폴러가 이 job을 집은 표식(claim 확인용 난수). */
  claimId?: string;
  /** 집은 횟수. 40분 넘게 안 끝난 잔재는 1회만 다시 집는다. */
  attempts?: number;
  finishedAt?: string;
  title?: string;
  body?: string;
  researchNotes?: string;
  sources?: GeminiShadowSource[];
  usage?: GeminiShadowUsage;
  /** 실패 사유. 있으면 title/body가 없을 수 있다. */
  error?: string;
  /** 제목 줄 형식이 어긋났을 때의 메모(parseGeminiPersonOutput). */
  warning?: string;
};

export function readGeminiShadow(metadata: unknown): GeminiShadow | null {
  const raw = (metadata as Record<string, unknown> | null | undefined)?.geminiShadow;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Partial<GeminiShadow>;
  return typeof value.requestedAt === "string" ? (value as GeminiShadow) : null;
}
