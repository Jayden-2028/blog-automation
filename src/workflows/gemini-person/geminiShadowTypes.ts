// job.metadata.geminiShadow의 모양. 인물 제미나이 그림자 트랙이 쓰고, 뷰어(manifest 덧입힘)가 읽는다.
// DB 컬럼·테이블은 없다 - article_jobs.metadata jsonb 안의 한 키다(migration 불필요).

export type GeminiShadowSource = {
  title: string | null;
  url: string;
  /** grounding 메타데이터에서 왔는지, 조사 노트 본문에 적힌 URL인지. */
  via: "grounding" | "notes";
};

export type GeminiShadowCallUsage = {
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  /** thinking 토큰(출력 단가로 청구). 응답에 없으면 null. */
  thinkingTokens: number | null;
  /** grounding이 프롬프트에 끼운 토큰(입력 단가로 청구). 응답에 없으면 null. */
  toolUseTokens: number | null;
  totalTokens: number | null;
  durationMs: number;
  /** 토큰 단가만으로 계산한 금액(검색 grounding 쿼리 요금 제외). 단가 미등록이면 null. */
  costUsd: number | null;
};

export type GeminiShadowUsage = {
  research: GeminiShadowCallUsage | null;
  write: GeminiShadowCallUsage | null;
  /** 두 호출의 costUsd 합(둘 중 하나라도 null이면 null). */
  totalCostUsd: number | null;
};

export type GeminiShadow = {
  /** 디스패치(또는 수동 실행) 시각. 멱등 가드의 키다 - 이 값이 있으면 다시 디스패치하지 않는다. */
  requestedAt: string;
  model?: string;
  startedAt?: string;
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
