// 원고 열람 페이지(manuscripts/index.html)가 읽는 인덱스. 날짜 -> 주제(job) 구조를 담아,
// renderManuscriptPage가 이것 하나만 보고 트리를 그릴 수 있게 한다.
//
// job 1건 = topic 1건(jobId로 upsert). 재실행해도 같은 topic 슬롯을 덮어쓴다(중복 생성 방지).
//
// 2026-09-15 Blogspot 단독 운영(BLOGSPOT_ONLY_DESIGN.md §2): 주제 하나에 원고도 하나다.
// DB의 `channels`(jsonb 배열) 컬럼은 **그대로 둔다** - 컬럼을 바꾸면 migration이 필요하고 그건
// 승인 게이트다(CLAUDE.md). 대신 읽기/쓰기 경계에서만 배열 1칸 <-> 단일 객체로 매핑한다.
// 과거에 쌓인 행(channel이 "tistory"였던 것 포함)도 [0]을 집으면 그대로 읽히므로 뷰어에서
// 사라지지 않는다 - 그 행의 channel 필드는 무시한다.
//
// 2026-09-15: 로컬 파일(manuscripts/manifest.json) 대신 Supabase manuscript_manifest_topics
// 테이블에 저장한다. GitHub Actions(job-publish-prepare.yml)는 매번 새로 체크아웃되는 일회용
// 컴퓨터라 로컬 파일이 실행마다 없는 상태로 시작했고, 그 결과 새로 승인된 job만 담긴 "거의 빈"
// 목록으로 페이지를 통째로 다시 배포해 이미 준비돼 있던 다른 원고들이 사라지는 사고가 실제로
// 발생했다(4건, docs/ai-handoff/CURRENT_STATE.md 참고). job_id로 upsert하는 행 단위 저장이라
// 서로 다른 실행 환경(로컬/GitHub Actions)이 동시에 처리해도 서로의 행을 지우지 않는다 - 이 파일이
// 내보내는 함수 시그니처(loadManifest/saveManifest/upsertTopicEntry)는 그대로라 호출부(
// buildManuscriptPageCli.ts/prepareApprovedManuscripts.ts)는 변경이 필요 없다.
//
// 스키마: supabase/migrations/20260915013000_manuscript_manifest_topics.sql.

import { supabase } from "../../services/supabase/client.js";
import type { ArticleJobRow, ManuscriptManifestTopicRow } from "../../types/database.js";

/** 자동 생성된 이미지 1장. index는 본문 [IMAGE: ] 마커 순서(1부터)와 일치한다. */
export type ManuscriptImage = {
  index: number;
  /** [IMAGE: 설명]의 설명. 뷰어에서 캡션으로도 쓴다. */
  description: string;
  /** [IMAGE PROMPT: ...]. 생성에 실제로 쓴 프롬프트. */
  prompt: string | null;
  /** Supabase Storage 공개 URL. 생성/업로드에 실패하면 null(원고 자체는 그대로 진행한다). */
  url: string | null;
  /** "openai" | "gemini". A/B 비교 모드에서는 같은 index가 provider만 다르게 2장 들어온다. */
  provider: string | null;
  /** 로컬 미러 파일명(npm run sync:images가 이 이름으로 내려받는다). */
  fileName: string;
  /** 생성 실패 사유(있으면). 뷰어가 "이미지 없음" 자리에 보여준다. */
  error?: string | null;
  /**
   * 웹에서 찾아온 이미지일 때의 출처(2026-09-18). 생성 이미지에는 없다.
   * 발행 시 출처 표기가 필요하고, 보관함의 image-metadata.md도 이 값을 쓴다.
   */
  sourcePage?: string | null;
  /** 재사용 근거(예: "공공누리 제1유형", "삼성전자 공식 홈페이지"). */
  license?: string | null;
};

export type ManuscriptEntry = {
  title: string;
  searchDescription: string | null;
  slug: string | null;
  /** 로컬 보관함 폴더로 쓸 짧은 한글 키워드(2026-09-18). 없으면 키워드로 폴백한다. */
  shortName?: string | null;
  tags: string[];
  body: string;
  /**
   * body에 등장하는 [IMAGE: 설명] 마커와 같은 순서로 짝을 맞추는 이미지 제작 프롬프트
   * (job.metadata.imagePrompts, parseDraftFile.ts가 본문에서 빼내 둔 것). parseManuscriptBlocks가
   * 렌더링 시 이 배열과 본문의 마커 개수를 대조한다 - 개수가 안 맞으면 프롬프트 없이 보여준다.
   * images가 채워지면 그쪽이 우선이고, 이 배열은 과거 행 폴백으로 남는다.
   */
  imagePrompts: string[];
  /** 자동 생성된 이미지. 아직 생성 전이거나 과거 행이면 빈 배열. */
  images: ManuscriptImage[];
  /** PIPELINE_ROOT 기준 상대 경로(표시용). 본문 자체는 body에 인라인으로 들어 있다. */
  filePath: string;
  /**
   * 네이버 블로그용 배리에이션(2026-09-18 사용자 요청). 텍스트만 다르고 **이미지는 위 images를
   * 그대로 공유한다** - 그래서 body의 [IMAGE: ] 마커 개수·순서가 위 body와 반드시 같다
   * (generateNaverVariant가 검증하고, 다르면 배리에이션을 버린다).
   * 생성 전이거나 실패했으면 null - 뷰어는 그때 네이버 복사 버튼을 숨긴다.
   */
  naver?: { title: string; body: string; tags: string[] } | null;
  /**
   * 원고 출처 표기(2026-09-21). "instagram"이면 뷰어가 별도 배지를 보여준다 - 사용자가 직접
   * 인스타그램에서 고른 소재라는 걸 한눈에 구분하기 위해서다(일반 키워드 발굴과 다른 신뢰도/맥락).
   */
  sourceTag?: "instagram" | null;
  /** sourceTag가 있을 때만 의미 있다. 배지 클릭/표시에 쓸 원본 링크. */
  sourceUrl?: string | null;
};

