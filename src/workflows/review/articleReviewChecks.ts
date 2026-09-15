// 원고 자동 검수 규칙 4종(SPRINT_3_DESIGN.md 4절): 팩트 / 법적 / 광고 / 품질.
//
// 규칙 기반인 이유(설계 5절): 원고 1건에 이미 LLM을 두 번 쓴다(조사 요약 ~30초, 원고 생성 ~180초).
// 아래 항목은 전부 결정적 규칙으로 핵심을 잡을 수 있고, 규칙은 비용 0에 테스트로 고정되며 "왜
// 걸렸는지"를 정확히 지목할 수 있다.
//
// ⚠️ 결과는 차단이 아니라 참고다(설계 6절). 오탐률 데이터가 0인 상태에서 차단하면 멀쩡한 원고가
// 조용히 사라진다. 특히 팩트 검사는 "틀렸다"가 아니라 "근거에서 확인되지 않았다"까지만 말한다 -
// 표기 정규화로도 못 맞추는 경우가 남기 때문이다(normalizeFactTokens.ts 참고).

import { TARGET_ARTICLE_LENGTH, HASHTAG_COUNT } from "../writing/buildArticlePrompt.js";
import { buildFactCorpus, extractFactTokens } from "./normalizeFactTokens.js";
import type { ArticleRow, SourceRow } from "../../types/database.js";

export type ReviewSeverity = "error" | "warning";
export type ReviewCategory = "fact" | "legal" | "ad" | "quality";

export type ReviewCheck = {
  category: ReviewCategory;
  severity: ReviewSeverity;
  /** 사람이 읽을 한 줄 설명. Telegram 알림에 그대로 들어간다. */
  message: string;
};

/**
 * "참고 자료" 섹션 이후를 잘라낸다.
 *
 * 왜 필요한가(2026-08-28 실측): 참고 자료의 링크 제목은 우리가 쓴 문장이 아니라 인용한 출처의
 * 제목이다. 아이폰18 원고에서 "[아이폰18 출시일·가격·폴더블 루머 총정리]"라는 출처 제목 때문에
 * 법적 검사가 "루머"를 잡았는데, 그건 우리 원고의 추측성 표현이 아니라 남의 글 제목이다.
 * 팩트 검사도 마찬가지로 링크 제목의 숫자("2026~2027 신제품")를 우리 주장으로 오인한다.
 */
