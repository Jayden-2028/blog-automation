// 파이프라인(GitHub Actions)에서 `웹 검색` 이미지 자리를 채운다. prepareManuscript가 원고를 확정한
// 직후 호출한다.
//
// 맥 로컬 CLI(images:collect)와 **같은 collectWebImages를 쓰되 출력만 다르다**: 러너는 곧 사라지므로
// 파일을 보관함에 남기는 대신 Supabase Storage에 올리고, 결과를 manifest의 images로 넘긴다
// (생성 이미지와 같은 자리). 그래야 뷰어가 그리고, npm run sync:images/manuscript:export가 내려받는다.
//
// 왜 이제야 파이프라인에 붙였나(2026-09-18): 어제 만든 수집 경로는 Codex CLI 전용이라 러너에서
// 실행 자체가 불가능했다 - 결과적으로 **한 번도 자동 실행되지 않았고** 웹 검색 자리가 전부 빈 채로
// 발행 대기에 올라갔다. 실행기를 Claude(WebSearch)로 바꾸면서 이 경로가 열렸다.

import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { uploadArticleImage } from "../../services/supabase/storage/uploadArticleImage.js";
import { buildWebImageSlots, collectWebImages, defaultAskSameCut } from "./collectWebImages.js";
import { ImageDeduper } from "./imageFingerprint.js";
import { splitSearchInstruction } from "./imageEditRequest.js";
import type { CollectWebImagesOptions, UnfilledSlot } from "./collectWebImages.js";
import type { ImageCandidateRecord, ManuscriptImage } from "../manuscripts/manuscriptManifest.js";

export type CollectWebImagesForJobInput = {
  jobId: string;
  keyword: string;
  /**
   * job의 카테고리(2026-09-24). 어디를 먼저 뒤질지(서치풀)와 화질 하한을 정한다.
   * 없으면 예전 동작 - 일반 이미지 검색.
   */
  category?: string | null;
  /** 기획 브리프 유형(2026-09-24). 서치풀 선택에서 category보다 우선한다. */
  briefType?: string | null;
  /**
   * 리서치 파일 전문(2026-10-01). 작품 자리에서 공식 스틸을 못 찾았을 때, 여기 적힌 유튜브 공식
   * 영상 링크로 자동 프레임을 후보에 넣는다.
   */
  researchText?: string | null;
  /** 기획이 "웹 검색"으로 정한 자리(2026-10-02, A안). 주면 이 자리만 수집한다. */
  planSearchIndexes?: number[];
  /** 기획이 자리마다 정한 검색어. 주면 서치풀 확장 없이 그대로 쓴다. */
  planQueries?: Record<number, string[]>;
  /**
   * 기획이 자리마다 정한 **대상**(2026-10-02). 주면 마커 설명 대신 이것이 판정 기준이 된다.
   *
   * 실측 사고(오세훈 2심): 기획은 1번 자리를 "청사 외관 → 오세훈 서울시장 단독 사진"으로 바꿨고
   * 검색도 그걸로 했다. 그런데 판정은 마커 원문("서울고등법원 청사 외관")으로 해서, 정확히
   * 기획이 원한 오세훈 사진 4장을 "청사가 없다"며 전량 탈락시켰다. 2026-09-22에 사용자 요구로
   * 고친 "검색은 A, 판정은 B"를 기획 배선에서 그대로 다시 만든 것이었다.
   */
  planSubjects?: Record<number, { subject: string; caution?: string; recency?: "today" | "recent" | "any" }>;
  body: string;
  imagePrompts: string[];
  /** 이미 채워진 자리 번호(생성 이미지 등). 여기 있는 자리는 건너뛴다. */
  filledIndexes?: number[];
  /**
   * 이미 채워진 자리의 이미지 URL(2026-09-24 실측 사고). 중복 검사기에 **미리 등록**한다.
   *
   * 왜 필요한가: 채워진 자리는 수집에서 통째로 건너뛰므로 중복 검사기가 그 이미지를 본 적이
   * 없다. 그래서 일부 자리만 재수집하면 **이미 쓴 컷이 그대로 다시 들어온다** - 실측에서
   * 2번 자리가 1번과 **바이트까지 같은 파일**을 받았다.
   */
  existingImageUrls?: Record<number, string>;
  /**
   * 자리별 사용자 요구사항(2026-09-22 "🖼 이미지 수정"). 키는 자리 번호 문자열.
   * 사람이 결과를 보고 "2번은 인물 단독샷으로" 같이 적어 보낸 것이라, 마커 설명보다 **우선**한다.
   */
  requirements?: Record<string, string>;
  /**
   * 사용자가 직접 찍어준 이미지 주소. 이 자리는 **검색하지 않고** 그 주소를 그대로 쓴다.
   * 사람이 눈으로 고른 것이라 검증도 건너뛴다 - 지시가 판정보다 우선한다(사용자 결정).
   */
  directUrls?: Record<string, string>;
  /**
   * 캡션·alt 언어(2026-10-07). 사용설명서 영어본(The Korea Manual)은 "en" - 수집 에이전트의 alt와
   * 검증자가 다시 쓰는 캡션이 발행본에 그대로 나간다. 기본(미지정)은 한국어.
   */
  captionLanguage?: "ko" | "en";
};

