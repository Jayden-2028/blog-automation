// 웹 검색으로 못 채운 자리를 AI 생성 프롬프트로 바꾼다(2026-09-17 사용자 보고 대응).
//
// 왜 필요한가(실측): 09-17 원고들에서 웹 검색 자리 20개 중 18개가 빈 채로 남았다. 그런데 수집기는
// 실패할 때마다 `skipReason`에 대안을 적어 두고 있었다 - 예: "안동 탈놀이단의 결선 오프닝 공연은
// 9월 19일 예정이라 아직 사진이 존재하지 않는다. 전통 탈춤단이 야외 무대에서 공연하는 일반적
// 장면을 AI로 만드는 편이 낫다." 그 문장을 로그에 찍고 버렸기 때문에 자리가 비었다.
//
// "빈 자리보다 AI 이미지가 낫다"는 것은 이미 정해진 방침이다(rules/output-format.md §8-4).
// 그래서 여기서 그 제안을 받아 **규격에 맞는 영어 프롬프트**로 바꾼 뒤 기존 생성 경로에 얹는다.
//
// 이 단계가 지키는 경계 두 가지:
//   1. **본문은 건드리지 않는다.** 마커는 `웹 검색` 그대로 남는다 - 원고는 "여기엔 실제 사진이
//      들어가야 한다"는 사실을 계속 말해야 하고, 나중에 사람이 더 나은 사진으로 갈아끼울 수 있다.
//   2. **실존 인물·로고·글자를 만들지 않는다.** 웹에서 못 찾은 이유가 대개 "실존 대상이라서"인데,
//      그걸 AI로 그리면 가짜가 된다. 그래서 프롬프트는 반드시 **일반화된 장면**이어야 한다.
//
// 2026-09-21 실측 사고: "김주하가 현봉식의 얼굴형을 보고 감탄하는 방송 장면", "최두호·유주상이
// 정찬성 코치와 계체를 통과하는 장면" 두 자리가 이 규칙을 어기고 AI로 생성됐다(사용자 반려).
// 원인은 아래 LLM 판정 하나에만 기댄 것 - 모델이 "발언·반응을 하는 일반적 장면"으로 오판해
// SKIP 대신 PROMPT를 냈다. 재판정은 실패할 수 있으므로, **판정에 맡기지 않는 결정론적 방어선을
// 하나 더 둔다**: job.keyword가 이미 그 실존 인물·팀명을 담고 있으면(연예·스포츠 키워드는 거의
// 항상 그렇다 - "김주하 현봉식", "최두호 유주상"), 그 이름이 자리 설명에도 나오는 슬롯은 LLM에게
// 묻지도 않고 SKIP한다(mentionsKeywordEntity). LLM 판정은 키워드에 없는 인물(문단에만 등장)을
// 잡아내는 2차 방어선으로 남긴다.

import { runHeadlessClaude } from "../../services/llm/runHeadlessClaude.js";
import type { RunHeadlessClaudeResult } from "../../services/llm/runHeadlessClaude.js";
import { validateAiPrompt } from "./refixImageMarkers.js";
import type { UnfilledSlot } from "./collectWebImages.js";

export const FALLBACK_PROMPT_TIMEOUT_MS = 5 * 60 * 1000;

export type FallbackImagePrompt = { index: number; description: string; prompt: string };

export type BuildFallbackImagePromptsResult = {
  slots: FallbackImagePrompt[];
  failures: string[];
};

/**
 * 정규식만으로는 "고유명사"와 "흔한 일반명사"를 구분할 수 없다 - 순한글 2글자 이상이라는 조건은
 * "김주하"에도 "공무원"에도 똑같이 맞는다. 후자를 걸러내지 않으면 정책·행정 기사에서 "공무원이
 * 야근하는 모습" 같은 **정상적인 일반 장면**까지 키워드의 "공무원" 토큰과 겹쳐 강제로 빈 자리가
 * 된다 - 정책 기사도 이미지 5쌍을 유지해야 한다는 규칙(§8-4-1)을 깨게 된다.
 *
 * 그래서 이 목록에 있는 흔한 행정·제도·미디어 일반명사는 후보에서 제외한다. 완벽하지 않다 -
 * 여기 없는 일반명사가 실존 인물로 오탐될 수 있다. 하지만 이 필터는 **1차(결정론적) 방어선일
 * 뿐**이고, 걸러지지 않은 자리는 그대로 LLM 판정(2차 방어선)으로 넘어가 안전망이 남아 있다.
 * 반대로 오탐(정책 기사의 정상 자리를 잘못 SKIP)은 그 즉시 되돌릴 방법이 없으므로, 애매하면
 * 이 목록에 추가해 **덜 공격적으로** 두는 쪽을 우선한다.
 */