function stripReferencesSection(body: string): string {
  // 헤더가 "## 참고 자료"(구식)와 "**참고 자료**"(2026-09-06부터, writer.md §6) 둘 다 나올 수 있다.
  const match = body.match(/^(#{1,3}\s*|\*\*)참고\s*자료(\*\*)?/m);
  return match?.index === undefined ? body : body.slice(0, match.index);
}

// ---------- 팩트 ----------

/** 본문에서 걸러낼 토큰 수 상한. 전부 나열하면 알림이 읽을 수 없게 길어진다. */
const MAX_REPORTED_FACTS = 5;

/**
 * 작성일 허용 오차(일). 본문의 "이 글은 2026년 8월 27~28일에 나온 뉴스를 정리했습니다" 같은
 * 문구는 COMMON_RULES가 요구한 것이라 매번 나오는데, 근거 수집일과 저장 시각이 하루 이틀
 * 어긋날 수 있어 정확히 하루만 허용하면 그대로 오탐이 된다(2026-08-28 실측에서 발생).
 */
const WRITE_DATE_TOLERANCE_DAYS = 3;

export type CheckFactsInput = {
  article: Pick<ArticleRow, "content" | "created_at">;
  sources: ReadonlyArray<Pick<SourceRow, "content">>;
};

/** 작성일 전후 며칠을 허용 목록에 넣는다. 우리가 만든 날짜이지 근거에서 온 주장이 아니다. */
function addWriteDateWindow(corpus: Set<string>, createdAt: string | null | undefined): void {
  if (!createdAt) return;
  const base = new Date(createdAt);
  if (Number.isNaN(base.getTime())) return;

  for (let offset = -WRITE_DATE_TOLERANCE_DAYS; offset <= WRITE_DATE_TOLERANCE_DAYS; offset++) {
    const day = new Date(base);
    day.setUTCDate(day.getUTCDate() + offset);
    const iso = day.toISOString().slice(0, 10);
    corpus.add(iso);
    corpus.add(iso.slice(5)); // MM-DD 형태도 함께
  }
}

/**
 * 본문의 날짜·금액·수치가 근거에 있는지 본다.
 *
 * 원고 작성일을 corpus에 미리 넣는 이유(2026-08-28 실측): COMMON_RULES가 "이 글이 작성된 시점
 * 기준 정보임을 밝힌다"를 요구하므로 본문에는 항상 작성일이 들어간다. 그 날짜는 근거에서 온 게
 * 아니라 우리가 만든 것이라 매번 미검출로 걸렸다 - 모든 원고에서 반복되는 오탐이라 제외한다.
 */
export function checkFacts(input: CheckFactsInput): ReviewCheck[] {
  if (!input.article.content) return [];
  const body = stripReferencesSection(input.article.content);

  const corpus = buildFactCorpus(input.sources.map((s) => s.content));
  addWriteDateWindow(corpus, input.article.created_at);

  const unverified = extractFactTokens(body).filter((token) => !corpus.has(token.normalized));
  if (unverified.length === 0) return [];

  // 같은 표기가 여러 정규형으로 잡힐 수 있다(연도 있는 날짜는 YYYY-MM-DD와 MM-DD 둘 다 만든다).
  // 사람에게 보여줄 때는 원문 표기 기준으로 한 번만 남긴다.
  const uniqueRaws = [...new Set(unverified.map((t) => t.raw))];

  const shown = uniqueRaws.slice(0, MAX_REPORTED_FACTS).map((raw) => `"${raw}"`).join(", ");
  const more = uniqueRaws.length > MAX_REPORTED_FACTS ? ` 외 ${uniqueRaws.length - MAX_REPORTED_FACTS}건` : "";

  return [
    {
      category: "fact",
      severity: "error",
      message: `근거에서 확인되지 않은 수치·날짜: ${shown}${more}`,
    },
  ];
}

// ---------- 법적 ----------

// 형법 307조 리스크(로드맵 §6-2). 한국은 사실을 적시해도 명예훼손이 성립할 수 있다.
const SPECULATIVE_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /의혹/g, label: "의혹" },
  { pattern: /루머/g, label: "루머" },
  { pattern: /카더라/g, label: "카더라" },
  { pattern: /로\s*보인다/g, label: "~로 보인다" },
  { pattern: /한\s*듯하다|인\s*듯하다/g, label: "~한 듯하다" },
  // "~다는 설"이 "~라는 설"보다 흔하므로 둘 다 본다.
  // "설" 뒤를 막을 때는 낱말을 이루는 음절만 제외한다(설명/설정/설치/설립/설계...). 조사가 붙는
  // "설이 돌고 있다"는 진짜 소문 표현이므로 잡혀야 한다 - `(?![가-힣])`로 막으면 이것까지 놓친다.
  // 오탐 사례: "이라는 설명이 올라와 있었고"(2026-08-28, 셔더링어택 원고).
  { pattern: /[다라]는\s*설(?![명정치립계문비사])/g, label: "~라는 설" },
  { pattern: /으로\s*추정된다|로\s*추정된다/g, label: "~로 추정된다" },
  { pattern: /가능성이\s*크다|가능성이\s*높다/g, label: "가능성이 크다" },
];

/**
 * 추측성 표현을 찾는다. 인물이 함께 등장하면 심각도를 올린다 - 제품 기사의 "~로 예상된다"는
 * 정당하지만 인물 관련에서는 명예훼손 위험이 된다(설계 4-2절).
 *
 * 인물 판정은 category로만 한다. 본문에서 인명을 뽑는 건 형태소 분석 없이는 오탐이 너무 많고,
 * 그 비용이 얻는 것보다 크다(팩트 검사에서 고유명사를 뺀 것과 같은 이유).
 */
export function checkLegal(rawBody: string | null, category: string | null): ReviewCheck[] {
  if (!rawBody) return [];
  // 참고 자료의 링크 제목은 남의 글 제목이지 우리 원고의 표현이 아니다(stripReferencesSection 주석).
  const body = stripReferencesSection(rawBody);

  const found = SPECULATIVE_PATTERNS.filter(({ pattern }) => {
    pattern.lastIndex = 0;
    return pattern.test(body);
  }).map(({ label }) => label);

  if (found.length === 0) return [];

  // 인물을 주로 다루는 분야에서는 error, 그 외에는 warning.
  const isPersonHeavy = category === "entertainment";

  return [
    {
      category: "legal",
      severity: isPersonHeavy ? "error" : "warning",
      message:
        `추측성 표현 ${found.length}종: ${found.join(", ")}` +
        (isPersonHeavy ? " (연예 분야는 명예훼손 위험이 커 확정 보도만 다뤄야 합니다)" : ""),
    },
  ];
}

// ---------- 광고 ----------

const PAID_CONTENT_HINTS = /협찬|제공받아|제공 받아|원고료|무상\s*제공|대가를\s*받/;
const DISCLOSURE_HINTS = /#협찬|#광고|소정의\s*대가|유료\s*광고|협찬을?\s*받았음/;

