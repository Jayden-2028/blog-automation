// 이미지 메이커 규격 파일(`prompts/images/image-maker.md`)을 읽어 에이전트 프롬프트에 끼운다.
//
// 왜 파일인가(2026-10-01 사용자 결정): 전까지 수집·선택 규칙은 collectWebImages.ts 안에 문자열로
// 박혀 있었고, 같은 규칙이 집필자용 `rules/images.md`에도 따로 있었다. 두 곳이 갈라지면 "규칙은
// 고쳤는데 실행자는 모르는" 상태가 된다 - 실제로 그 사고가 있었고 코드 주석에 남아 있다
// ("규칙만 적어 두고 실행자가 없던 것이 이 사고의 원인이었다").
//
// 코드 프롬프트와 규격의 역할을 나눈다:
//   - 규격 파일 = **무엇을 고를지**(서치풀·판정 순서·선택 기준·캡션·저작권)
//   - 코드 프롬프트 = **어떻게 돌려줄지**(JSON 스키마, 후보 목록 형식, 도구 사용)
// 충돌하면 규격 파일이 이긴다. 프롬프트에 그렇게 명시해 넣는다.
//
// 읽기에 실패해도 수집을 멈추지 않는다(fail-open). 규격이 없으면 예전처럼 코드 프롬프트만으로
// 돈다 - 이미지가 한 장도 안 들어오는 것보다 낫다.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PIPELINE_ROOT } from "../../config/pipelinePaths.js";

export const IMAGE_MAKER_SPEC_PATH = "prompts/images/image-maker.md";

/** 한 프로세스에서 여러 번 읽지 않는다. null은 "읽어 봤고 없더라"는 뜻이다. */
let cached: string | null | undefined;

export function loadImageMakerSpec(): string | null {
  if (cached !== undefined) return cached;
  try {
    const text = readFileSync(resolve(PIPELINE_ROOT, IMAGE_MAKER_SPEC_PATH), "utf8").trim();
    cached = text.length > 0 ? text : null;
  } catch (error) {
    console.warn(
      `⚠️ [images] 이미지 규격을 읽지 못했습니다(${IMAGE_MAKER_SPEC_PATH}) - 코드 프롬프트만으로 진행합니다: ` +
        `${error instanceof Error ? error.message : error}`
    );
    cached = null;
  }
  return cached;
}

/** 테스트에서 캐시를 비운다. */
export function resetImageMakerSpecCache(): void {
  cached = undefined;
}

/**
 * 프롬프트 맨 앞에 끼울 규격 블록. 규격이 없으면 빈 배열이라 호출부가 분기하지 않아도 된다.
 */
export function imageMakerSpecLines(spec: string | null = loadImageMakerSpec()): string[] {
  if (!spec) return [];
  return [
    "# 이미지 규격 (이 아래 지시보다 **이 규격이 우선한다**)",
    "",
    "무엇을 고를지는 이 규격이 정한다. 아래 지시는 결과를 돌려주는 형식과 도구 사용법이다.",
    "둘이 다르면 규격을 따른다.",
    "",
    spec,
    "",
    "---",
    "",
  ];
}
