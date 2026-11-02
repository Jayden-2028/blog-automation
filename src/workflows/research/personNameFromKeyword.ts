// 키워드에서 인물명을 뽑는다(2026-11-02). 소스팩이 나무위키·인물DB를 못 열던 진짜 원인.
//
// 무엇이 고장이었나: `collectPersonSourcePacks`가 `fetchPersonSourcePack(job.keyword)`로 **키워드 전문을
// 그대로** URL에 넣었다. 버튼 경로(19시 핫이슈 스타 `✍️ 인물글`)는 키워드가 인물명 한 단어라 잘 돌았고,
// 수동 입력 경로(`source: keyword_input`)는 키워드가 문장이라 전부 404였다. 실측(2026-11-02):
//
// | 키워드 | 나무위키 |
// |---|---|
// | `오윤아` · `백진희` · `이다해` · `현아` | 200 (5,908~15,904자) |
// | `배우 서현진의 모든 것` | **404** |
// | `박정민 시각장애인 위해 오디오북 기증` | **404** |
// | `100일의 거짓말에서 나오는 친일파의 고명딸 박정연은 누구?` | **404** |
//
// 차단이 아니다 - 맥에서 `namu.wiki/w/서현진`은 200이고 `namu.wiki/w/배우 서현진의 모든 것`만 404다.
// 그래서 이 모듈이 키워드를 후보 이름들로 쪼개고, 네이버 인물 카드가 있는 것을 인물명으로 고른다.
//
// 순수 함수(`personNameCandidates`)와 조회(`resolvePersonName`)를 나눠 둔 이유는 후보 생성 규칙만
// 테스트로 고정하기 위해서다 - 네트워크 없이 돌아간다.

/** 후보 최대 개수. 수동 키워드가 길어도 인물 카드 조회를 무한정 돌리지 않는다. */
export const MAX_NAME_CANDIDATES = 6;

/**
 * 토큰 끝에 붙는 조사·호칭. 긴 것부터 지운다("에서"가 "서"보다 먼저).
 * 이름 자체가 이 글자로 끝나는 경우(예: `한가인`의 `인`)는 **끝 글자 하나만 지우면 2글자 미만이 되는
 * 경우를 제외**하는 식으로 보호하지 않는다 - 지운 뒤 원본도 후보에 남기기 때문이다.
 */
const PARTICLES = ["에서", "에게", "이랑", "하고", "으로", "처럼", "까지", "부터", "은", "는", "이", "가", "의", "을", "를", "와", "과", "도", "만", "에", "로", "씨", "님"];

/**
 * 이름이 아닌 것이 거의 확실한 2~4글자 한글. 넣는 기준은 **나무위키에 문서가 있어 오탐이 되는 말**이다
 * (`친일파`·`거짓말`은 실제로 문서가 있다). 직군 명사도 여기 둔다 - `배우 서현진`에서 `배우`가 먼저
 * 걸리면 안 된다.
 */
const STOPWORDS = new Set([
  // 직군·수식
  "배우", "가수", "감독", "모델", "작가", "선수", "코치", "아이돌", "방송인", "개그맨", "코미디언",
  "연예인", "유튜버", "셀럽", "스타", "신인", "주연", "조연", "출연", "소속사", "데뷔",
  // 글의 성격을 가리키는 말
  "누구", "모든", "전부", "정체", "프로필", "근황", "과거", "현재", "최근", "오늘", "어제", "이번",
  "화제", "논란", "이슈", "사건", "해명", "입장", "반응", "총정리", "정리", "모음", "그것", "이것",
  // 자주 섞이는 일반 명사(나무위키 문서가 있어 오탐이 된다)
  "친일파", "거짓말", "고명딸", "나오는", "드라마", "영화", "예능", "방송", "뮤지컬", "앨범", "무대",
  "결혼", "이혼", "열애", "재혼", "임신", "출산", "복귀", "은퇴", "활동", "작품", "역할", "캐릭터",
  "시청률", "관객", "수상", "기증", "위해", "대해", "관련", "함께", "이후", "이전", "당시",
]);

const HANGUL_ONLY = /^[가-힣]+$/;

function stripParticle(token: string): string[] {
  const out = [token];
  for (const particle of PARTICLES) {
    if (token.length > particle.length + 1 && token.endsWith(particle)) {
      out.push(token.slice(0, -particle.length));
      break;
    }
  }
  return out;
}