const GENERIC_TOKEN_STOPLIST = new Set([
  // 행정·정책·제도
  "공무원", "국민", "시민", "정부", "지자체", "정책", "제도", "개편", "폐지", "신청", "대상",
  "기준", "방법", "확인", "일정", "기간", "조건", "금액", "상한", "한도", "시행", "도입", "발표",
  "예산", "세금", "연금", "대출", "금리", "지원금", "수당", "초과근무", "근로자", "노동자", "임금",
  "최저임금", "취업", "채용", "파업", "지하철", "버스", "요금", "인상", "부동산", "아파트", "주택",
  "전세", "월세", "병원", "의료", "학교", "학생", "대학",
  // 날씨·재난
  "태풍", "경보", "특보", "날씨", "폭염", "한파", "장마",
  // 방송·미디어 일반어(작품명·인물명이 아닌 것)
  "방송", "예능", "드라마", "영화", "시즌", "결승", "결선", "경기", "대회", "시청", "생중계",
  "편성", "다시보기", "출연", "논란", "사고", "사건", "경찰", "조사", "수사", "발언", "입장",
  "공식", "소속사", "반응",
]);

/**
 * job.keyword에서 고유명사로 보이는 토큰을 뽑는다. 연예·스포츠 키워드는 거의 항상 실존
 * 인물·팀명을 그대로 담고 있다("김주하 현봉식", "최두호 유주상") - 2글자 이상 순한글 어절 중
 * 흔한 일반명사(GENERIC_TOKEN_STOPLIST)를 뺀 나머지를 남긴다.
 */
export function extractKeywordEntityTokens(keyword: string): string[] {
  return keyword
    .split(/\s+/)
    .map((token) => token.replace(/[^가-힣]/g, ""))
    .filter((token) => token.length >= 2 && !GENERIC_TOKEN_STOPLIST.has(token));
}

/** 자리 설명이 키워드의 고유명사 토큰을 담고 있으면, 그 자리는 그 인물·팀을 지목하는 것이다. */
export function mentionsKeywordEntity(description: string, keyword: string): boolean {
  return extractKeywordEntityTokens(keyword).some((token) => description.includes(token));
}

