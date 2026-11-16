// 카테고리별 verdict 판정 테스트(2026-10-31). LLM·네트워크·DB 없음.
//
// 배경(10월 351건 실측): 옛 단일 기준("official+medical ≥ 2, 전체 ≥ 8")은 엔터처럼 공식 출처가
// 존재할 수 없는 주제에서 구조적으로 통과 불가였다 - 엔터 85건 중 79건이 공식 0건, 99%가 thin.
// 그래서 351건 중 306건(85%)이 thin이 됐고, 신호가 소음이 됐다.

import { computeResearchVerdict, reconcileVerdict, verdictProfileFor } from "./computeResearchVerdict.js";
import { stampResearchVerdict } from "../writing/runArticleJob.js";
import { parseResearchFile } from "./parseResearchFile.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const counts = (official: number, news: number, community: number, medical = 0) => ({
  official,
  medical,
  news,
  community,
});

// ── 1. 프로파일 분류 ──────────────────────────────────────────────
{
  assert(verdictProfileFor("entertainment") === "news", "엔터는 news 프로파일");
  assert(verdictProfileFor("ott") === "news", "OTT는 news 프로파일");
  assert(verdictProfileFor("person") === "news", "인물은 news 프로파일");
  assert(verdictProfileFor("kscene") === "official", "사용설명서는 official 프로파일");
  assert(verdictProfileFor("incident") === "official", "사건은 official 프로파일");
  assert(verdictProfileFor(null) === "official", "카테고리가 없으면 official 프로파일(보수적)");
}

// ── 2. 엔터: 공식 0이어도 교차확인된 뉴스면 ok ────────────────────
{
  // 실측 평균에 가까운 엔터 조사: 공식 0 · 뉴스 7 · 커뮤니티 10
  const v = computeResearchVerdict({ counts: counts(0, 7, 10), category: "entertainment" });
  assert(v === "ok", `엔터는 뉴스 교차확인으로 ok여야 한다 (실제: ${v})`);

  // 같은 숫자라도 official 프로파일(사용설명서)은 공식이 없으면 thin 그대로다.
  const k = computeResearchVerdict({ counts: counts(0, 7, 10), category: "kscene" });
  assert(k === "thin", `사용설명서는 공식 없으면 thin (실제: ${k})`);
}

// ── 3. 뉴스가 모자라면 엔터도 thin ────────────────────────────────
{
  const v = computeResearchVerdict({ counts: counts(0, 2, 12), category: "entertainment" });
  assert(v === "thin", `뉴스 2건은 교차확인 부족 - thin (실제: ${v})`);
}

// ── 4. 공식 2건 + 전체 8건이면 어느 카테고리든 ok ─────────────────
{
  for (const cat of ["entertainment", "kscene", "incident", null]) {
    const v = computeResearchVerdict({ counts: counts(2, 3, 4), category: cat });
    assert(v === "ok", `${cat}: 공식 2 + 전체 9면 ok (실제: ${v})`);
  }
}

// ── 5. blocked가 thin보다 먼저다(옛 순서 버그) ────────────────────
{
  // 전체 4건(< 5)인데 뉴스가 3건. 옛 코드는 thin을 돌려줬다 - 규격은 blocked다.
  const v = computeResearchVerdict({ counts: counts(0, 3, 1), category: "entertainment" });
  assert(v === "blocked", `전체 5건 미만은 blocked (실제: ${v})`);

  const allCommunity = computeResearchVerdict({ counts: counts(0, 0, 12), category: "entertainment" });
  assert(allCommunity === "blocked", "전부 커뮤니티면 blocked");
}

// ── 6. 의료는 1차 근거 2건 미만이면 blocked ───────────────────────
{
  const v = computeResearchVerdict({ counts: counts(1, 9, 9), category: "living", isMedical: true });
  assert(v === "blocked", `의료는 공식·의학 2건 미만이면 blocked (실제: ${v})`);

  const okMedical = computeResearchVerdict({ counts: counts(1, 5, 5, 1), category: "living", isMedical: true });
  assert(okMedical === "ok", `공식1+의학1=2면 통과 (실제: ${okMedical})`);
}