export type ManuscriptTopicEntry = {
  jobId: string;
  keyword: string;
  category: string | null;
  /** Asia/Seoul 기준 YYYY-MM-DD. */
  date: string;
  readyAt: string;
  manuscript: ManuscriptEntry;
};

export type ManuscriptManifest = {
  topics: ManuscriptTopicEntry[];
};

const EMPTY_MANIFEST: ManuscriptManifest = { topics: [] };

const EMPTY_ENTRY: ManuscriptEntry = {
  title: "",
  searchDescription: null,
  slug: null,
  shortName: null,
  tags: [],
  body: "",
  imagePrompts: [],
  images: [],
  filePath: "",
  naver: null,
};

/**
 * jsonb `channels` 배열의 첫 칸을 단일 원고로 읽는다. 과거 행은 channel/imagePrompts만 있고
 * images가 없으므로 기본값으로 채운다 - 그래야 뷰어가 옛 원고에서도 터지지 않는다.
 */
function rowToTopic(row: ManuscriptManifestTopicRow): ManuscriptTopicEntry {
  const raw = ((row.channels as Partial<ManuscriptEntry>[] | null) ?? [])[0];
  return {
    jobId: row.job_id,
    keyword: row.keyword,
    category: row.category,
    date: row.date,
    readyAt: row.ready_at,
    manuscript: raw
      ? {
          ...EMPTY_ENTRY,
          ...raw,
          tags: raw.tags ?? [],
          imagePrompts: raw.imagePrompts ?? [],
          images: raw.images ?? [],
        }
      : { ...EMPTY_ENTRY },
  };
}

export async function loadManifest(): Promise<ManuscriptManifest> {
  const { data, error } = await supabase
    .from("manuscript_manifest_topics")
    .select("*")
    .order("date", { ascending: false })
    .order("ready_at", { ascending: false });
  if (error) throw error;
  if (!data) return { ...EMPTY_MANIFEST };
  return { topics: data.map(rowToTopic) };
}

/**
 * manifest.topics 전부를 job_id로 upsert한다(삭제는 하지 않는다). 호출자가 loadManifest()로
 * 읽은 것을 그대로 다시 저장하는 패턴이 흔한데, 이때 다른 실행이 그 사이 새로 추가한 행이 있어도
 * 이 함수는 그 행을 모른 채 자기가 아는 행만 upsert하므로 지우지 않는다 - 전체 겹어쓰기(overwrite)
 * 방식이었다면 재현됐을 유실을 원천적으로 막는다.
 */
export async function saveManifest(manifest: ManuscriptManifest): Promise<void> {
  if (manifest.topics.length === 0) return;
  const now = new Date().toISOString();
  const rows = manifest.topics.map((topic) => ({
    job_id: topic.jobId,
    keyword: topic.keyword,
    category: topic.category,
    date: topic.date,
    ready_at: topic.readyAt,
    channels: [topic.manuscript],
    updated_at: now,
  }));
  const { error } = await supabase.from("manuscript_manifest_topics").upsert(rows, { onConflict: "job_id" });
  if (error) throw error;
}

/** 같은 jobId의 기존 topic을 새 entry로 교체한다(없으면 추가). 순수 함수 - DB 접근 없음. */
export function upsertTopicEntry(manifest: ManuscriptManifest, entry: ManuscriptTopicEntry): ManuscriptManifest {
  return { topics: [...manifest.topics.filter((t) => t.jobId !== entry.jobId), entry] };
}

/**
 * 이전 실행(prepareManuscript)이 job.metadata.images에 저장해 둔 자동 생성 이미지를 읽는다 -
 * prepareManuscript.ts(재생성 방지)와 publishArticleToBlogspot.ts(본문에 실제 이미지 삽입) 둘 다
 * 같은 데이터를 봐야 해서 여기 하나로 모은다(2026-09-15).
 */
export function readJobManuscriptImages(job: ArticleJobRow): ManuscriptImage[] {
  const raw = job.metadata?.images;
  if (!Array.isArray(raw)) return [];
  return raw.filter((image): image is ManuscriptImage => !!image && typeof image === "object" && "index" in image);
}