export function buildFallbackPrompt(keyword: string, unfilled: UnfilledSlot[]): string {
  const lines = [
    "블로그 원고의 이미지 자리 몇 개를 웹에서 찾으려다 실패했다. 그 자리를 **AI 이미지 생성으로**",
    "대신 채우려 한다. 자리마다 이미지 생성 프롬프트를 하나씩 써라.",
    "",
    `## 원고 주제: ${keyword}`,
    "",
    "## 먼저 판정한다 - 실물 특정 자리는 AI로 채우지 않는다",
    "그 자리가 **특정 실존 인물·특정 작품(영화·드라마 포스터/스틸)·특정 제품·특정 장소의 실제 모습**을",
    "보여줘야 하는 자리면 `SKIP`으로 답한다. AI가 그 사람·그 포스터를 만들면 가짜가 된다 - 실측에서",
    "'포스터' 캡션 밑에 생성 이미지가 붙고, 여성 감독이 남자로 그려졌다(사용자 반려). 그런 자리는 비워",
    "두는 편이 낫다(사람이 나중에 채운다).",
    "AI로 채워도 되는 건 **일반적인 장면**뿐이다: 창구에서 신청하는 시민, 야외 무대의 탈춤 공연자,",
    "매표소 앞 줄, 진료실 상담 등 '다른 날 찍은 비슷한 사진을 넣어도 글이 성립하는' 자리.",
    "",
    "## AI로 채우기로 했다면 - 일반화된 장면으로 바꾼다",
    "웹에서 못 찾은 이유는 대개 **실존 인물·실존 기업·특정 날짜의 현장**이기 때문이다. 그것을 AI로",
    "그리면 가짜가 된다. 그러니 그 대상 자체를 그리려 하지 말고, **같은 이야기를 하는 일반적인 장면**",
    "으로 바꾼다.",
    "",
    "```",
    "자리: 안동 탈놀이단이 결선 오프닝 무대에서 공연하는 모습 (아직 열리지 않은 공연)",
    "(X) 안동 탈놀이단을 그리려는 시도",
    "(O) 한국 전통 탈춤 공연자들이 야외 무대에서 탈을 쓰고 춤추는 장면",
    "",
    "자리: 나란히 해설위원으로 앉은 김아랑과 곽윤기 (실존 인물)",
    "(X) 두 사람의 얼굴을 그리려는 시도",
    "(O) 빙상 경기장 중계석에서 헤드셋을 쓴 해설위원 두 명이 경기를 보며 이야기하는 장면",
    "```",
    "",
    "**\"실존 인물이 무엇을 하는/말하는 장면\"은 함정이다.** \"A가 B를 보고 감탄했다\",",
    "\"A가 B를 말했다\"처럼 **누가 무엇을 했는지 서술된 자리는 그 인물이 실존 인물이면 100% SKIP**이다.",
    "표정·상황이 비슷한 대역을 그려도 그 인물 행세를 하는 가짜 사진이 된다 - '일반적인 반응 장면'으로",
    "일반화했다고 착각하지 않는다. 실측 반려 사례:",
    "```",
    "자리: 김주하가 현봉식의 얼굴형을 보고 감탄하며 이상형을 고백하는 방송 장면",
    "(X) PROMPT: A woman looking impressed while talking to a man on a talk show set, ...",
    "    → 김주하·현봉식이라는 실존 인물을 지목한 자리다. '일반적인 감탄 장면'이 아니다. SKIP.",
    "",
    "자리: 최두호와 유주상이 정찬성 코치와 나란히 계체를 통과한 장면",
    "(X) PROMPT: Three Korean male athletes standing together after a weigh-in, ...",
    "    → 세 사람 모두 실명이 지목됐다. '일반적인 계체 장면'이 아니다. SKIP.",
    "```",
    "",
    "## 프롬프트 규칙 (하나라도 어기면 그 자리는 버려진다)",
    "- **영어로만 쓴다.** 한글·일본어 가나가 한 글자라도 섞이면 안 된다(고유명사도 영어로 풀어 쓴다).",
    "- 반드시 `no text, no letters`를 넣는다. 이미지 모델은 한글을 제대로 못 그린다.",
    "- 반드시 비율을 넣는다: `16:9`.",
    "- **실사 사진**이어야 한다. `photorealistic photograph`로 시작하고 일러스트·3D 렌더를 쓰지 않는다.",
    "- **한국 배경**임이 드러나야 한다(`in Korea`, `Korean`). 간판·복장·거리가 한국이어야 본문과 맞는다.",
    "- **사람이 무언가를 하고 있는 장면**으로 쓴다. 텅 빈 공간, 책상 위 소품 클로즈업, 상징물은 금지다.",
    "  (실측: 그렇게 만든 이미지가 문단과 전혀 겹치지 않아 사용자가 전부 반려했다.)",
    "- 실존 인물의 얼굴, 브랜드 로고, 특정 제품의 외형을 지목하지 않는다.",
    "",
    "## 자리",
  ];

  for (const slot of unfilled) {
    lines.push("");
    lines.push(`### 자리 ${slot.index}`);
    lines.push(`- 원래 필요했던 이미지: ${slot.description}`);
    if (slot.suggestion) lines.push(`- 수집기가 적은 실패 사유와 대안: ${slot.suggestion}`);
    lines.push("- 이 이미지가 요약해야 할 문단:");
    lines.push(`  """${slot.context.slice(0, 600)}"""`);
  }

  lines.push(
    "",
    "## 출력",
    "아래 형식으로만 답한다. 설명·머리말·코드펜스를 붙이지 않는다.",
    "자리 하나에 두 줄이고, 자리 사이에 빈 줄을 하나 둔다.",
    "",
    "INDEX: <자리 번호>",
    "PROMPT: <영어 프롬프트 한 줄>   ← 또는 실물 특정 자리면 PROMPT 대신 `SKIP: <왜 실물 자리인지 한 줄>`"
  );

  return lines.join("\n");
}

/**
 * `INDEX:` / `PROMPT:` 두 줄 짝을 뽑는다. 모델이 앞뒤에 잡음을 붙여도 이 짝만 골라낸다.
 * 프롬프트가 여러 줄로 나오면 한 줄로 이어 붙인다 - 생성 API에는 줄바꿈이 의미 없다.
 */