// ── 7. 오기 교정 ──────────────────────────────────────────────────
{
  // 10월 실측 31건 유형: 숫자로는 ok인데 파일에 thin이라고 적은 경우.
  const r = reconcileVerdict("thin", { counts: counts(3, 4, 6), category: "kscene" });
  assert(r.verdict === "ok" && r.corrected && r.written === "thin", `오기를 교정해야 한다 (${JSON.stringify(r)})`);

  const same = reconcileVerdict("ok", { counts: counts(3, 4, 6), category: "kscene" });
  assert(same.verdict === "ok" && !same.corrected, "일치하면 corrected=false");
}

// ── 8. 고친 판정이 집필 단계까지 닿는다(2026-11-16 감사 F1) ──────
//
// 감사가 지적한 공백: 7번은 "코드가 고친다"까지만 봤고, 그 값이 **집필 러너가 읽는 파일**에
// 반영되는지는 아무 테스트도 보지 않았다. 11/15에 실제로 집필 2건이 멈춘 자리다.
{
  const body = [
    "---",
    "keyword: 테스트 키워드",
    "verdict: blocked        # ok | thin | blocked",
    "---",
    "",
    "## 1. 요약",
    "본문",
  ].join("\n");

  // 뉴스 9·커뮤니티 11 = 11/15 첫 사고(김민석 최민희 윤리심판원 - official 프로파일)와 같은 조건.
  // 전체 20건이라 blocked 조건에 못 미치고, 공식 0건이라 ok도 아니다 -> thin.
  const r = reconcileVerdict("blocked", { counts: counts(0, 9, 11), category: "incident" });
  assert(r.verdict === "thin" && r.corrected, `뉴스 9·커뮤니티 11(official 프로파일)은 thin이어야 한다 (${JSON.stringify(r)})`);

  const stamped = stampResearchVerdict(body, r.verdict);
  assert(stamped !== null, "고친 값이 다르면 파일을 되쓴다");
  // 집필 에이전트는 파일을 파서가 아니라 눈으로 읽지만, 계약은 frontmatter 한 줄이다.
  assert(parseResearchFile(stamped as string).verdict === "thin", "복원된 파일의 verdict가 thin이다");
  assert(!/blocked/.test(stamped as string), "옛 값(blocked)이 파일에 남아 있으면 writer.md §12가 또 멈춘다");
  assert((stamped as string).includes("## 1. 요약"), "본문은 그대로 보존한다");

  assert(stampResearchVerdict(stamped as string, "thin") === null, "같은 값이면 되쓰지 않는다(파일 mtime 보존)");
  assert(stampResearchVerdict("frontmatter 없는 파일", "thin") === null, "frontmatter가 없으면 건드리지 않는다");

  // 진짜 blocked는 그대로 막혀야 한다 - 이 수정이 조사 품질 게이트를 여는 것이 아니다.
  const stillBlocked = reconcileVerdict("blocked", { counts: counts(0, 0, 12), category: "incident" });
  assert(stillBlocked.verdict === "blocked" && !stillBlocked.corrected, "전부 커뮤니티면 blocked 유지");
  const thin4 = reconcileVerdict("thin", { counts: counts(0, 3, 1), category: "incident" });
  assert(thin4.verdict === "blocked", "전체 5건 미만은 blocked로 내려간다");

  // verdict 줄이 없는 파일에도 끼워 넣는다(§7 템플릿을 어긴 산출물).
  const noVerdict = ["---", "keyword: k", "---", "", "본문"].join("\n");
  const inserted = stampResearchVerdict(noVerdict, "thin");
  assert(inserted !== null && /^verdict: thin$/m.test(inserted), "verdict 줄이 없으면 넣는다");
  assert(inserted !== null && inserted.indexOf("verdict:") < inserted.indexOf("본문"), "본문이 아니라 frontmatter 안에 넣는다");
}

console.log("✅ computeResearchVerdict: 카테고리 분기·blocked 우선·의료 규칙·오기 교정 + 집필 전달 통과");