/**
 * 대가성 문구가 있는데 표시가 없으면 걸러낸다.
 *
 * 지금은 협찬 원고를 만들지 않아 발화할 일이 거의 없다. 그래도 두는 이유는 나중에 협찬이 생겼을
 * 때 이 검사가 없으면 표시광고법 위반이 조용히 나가기 때문이다 - 비용이 거의 없는 보험이다.
 */
export function checkAdDisclosure(body: string | null): ReviewCheck[] {
  if (!body) return [];
  if (!PAID_CONTENT_HINTS.test(body)) return [];
  if (DISCLOSURE_HINTS.test(body)) return [];

  return [
    {
      category: "ad",
      severity: "error",
      message: "대가성 문구가 있는데 협찬/광고 표시가 없습니다 (표시광고법)",
    },
  ];
}

// ---------- 품질 ----------

export type CheckQualityInput = {
  title: string | null;
  body: string | null;
  hashtags: ReadonlyArray<string>;
  isMedical: boolean;
};

/** 문장 단위로 나눈다. 중복 문장 검사에 쓴다. */
function splitSentences(body: string): string[] {
  return body
    .split(/(?<=[.!?。])\s+|\n/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 15); // 너무 짧은 조각(제목, 목록 항목)은 중복이어도 자연스럽다
}

/** 제목에서 검색 의도를 담은 어절만 남긴다. 조사·기호는 일치 판정에 방해가 된다. */
function titleKeywords(title: string): string[] {
  return title
    .split(/[\s·,|:：\-–—()[\]]+/)
    .map((w) => w.replace(/[^가-힣a-zA-Z0-9]/g, ""))
    .filter((w) => w.length >= 2);
}