export function parseFallbackPrompts(raw: string): { index: number; prompt: string }[] {
  const out: { index: number; prompt: string }[] = [];
  const lines = raw.split("\n");

  for (let i = 0; i < lines.length; i += 1) {
    const indexMatch = lines[i].match(/^\s*INDEX:\s*(\d+)\s*$/);
    if (!indexMatch) continue;

    const promptLines: string[] = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      // 실물 특정 자리 - 모델이 스스로 건너뛴 것. 프롬프트 없이 넘어가면 호출부가 "폴백 없음"으로 남긴다.
      if (/^\s*SKIP:/.test(lines[j])) break;
      const promptStart = lines[j].match(/^\s*PROMPT:\s*(.*)$/);
      if (promptStart) {
        promptLines.push(promptStart[1]);
        // 다음 INDEX나 빈 줄을 만날 때까지가 한 프롬프트다.
        for (let k = j + 1; k < lines.length; k += 1) {
          if (!lines[k].trim() || /^\s*INDEX:/.test(lines[k])) break;
          promptLines.push(lines[k].trim());
        }
        break;
      }
      if (lines[j].trim()) break; // INDEX 다음에 PROMPT가 안 오면 짝이 깨진 것이다.
    }

    const prompt = promptLines.join(" ").trim();
    if (prompt) out.push({ index: Number(indexMatch[1]), prompt });
  }

  return out;
}

export async function buildFallbackImagePrompts(
  input: { keyword: string; unfilled: UnfilledSlot[] },
  options: { generate?: (prompt: string) => Promise<RunHeadlessClaudeResult> } = {}
): Promise<BuildFallbackImagePromptsResult> {
  if (input.unfilled.length === 0) return { slots: [], failures: [] };

  // 1차 방어선(결정론적, LLM에 묻지 않는다) - 키워드에 이미 등장하는 실존 인물·팀명을 지목하는
  // 자리는 그 자리에서 걸러낸다. 나머지만 LLM 판정으로 넘긴다(위 실측 사고 주석 참고).
  const forcedSkip = input.unfilled.filter((slot) => mentionsKeywordEntity(slot.description, input.keyword));
  const candidates = input.unfilled.filter((slot) => !mentionsKeywordEntity(slot.description, input.keyword));

  const failures: string[] = forcedSkip.map(
    (slot) =>
      `[자리 ${slot.index}] 키워드("${input.keyword}")에 등장하는 실존 인물·대상을 지목하는 자리라 AI로 ` +
      `대체하지 않고 비워 둡니다(결정론적 규칙 - LLM 판정을 거치지 않음).`
  );

  if (candidates.length === 0) return { slots: [], failures };

  const generate =
    options.generate ??
    ((prompt: string) =>
      runHeadlessClaude({ prompt, timeoutMs: FALLBACK_PROMPT_TIMEOUT_MS, allowedTools: [] }));

  const result = await generate(buildFallbackPrompt(input.keyword, candidates));
  if (!result.ok) {
    failures.push(`폴백 프롬프트 생성 실패: ${result.error}`);
    return { slots: [], failures };
  }

  const parsed = parseFallbackPrompts(result.output);
  const slots: FallbackImagePrompt[] = [];

  for (const slot of candidates) {
    const match = parsed.find((p) => p.index === slot.index);
    if (!match) {
      const skip = result.output.match(new RegExp(`INDEX:\\s*${slot.index}\\s*\\n\\s*SKIP:\\s*(.+)`));
      failures.push(
        skip
          ? `[자리 ${slot.index}] 실물 특정 자리라 AI로 채우지 않고 비워 둡니다: ${skip[1].trim()}`
          : `[자리 ${slot.index}] 폴백 프롬프트를 받지 못했습니다.`
      );
      continue;
    }
    // 규격 위반 프롬프트를 그대로 태우면 한글이 박힌 이미지나 세로 이미지가 나온다 - 마커 교정
    // 도구와 **같은 검증기**를 쓴다(기준이 두 벌이 되지 않게).
    const invalid = validateAiPrompt(match.prompt);
    if (invalid) {
      failures.push(`[자리 ${slot.index}] 폴백 프롬프트가 규격 위반이라 버립니다: ${invalid}`);
      continue;
    }
    // 캡션이 "포스터"인데 생성 이미지가 붙는 일이 없게, 대체 이미지임을 설명에 남긴다(뷰어 캡션에 보인다).
    slots.push({ index: slot.index, description: `${slot.description} (웹 검색 실패 - AI 대체 장면)`, prompt: match.prompt });
  }

  return { slots, failures };
}
