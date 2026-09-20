// 발행 전 본문 정리 테스트(2026-09-20). 실제 발행 사고에서 나온 문자열을 그대로 쓴다.
import { sanitizeArticleBody, stripTrailingMeta } from "./sanitizeArticleBody.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const REFERENCES = [
  "**요약**",
  "해외 팬이 겪는 어려움은 여러 층이 겹친 결과입니다.",
  "",
  "**참고 자료**",
  "- [세계일보](https://www.segye.com/newsView/20260919500443)",
  "- [경향신문](https://www.khan.co.kr/article/202606252051005/)",
].join("\n");

// 1) 실제 유출 사례 - 참고 자료 뒤 `---` 아래 작업 노트.
{
  const leaked = `${REFERENCES}\n\n---\n분량은 공백·이미지마커·참고자료 제외 약 2,200자로 2,000~3,000자 범위 안입니다. 진입점을 "겪는 장벽 → 원인" 순으로 재구성해 기준 원고와 소제목·서술 순서를 다르게 잡았고, 연속 3어절 이상 겹치는 구간이 없도록 문장을 다시 짰습니다. 이미지 마커 6개는 기준 원고의 위치·설명을 그대로 옮겼습니다.`;
  const cleaned = stripTrailingMeta(leaked);
  assert(!cleaned.includes("분량은"), `작업 노트가 남았다: ${cleaned.slice(-120)}`);
  assert(cleaned.endsWith("(https://www.khan.co.kr/article/202606252051005/)"), `참고 자료 목록이 끝까지 남아야 한다: ${cleaned.slice(-80)}`);
  console.log("✅ 참고 자료 뒤 `---` 작업 노트 제거(실제 유출 문자열)");
}

// 2) 군말이 없으면 한 글자도 건드리지 않는다.
{
  assert(stripTrailingMeta(REFERENCES) === REFERENCES, "정상 본문을 잘라내면 안 된다");
  console.log("✅ 정상 본문은 그대로");
}

// 3) 참고 자료 안의 `- [...]` 항목은 구분선이 아니다(오탐 방지).
{
  const withDash = `${REFERENCES}\n- [ZDNet](https://zdnet.co.kr/view/?no=1)`;
  assert(stripTrailingMeta(withDash) === withDash, "링크 목록을 구분선으로 오인하면 안 된다");
  console.log("✅ 링크 목록을 구분선으로 오인하지 않는다");
}

// 4) 참고 자료가 없는 본문 - 낱말로 잡는다.
{
  const noRefs = "본문입니다.\n\n---\n기준 원고와 소제목을 다르게 잡았고 분량은 2,200자입니다.";
  assert(stripTrailingMeta(noRefs) === "본문입니다.", `참고 자료가 없어도 잘라야 한다: ${stripTrailingMeta(noRefs)}`);
  console.log("✅ 참고 자료 없는 본문도 작업 노트 제거");
}

// 5) 예전 유형("점검 결과")도 계속 잡는다.
{
  const old = "본문입니다.\n\n**점검 결과**\n- 분량 확인";
  assert(stripTrailingMeta(old) === "본문입니다.", `구 패턴도 유지돼야 한다: ${stripTrailingMeta(old)}`);
  console.log("✅ 구 패턴(점검 결과) 유지");
}

// 6) `---`이 있어도 그 아래가 독자용 문장이면 남긴다(참고 자료 없는 본문).
{
  const legit = "본문입니다.\n\n---\n오늘도 좋은 하루 보내세요.";
  assert(stripTrailingMeta(legit) === legit, "독자용 맺음말을 잘라내면 안 된다");
  console.log("✅ 독자용 맺음말은 보존");
}

// --- 기준 시점 고지(원고 전체에 거는 면피 문장) --------------------------------------------------
{
  const cases = [
    "여기 정리한 내용은 2026년 9월 기준입니다.",
    "여기 정리한 내용은 2026년 9월 19일 시점 기준입니다.",
    "이 정리는 2026년 9월 18일 기준입니다.",
  ];
  for (const sentence of cases) {
    const body = `본문 마지막 문단입니다.\n\n${sentence}`;
    assert(sanitizeArticleBody(body) === "본문 마지막 문단입니다.", `고지가 남았다: ${JSON.stringify(sanitizeArticleBody(body))}`);
  }
  console.log("✅ 원고 전체 기준 시점 고지 제거");
}

// 같은 문단에 독자용 문장이 이어지면 그 문장은 살린다.
{
  const body = "여기 정리한 내용은 2026년 9월 19일 기준입니다. 이후 근황은 두 사람이 각자 채널에 올릴 때마다 전해질 것입니다.";
  const cleaned = sanitizeArticleBody(body);
  assert(cleaned === "이후 근황은 두 사람이 각자 채널에 올릴 때마다 전해질 것입니다.", `뒤 문장이 사라졌다: ${JSON.stringify(cleaned)}`);
  console.log("✅ 고지만 빼고 뒤따르는 문장은 보존");
}

// 값에 붙은 기준은 건드리지 않는다 - 이건 규칙이 요구하는 서술이다.
{
  const keep = [
    "친조카는 50만원에서 100만원 사이가 일반적인 기준입니다.",
    "인터파크(NOL 티켓) 예매 페이지 기준이에요.",
    "2015년 1월 8일부터 시행된 기준이고, 그전에는 개소 수를 따로 정해두지 않았고요.",
    "2026년 8월 기준 지원금은 30만 원입니다.",
  ];
  for (const sentence of keep) {
    assert(sanitizeArticleBody(sentence) === sentence, `값에 붙은 기준을 지우면 안 된다: ${sentence}`);
  }
  console.log("✅ 값에 붙은 기준 시점은 보존");
}

console.log("\n🎉 본문 정리 테스트 통과");