export function checkQuality(input: CheckQualityInput): ReviewCheck[] {
  const checks: ReviewCheck[] = [];
  const body = input.body;

  if (!body) {
    return [{ category: "quality", severity: "error", message: "본문이 비어 있습니다" }];
  }

  // 분량 - writer.md §6-5 기준은 "본문"이다. 참고 자료 목록·해시태그·이미지 마커·공백은 빼고
  // 실제 산문 길이만 잰다(그것들을 포함하면 항상 목표를 넘는다).
  const prose = stripReferencesSection(body)
    .replace(/^#+\s.*$/gm, "") // ## 소제목(구식)
    .replace(/^\*\*[^*]+\*\*$/gm, "") // **소제목** 볼드 단독 줄(2026-09-06부터)
    .replace(/^#[^\s#].*$/gm, "") // #해시태그 줄
    .replace(/\[IMAGE[^\]]*\]/gi, "") // [IMAGE: ...] 마커
    .replace(/\s+/g, "");
  const length = prose.length;
  if (length < TARGET_ARTICLE_LENGTH.min || length > TARGET_ARTICLE_LENGTH.max) {
    checks.push({
      category: "quality",
      severity: "warning",
      message: `분량 ${length.toLocaleString()}자 (목표 ${TARGET_ARTICLE_LENGTH.min.toLocaleString()}~${TARGET_ARTICLE_LENGTH.max.toLocaleString()}, 공백·목록 제외)`,
    });
  }

  // 참고 자료 섹션 - COMMON_RULES가 요구하는 항목이라 없으면 규칙 위반이다.
  // URL은 마크다운 링크와 평문 둘 다 인정한다: 모델이 "- 나무위키: https://..." 형태로 쓰는
  // 경우가 실제로 있었고(2026-08-28, 재혼황후 원고), 그건 출처 표기로서 충분하다.
  if (!/참고\s*자료/.test(body) || !/https?:\/\//.test(body)) {
    checks.push({
      category: "quality",
      severity: "error",
      message: "참고 자료 섹션 또는 출처 링크가 없습니다",
    });
  }

  // 제목-본문 일치
  if (input.title) {
    const keywords = titleKeywords(input.title);
    const missing = keywords.filter((word) => !body.includes(word));
    // 절반 이상이 본문에 없으면 제목과 본문이 겉도는 것으로 본다.
    if (keywords.length > 0 && missing.length > keywords.length / 2) {
      checks.push({
        category: "quality",
        severity: "warning",
        message: `제목의 핵심 어절이 본문에 거의 없습니다: ${missing.slice(0, 3).join(", ")}`,
      });
    }
  }

  // 중복 문장
  const sentences = splitSentences(body);
  const counts = new Map<string, number>();
  for (const sentence of sentences) counts.set(sentence, (counts.get(sentence) ?? 0) + 1);
  const duplicated = [...counts.entries()].filter(([, count]) => count > 1);
  if (duplicated.length > 0) {
    checks.push({
      category: "quality",
      severity: "warning",
      message: `중복 문장 ${duplicated.length}건: "${duplicated[0][0].slice(0, 30)}…"`,
    });
  }

  // 해시태그 - 코드가 붙이므로 실패할 일이 없어 보이지만, 붙이는 코드가 깨져도 조용히 지나가지
  // 않게 검사를 둔다(설계 4-4절).
  if (input.hashtags.length !== HASHTAG_COUNT) {
    checks.push({
      category: "quality",
      severity: "warning",
      message: `해시태그 ${input.hashtags.length}개 (기대 ${HASHTAG_COUNT}개)`,
    });
  }

  // 의학 고지 - buildMedicalDisclaimer가 붙이는 문구가 실제로 본문에 있는지 확인한다.
  if (input.isMedical && !/전문의와\s*상담/.test(body)) {
    checks.push({
      category: "quality",
      severity: "error",
      message: "의학 주제인데 전문의 상담 안내가 없습니다",
    });
  }

  return checks;
}

// ---------- 인용/헤지 문체 (2026-09-15) ----------
//
// writer.md §4/§4-1/§4-2가 금지하는 세 가지 패턴을 규칙으로 한 번 더 잡는다. 프롬프트 준수만으로는
// 부족하다는 게 실측으로 나왔다(CURRENT_STATE.md 2026-09-15, "경복궁 구멍 뚫기" 원고) - writer.md가
// 620줄을 넘어가면서 §4-1/§4-2에 예시까지 박아뒀는데도 모델이 놓친 사례가 나왔다. 여기 걸려도
// 차단은 아니고 다른 검사와 같이 참고용이다(설계 6절과 동일한 원칙).

/** "보도에 따르면"류 인용 표시. §4 표는 처음 1회는 자연스럽다고 허용하므로 2회 이상만 문제다. */
const REPEATED_ATTRIBUTION_PATTERN = /라고\s*보도(?:됐|했|되었|하였)|보도에\s*따르면|라고\s*전(?:해졌|했)/g;

/** 보도 경위(누가 언제·몇 곳이 보도했는지) 서술. §4-2. */
const COVERAGE_NARRATIVE_PATTERN =
  /인용해\s*전(?:한|했)|취재진이\s*확보|함께\s*보도(?:했|됐)|보도로\s*확산|이어\s*[^.!?\n]{0,12}보도(?:했|됐)/g;

/**
 * 부분 데이터 갭을 대조로 알리는 문장. §4-1.
 * "아직 공개되지 않았습니다"처럼 승인된 단일 서술은 안 걸리게, 대조를 만드는
 * "별도로/따로/구체적으로 + 안 나왔다" 조합만 잡는다(오탐 축소 - 2026-09-15 실측 문구 기준).
 */
const PARTIAL_GAP_CONTRAST_PATTERN = /(?:별도로|따로|구체적으로)\s*(?:나오지|제시되지|확인되지|언급되지)\s*않았/g;

/** 참고 자료 이후는 남의 글 링크 제목이라 대상이 아니다(stripReferencesSection과 같은 이유). */
export function checkAttributionHedging(rawBody: string | null): ReviewCheck[] {
  if (!rawBody) return [];
  const body = stripReferencesSection(rawBody);
  const checks: ReviewCheck[] = [];

  const attributionMatches = body.match(REPEATED_ATTRIBUTION_PATTERN);
  if (attributionMatches && attributionMatches.length >= 2) {
    checks.push({
      category: "quality",
      severity: "warning",
      message: `"보도에 따르면/~라고 보도했다"류 인용 표현이 ${attributionMatches.length}회 반복됩니다(writer.md §4 - 1회만 자연스럽게 허용)`,
    });
  }

  // 전역(g) 정규식의 lastIndex는 .test() 호출 사이에 상태가 남는다 - 매번 0으로 되돌린다
  // (checkLegal의 SPECULATIVE_PATTERNS와 같은 이유).
  COVERAGE_NARRATIVE_PATTERN.lastIndex = 0;
  if (COVERAGE_NARRATIVE_PATTERN.test(body)) {
    checks.push({
      category: "quality",
      severity: "warning",
      message: "보도 경위(어느 매체가 언제·몇 곳 보도했는지)를 본문에 서술한 것으로 보입니다(writer.md §4-2)",
    });
  }

  PARTIAL_GAP_CONTRAST_PATTERN.lastIndex = 0;
  if (PARTIAL_GAP_CONTRAST_PATTERN.test(body)) {
    checks.push({
      category: "quality",
      severity: "warning",
      message: '자료에 없는 항목을 "별도로/따로 나오지 않았다"처럼 대조해서 언급한 것으로 보입니다(writer.md §4-1)',
    });
  }

  return checks;
}
