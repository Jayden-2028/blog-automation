// 자료조사 파일의 출처 건수로 "어떤 자료가 모자란지"를 한 줄로 말한다. researcher.md verdict 판정
// 기준과 같다: 전체 5건 미만 / 공식·언론 없이 커뮤니티뿐 / 법률·금융·의료 주제는 공식 자료 2건 이상.
// 실패 알림(notifyWriteFailed)과 재조사 프롬프트(buildResearchPrompt)가 같은 문장을 쓴다.

import { parseResearchFile } from "./parseResearchFile.js";

/** 조사 파일이 없거나 모자란 점이 없으면 null. */
export function describeShortage(researchText: string | null | undefined): string | null {
  if (!researchText || researchText.trim().length === 0) return null;
  const { official, medical, news, community } = parseResearchFile(researchText).sourceCounts;
  const total = official + medical + news + community;
  const authoritative = official + medical;
  if (total < 5) return `찾은 자료가 ${total}건뿐이에요.`;
  if (official + medical + news === 0) return "공식 자료나 언론 기사 없이 커뮤니티 글뿐이에요.";
  if (authoritative < 2) return `공식 자료(공공기관·법원 등)가 ${authoritative}건뿐이에요. 2건 이상 있어야 해요.`;
  return null;
}