/**
 * 키워드에서 인물명 후보를 **가능성 높은 순서로** 뽑는다. 네트워크를 쓰지 않는다.
 *
 * 순서는 글자 수다 - **3글자 → 4글자 → 2글자**. 한국 사람 이름은 세 글자가 압도적이고, 두 글자는
 * 일반 명사와 겹칠 확률이 가장 높아 맨 뒤로 보낸다. 같은 글자 수 안에서는 키워드에 나온 순서를 지킨다.
 *
 * 키워드 전체가 그대로 이름 꼴(한글 2~4자)이면 그것이 1순위다 - 버튼 경로(`오윤아`)의 동작을
 * 한 글자도 바꾸지 않기 위한 것이다.
 */
export function personNameCandidates(keyword: string): string[] {
  const trimmed = keyword.trim();
  const ordered: string[] = [];
  const push = (value: string) => {
    if (!ordered.includes(value)) ordered.push(value);
  };

  if (HANGUL_ONLY.test(trimmed) && trimmed.length >= 2 && trimmed.length <= 4) push(trimmed);

  const tokens = trimmed.split(/[^가-힣A-Za-z0-9]+/).filter(Boolean);
  const byLength = new Map<number, string[]>();
  for (const token of tokens) {
    for (const candidate of stripParticle(token)) {
      if (!HANGUL_ONLY.test(candidate)) continue;
      if (candidate.length < 2 || candidate.length > 4) continue;
      if (STOPWORDS.has(candidate)) continue;
      const bucket = byLength.get(candidate.length) ?? [];
      if (!bucket.includes(candidate)) bucket.push(candidate);
      byLength.set(candidate.length, bucket);
    }
  }

  for (const length of [3, 4, 2]) for (const candidate of byLength.get(length) ?? []) push(candidate);
  return ordered.slice(0, MAX_NAME_CANDIDATES);
}

export type ResolvePersonNameDeps = {
  /** 그 이름으로 네이버 인물 카드가 나오는지. 조회 실패는 false로 돌려준다(비치명). */
  hasPersonCard: (name: string) => Promise<boolean>;
  log?: (message: string) => void;
};

export type ResolvedPersonName = {
  /** 소스팩 조회에 쓸 이름. */
  name: string;
  /** `keyword`(그대로 씀) · `only-candidate`(후보가 하나) · `person-card`(인물 카드로 확인) · `first-candidate`(확인 실패, 1순위 추정) */
  resolvedBy: "keyword" | "only-candidate" | "person-card" | "first-candidate";
  /** 인물 카드를 물어본 후보들. 사람이 사후에 판단할 수 있게 소스팩에 남긴다. */
  tried: string[];
};

/**
 * 키워드를 인물명으로 바꾼다. 후보가 둘 이상일 때만 네이버 인물 카드로 가른다 -
 * **인물 카드가 있다는 것이 "사람 이름"의 자기 검증**이고, 이 저장소가 이미 1순위 출처로 쓰는 것이다.
 *
 * 카드가 하나도 안 나오면 1순위 후보로 진행한다(후보가 없으면 키워드 그대로). 틀린 이름으로
 * 조회하면 소스팩이 비고, 그 사실은 `errors`와 `resolvedBy`에 남아 사람이 알아볼 수 있다.
 */
export async function resolvePersonName(keyword: string, deps: ResolvePersonNameDeps): Promise<ResolvedPersonName> {
  const log = deps.log ?? (() => {});
  const candidates = personNameCandidates(keyword);
  if (candidates.length === 0) return { name: keyword.trim(), resolvedBy: "keyword", tried: [] };
  if (candidates.length === 1) return { name: candidates[0], resolvedBy: "only-candidate", tried: [] };

  const tried: string[] = [];
  for (const candidate of candidates) {
    tried.push(candidate);
    let hit = false;
    try {
      hit = await deps.hasPersonCard(candidate);
    } catch {
      hit = false;
    }
    if (hit) {
      log(`· 인물명 확정 "${candidate}" (후보 ${candidates.join(", ")})`);
      return { name: candidate, resolvedBy: "person-card", tried };
    }
  }

  log(`⚠️ 인물 카드로 확정 못 함 - 1순위 "${candidates[0]}"로 진행 (후보 ${candidates.join(", ")})`);
  return { name: candidates[0], resolvedBy: "first-candidate", tried };
}
