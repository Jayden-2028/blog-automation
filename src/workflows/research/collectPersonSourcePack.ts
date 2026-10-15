// 맥 수집 스크립트의 본체(B-1 ①): 소스팩이 없는 최근 person job을 찾아 네이버 인물DB·나무위키 원문을 받아
// `job.metadata.researchSourcePack`에 저장한다. 이 원격 DB 쓰기는 파이프라인 운영 기능이며 사용자가
// 2026-10-15 ①안으로 승인했다. 실패는 비치명이다(errors에 남기고 팩을 저장해 러너가 불필요하게 기다리지 않게 한다).
import { ArticleJobRepository } from "../../repositories/ArticleJobRepository.js";
import { fetchPersonSourcePack, readPersonSourcePack } from "./personSourcePack.js";
import type { PersonSourcePack } from "./personSourcePack.js";

/** 이 시간 안에 선택된 job만 본다(오래된 job의 뒤늦은 수집으로 DB를 흔들지 않는다). */
export const SOURCE_PACK_LOOKBACK_MS = 12 * 60 * 60 * 1000;
/** 한 번 실행에서 처리할 최대 건수. */
export const SOURCE_PACK_MAX_PER_RUN = 3;

export type CollectPersonSourcePackDeps = {
  listCandidates: (sinceIso: string, limit: number) => Promise<Array<{ id: string; keyword: string }>>;
  fetchPack: (keyword: string) => Promise<PersonSourcePack>;
  savePack: (jobId: string, pack: PersonSourcePack) => Promise<void>;
  /** 저장 뒤 실제로 남았는지 읽어 본다(다른 단계의 metadata 병합과 겹치면 덮일 수 있다). */
  hasPack: (jobId: string) => Promise<boolean>;
  now?: () => Date;
  log?: (message: string) => void;
};

export type CollectPersonSourcePackResult = {
  processed: Array<{ jobId: string; keyword: string; saved: boolean; errors: string[] }>;
};

export async function collectPersonSourcePacks(deps: CollectPersonSourcePackDeps): Promise<CollectPersonSourcePackResult> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((message: string) => console.log(message));
  const since = new Date(now().getTime() - SOURCE_PACK_LOOKBACK_MS).toISOString();
  const candidates = await deps.listCandidates(since, SOURCE_PACK_MAX_PER_RUN);
  const processed: CollectPersonSourcePackResult["processed"] = [];

  for (const job of candidates) {
    const pack = await deps.fetchPack(job.keyword);
    let saved = false;
    // 러너가 같은 시각에 다른 키를 병합하면 읽기-수정-쓰기 경합으로 덮일 수 있어 확인하고 한 번 더 쓴다.
    for (let attempt = 0; attempt < 2 && !saved; attempt++) {
      await deps.savePack(job.id, pack);
      saved = await deps.hasPack(job.id);
    }
    const ok = pack.errors.length === 0;
    log(
      `${ok ? "✅" : "⚠️"} [person-pack] ${job.keyword}: 인물DB ${pack.personDb.length.toLocaleString()}자 · 나무위키 ${pack.namuwiki.length.toLocaleString()}자` +
        `${saved ? "" : " · 저장 확인 실패"}${ok ? "" : ` · ${pack.errors.join(" / ")}`}`
    );
    processed.push({ jobId: job.id, keyword: job.keyword, saved, errors: pack.errors });
  }
  return { processed };
}

/** 실제 저장소·네트워크에 연결한 기본 의존성. */
export function defaultCollectPersonSourcePackDeps(): CollectPersonSourcePackDeps {
  return {
    listCandidates: (sinceIso, limit) => ArticleJobRepository.listPersonJobsNeedingSourcePack(sinceIso, limit),
    fetchPack: (keyword) => fetchPersonSourcePack(keyword),
    savePack: async (jobId, pack) => {
      await ArticleJobRepository.mergeMetadata(jobId, { researchSourcePack: pack });
    },
    hasPack: async (jobId) => {
      const job = await ArticleJobRepository.findById(jobId);
      return readPersonSourcePack(job?.metadata as Record<string, unknown> | null) !== null;
    },
  };
}