export type CollectWebImagesForJobResult = {
  images: ManuscriptImage[];
  failures: string[];
  /** 웹에서 못 채운 자리. prepareManuscript가 AI 생성 폴백으로 넘긴다(2026-09-17). */
  unfilled: UnfilledSlot[];
  /** 자리별 후보(2026-10-02). 뷰어 "후보 보기"와 `N번 후보M` 선택에 쓴다. */
  candidates?: Record<number, ImageCandidateRecord[]>;
};

export async function collectWebImagesForJob(
  input: CollectWebImagesForJobInput,
  options: CollectWebImagesOptions = {}
): Promise<CollectWebImagesForJobResult> {
  const filled = new Set(input.filledIndexes ?? []);
  const requirements = input.requirements ?? {};
  /** 사용자 요구가 있는 자리의 검색어. 기획 검색어를 덮는다. */
  const requirementQueries: Record<number, string[]> = {};
  // 사람이 이미지 주소를 찍어 준 자리는 **획득 방식과 무관하게** 다룬다(2026-09-24).
  // 실측 사고: `페이지 캡처` 자리에 쓸 수 있는 주소를 줬는데 웹 검색 자리만 뽑는 바람에
  // 그 주소를 아무도 읽지 않았다. 사람이 고른 것이 마커 표기보다 우선한다.
  const directIndexes = new Set(Object.keys(input.directUrls ?? {}).map(Number).filter(Number.isInteger));
  const slots = buildWebImageSlots(
    input.body,
    input.imagePrompts,
    directIndexes,
    input.planSearchIndexes ? new Set(input.planSearchIndexes) : undefined
  )
    .filter((s) => !filled.has(s.index))
    // 기획의 대상을 **검색과 판정 양쪽에** 얹는다(2026-10-02). 아래 사용자 요구가 그 위에 덮인다 -
    // 사람이 결과를 보고 적은 것이 기획보다 우선한다. 주소를 직접 찍어 준 자리는 건드리지 않는다.
    .map((slot) => {
      const planned = input.planSubjects?.[slot.index];
      if (!planned || directIndexes.has(slot.index)) return slot;
      // 최신성은 판정자에게도 한 줄로 알린다 - 검색만 최신순으로 해도 판정이 옛 사진을 고르면 그만이다.
      const recencyNote =
        planned.recency === "today"
          ? "오늘 일어난 일이다 - 오늘 찍힌 사진을 먼저 고른다."
          : planned.recency === "recent"
            ? "최근 사진을 먼저 고른다."
            : "";
      const caution = [planned.caution, recencyNote].filter(Boolean).join(" ");
      return {
        ...slot,
        // subject가 비어 있으면 **설명을 갈아끼우지 않는다**(2026-10-08). 영어본에서 routeImagePlan이
        // 한글 subject를 캡션 자리에서 빼고 caution으로만 넘긴 경우다 - 설명(=캡션 바탕)은 영어 마커
        // 그대로 두고, 검색어와 판정 기준은 그대로 얹는다.
        ...(planned.subject ? { description: planned.subject } : {}),
        query: input.planQueries?.[slot.index]?.[0] ?? slot.query,
        ...(caution ? { caution } : {}),
      };
    })
    // 사용자가 적어 보낸 요구를 **검색어와 판정 기준 양쪽에** 얹는다.
    //
    // 2026-09-22 실측 사고: 처음에는 설명(판정 기준)에만 붙였다. 그러자 검색은 옛 검색어로 하고
    // 판정만 빡빡해져서, 네 후보가 전부 "요청한 투샷이 아니다"로 탈락하고 자리가 비었다.
    // 아침에 마커 정렬에서 고친 "검색은 A, 판정은 B"를 그대로 다시 만든 셈이었다.
    //
    // 사용자가 검색어를 직접 지정하는 경우가 대부분이라("SNL 주현영과 김원훈 으로 검색해서")
    // **요구사항을 검색어로 쓰고**, 원래 검색어는 뒤에 남겨 맥락을 잃지 않게 한다.
    .map((slot) => {
      const requirement = requirements[String(slot.index)];
      if (!requirement) return slot;

      // 주소를 직접 찍어 준 자리는 **설명을 갈아끼우지 않는다**(2026-09-24 실측).
      // 그 요구사항은 "이 주소를 써라"는 지시일 뿐 캡션이 아니다. 그대로 두면
      // "이미지 교체 https://www.sentv.co.kr/..."가 캡션으로 나간다.
      // 이 자리는 사람이 눈으로 고른 것이라 비전 검증도 건너뛰므로 캡션을 다시 쓸 기회가
      // 없다 - 원고 마커의 설명이 남아 있는 것 중 가장 정확하다.
      if (directIndexes.has(slot.index)) return slot;

      // 사용자는 "<검색어> 로 검색해서 나오는 <어떤 그림>"으로 쓴다. 문장을 통째로 검색창에
      // 넣으면 아무것도 안 나온다(2026-09-22 실측 - 1·5번 자리가 그래서 비었다).
      const { query, want } = splitSearchInstruction(requirement);
      // 사용자 요구가 오면 **기획이 남긴 것을 전부 버린다**(2026-10-02 이혼숙려캠프 실측 사고).
      //   - 주의사항: 기획은 "자극부부 당사자 얼굴 사진은 쓰지 않는다"를 남겼는데, 사용자가 바로 그
      //     부부의 방송 캡처를 요청한 뒤에도 그 문장이 판정에 그대로 실려 원하는 사진을 막았다.
      //   - 검색어: 아래 requirementQueries가 기획 검색어를 덮는다. 안 덮으면 수집은 기획 검색어
      //     (`이혼숙려캠프 박하선`)로 하고 판정만 사용자 기준이 돼 후보가 전부 탈락한다.
      // 검색어를 못 뽑았으면(대부분 "~로 바꿔줘"로 끝난다) **원고 키워드의 핵심**으로 찾는다 -
      // 기획이 잘못 잡은 대상을 사용자가 고치려는 것이라 기획 검색어로 돌아가면 같은 실패를 한다.
      const userQueries = uniqueQueries([query, keywordCore(input.keyword), input.keyword]);
      requirementQueries[slot.index] = userQueries;
      const { caution: _droppedPlanCaution, ...rest } = slot;
      return {
        ...rest,
        query: userQueries[0],
        // **설명을 사용자 말로 갈아 끼운다.** 덧붙이기만 하면 옛 설명이 판정을 끌고 간다
        // (실측: 자리 5의 옛 설명이 "조회수·추천수·댓글수"라, 유튜브 캡처를 요청했는데도
        // 검증자가 "조회수를 요약할 이미지가 없다"며 전부 버렸다).
        description: want,
      };
    })
    // "방송 화면·캡처·자막"을 원하는 자리(2026-10-02). 공식 스틸 강제와 자막 감점을 끈다 -
    // 예능 사연 자리에서는 **자막이 박힌 방송 캡처가 곧 내용**이다(이혼숙려캠프 사용자 요청).
    .map((slot) => (wantsBroadcastCapture(slot.description) ? { ...slot, broadcastCapture: true } : slot));
  if (slots.length === 0) return { images: [], failures: [], unfilled: [] };
  // 사용자 요구가 있는 자리는 기획 검색어·최신성 대신 사용자 기준으로 찾는다(위 map 참고).
  const effectivePlanQueries = input.planQueries || Object.keys(requirementQueries).length > 0
    ? { ...(input.planQueries ?? {}), ...requirementQueries }
    : undefined;

  // 사용자가 주소를 찍어준 자리는 검색을 돌리지 않는다. 에이전트 대신 그 주소를 "고른 결과"로
  // 넣어 주면, 내려받기·크기 검사·업로드는 기존 경로를 그대로 탄다(2026-09-22).
  const directUrls = input.directUrls ?? {};
  const directSlots = slots.filter((slot) => directUrls[String(slot.index)]);
  const searchSlots = slots.filter((slot) => !directUrls[String(slot.index)]);

  // 검증자(Claude)가 파일을 열어 봐야 하므로 러너 안에 잠깐 내려받았다가 업로드 후 버린다.
  const dir = await mkdtemp(resolve(tmpdir(), "web-images-"));

  // finally에서 닫아야 해서 try 밖에 둔다.
  let ownedDeduper: ImageDeduper | null = null;

  try {
    const uploader =
      options.upload ??
      (async ({ index, buffer, mimeType }: { index: number; buffer: Buffer; mimeType: string }) => {
        const uploaded = await uploadArticleImage({
          jobId: input.jobId,
          index,
          variant: "web",
          imageBuffer: buffer,
          mimeType,
          // 웹에서 받은 원본은 13MB짜리도 있었다(2026-10-04). 본문 폭에 맞게 줄여 올린다.
          optimize: true,
        });
        return uploaded.ok ? { ok: true as const, url: uploaded.url } : { ok: false as const, error: uploaded.error };
      });

    // 원고 하나에 하나만 만든다(2026-09-23, images.md §8-8). 사용자가 직접 지정한 자리와
    // 검색으로 채운 자리가 **같은 저장소를 공유해야** 서로 간의 중복도 잡힌다.
    ownedDeduper = options.deduper ? null : new ImageDeduper({ askSameCut: defaultAskSameCut });
    const deduper = options.deduper ?? ownedDeduper!;

    // 이미 쓰고 있는 컷을 중복 검사기에 먼저 등록한다(2026-09-24). 안 하면 일부 자리만 재수집할 때
    // 이미 쓴 컷이 다시 들어온다 - 검사기는 이번 실행에서 채운 것만 알기 때문이다.
    const existing = Object.entries(input.existingImageUrls ?? {});
    let registered = 0;
    for (const [index, url] of existing) {
      try {
        const res = await fetch(url);
        if (!res.ok) continue;
        const buffer = Buffer.from(await res.arrayBuffer());
        // **파일로 남긴다**(2026-10-02). 파일이 없으면 애매할 때 비전 비교를 못 해, 같은 사진을 다르게
        // 자른 것(스틸 ↔ 포스터)이 그대로 통과했다(이혼숙려캠프 1·6번). 이미 쓴 컷은 거리와
        // 상관없이 비전에 묻는다 - 이 경로는 이미지 수정 재수집 때만 돌아 호출이 많지 않다.
        const filePath = resolve(dir, `existing-${index}`);
        await writeFile(filePath, buffer);
        await deduper.claim(`자리 ${index}(이미 사용 중)`, buffer, res.headers.get("content-type") ?? "image/jpeg", {
          filePath,
          alwaysCompare: true,
        });
        registered += 1;
      } catch {
        // 못 받아도 수집은 진행한다 - 중복을 놓치는 쪽이 자리를 비우는 쪽보다 낫다.
      }
    }
    // 몇 건이 등록됐는지 남긴다. 0이면 중복 검사가 사실상 꺼진 것이라, 로그가 없으면 다음에
    // 또 추측하게 된다(2026-09-24 - 차단이 안 걸린 이유를 로그로 못 찾아 헤맸다).
    if (existing.length > 0) {
      console.log(`ℹ️ [images] 이미 쓰고 있는 컷 ${registered}/${existing.length}장을 중복 검사기에 등록했습니다.`);
    }

    // 사용자가 고른 주소는 그대로 쓴다 - 사람이 눈으로 확인한 것이라 비전 검증을 하지 않는다.
    const direct =
      directSlots.length === 0
        ? { found: [], failures: [], unfilled: [] }
        : await collectWebImages(
            { keyword: input.keyword, dir, slots: directSlots },
            {
              ...options,
              jobId: input.jobId,
              upload: uploader,
              deduper,
              category: input.category ?? null,
              briefType: input.briefType ?? null,
              captionLanguage: input.captionLanguage,
              searchImages: false,
              verify: false,
              userChosen: true,
              runCodex: async () => ({
                ok: true as const,
                durationMs: 0,
                data: {
                  slots: directSlots.map((slot) => ({
                    index: slot.index,
                    imageUrl: directUrls[String(slot.index)],
                    sourcePage: "",
                    alt: slot.description,
                    caption: slot.description,
                    license: "사용자가 직접 지정",
                    reusePermission: "unknown",
                    rationale: "사용자가 주소를 찍어 지정한 이미지",
                    skipped: false,
                    skipReason: "",
                    alternates: [],
                  })),
                },
              }),
            }
          );

    const result = searchSlots.length === 0
      ? { found: [], failures: [], unfilled: [] }
      : await collectWebImages(
      { keyword: input.keyword, dir, slots: searchSlots },
      {
        ...options,
        jobId: input.jobId,
        upload: uploader,
        deduper,
        category: input.category ?? null,
        briefType: input.briefType ?? null,
        captionLanguage: input.captionLanguage,
        researchText: input.researchText ?? null,
        planQueries: effectivePlanQueries,
        planRecency: input.planSubjects
          ? Object.fromEntries(
              Object.entries(input.planSubjects)
                .filter(([k]) => !requirementQueries[Number(k)])
                .map(([k, v]) => [Number(k), v.recency])
            )
          : undefined,
      }
    );

    // 사용자가 지정한 자리와 검색으로 채운 자리를 합친다.
    const found = [...direct.found, ...result.found];
    const failures = [...direct.failures, ...result.failures];
    // 사용자가 고른 이미지를 못 받은 자리는 **AI 대체로 넘기지 않는다**(2026-10-04). 사람이 특정 사진을
    // 골랐는데 엉뚱한 생성 이미지로 채우면 안 된다 - 겨울왕국3 실측에서 그 자리가 AI 대체 단계로 넘어가
    // "실존 대상이라 비운다"는 엉뚱한 사유가 붙었다. 받지 못한 이유를 남기고 비워 둔다.
    for (const slot of direct.unfilled) {
      failures.push(
        `[자리 ${slot.index}] ⚠️ 고르신 이미지를 받지 못해 비워 둡니다: ${directUrls[String(slot.index)] ?? "(주소 없음)"}`
      );
    }
    const unfilled = [...result.unfilled];

    const images: ManuscriptImage[] = found
      .filter((record) => record.storageUrl)
      .map((record) => ({
        index: record.index,
        // 검증자가 **사진을 보고 다시 쓴 캡션**을 우선한다(2026-09-24). record.alt는 마커 설명
        // 그대로라, 그것만 쓰면 "예고편 명대사 장면"이라 적힌 자리에 썸네일이 와도 캡션이
        // 안 바뀐다. 뷰어·발행이 이 description을 캡션으로 쓴다.
        description: record.caption || record.alt,
        // 검색어는 이미지 생성 프롬프트가 아니다 - 뷰어의 "프롬프트 팩"에 섞이면 혼란스럽다.
        prompt: null,
        url: record.storageUrl ?? null,
        provider: "web",
        fileName: record.fileName,
        error: null,
        sourcePage: record.sourcePage,
        license: record.license,
      }));

    // 판정자가 열어 본 후보(2026-10-02). 사용자가 직접 찍어 준 자리는 후보가 없다(검색을 안 한다).
    const candidates = { ...(direct.candidates ?? {}), ...(result.candidates ?? {}) };

    return { images, failures, unfilled, candidates };
  } finally {
    // 지문 계산용 Chromium을 닫는다. 안 닫으면 러너에 브라우저가 남는다.
    // 호출부가 넘긴 deduper는 호출부가 닫는다 - 여기서 닫으면 재사용을 깨뜨린다.
    if (!options.deduper) await ownedDeduper?.close();
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * 원고 키워드의 핵심 - 앞 두 단어(2026-10-02).
 * `이혼숙려캠프 자극부부 남편 성적 폭언` → `이혼숙려캠프 자극부부`. 키워드는 "대상 + 사건" 순서로
 * 만들어지므로 앞 두 단어가 대상이다. 사용자가 검색어 없이 "방송 캡처로 바꿔줘"라고만 했을 때 쓴다.
 */
export function keywordCore(keyword: string): string {
  return (keyword ?? "").trim().split(/\s+/).slice(0, 2).join(" ");
}

function uniqueQueries(queries: string[]): string[] {
  return [...new Set(queries.map((q) => (q ?? "").trim()).filter(Boolean))];
}

/** 방송 화면 캡처(자막 포함)를 원하는 자리인가. 설명은 사용자 요구나 기획 대상이다. */
export function wantsBroadcastCapture(description: string): boolean {
  return /방송\s*(화면|캡처|캡쳐|장면)|캡처|캡쳐|자막/.test(description ?? "");
}
