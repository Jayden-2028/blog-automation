// SourceRow[] -> 원고 생성 프롬프트에 넣을 "팩트 카드" 텍스트로 변환.
//
// 등급을 그대로 노출하는 이유(SPRINT_2_DESIGN.md 4·7절): 원고 생성 프롬프트가 "이 주장은 어느
// 등급의 출처에 기대는지"를 판단하려면 등급이 텍스트에 보여야 한다. official/medical 출처는
// 단정적으로 인용해도 되지만, community 출처는 "~라고 알려져 있습니다" 수준으로 낮춰야 한다는
// 규칙(§7-4)이 이 카드 형식 위에서 성립한다.

import type { SourceAuthorityLevel } from "../../types/database.js";
import type { SourceRow } from "../../types/database.js";

const AUTHORITY_LABEL: Record<SourceAuthorityLevel, string> = {
  official: "공공(정부/공식기관)",
  medical: "의료기관",
  news: "뉴스",
  community: "커뮤니티/블로그(개인 경험담, 공식 확인 아님)",
};

// 등급 미상(과거 데이터 등)은 가장 낮은 신뢰로 표시한다 - "판정 안 됨"을 "신뢰할 수 있음"으로
// 오인하면 안 된다는 원칙을 여기서도 지킨다(sourceAuthorityRules.ts와 동일한 원칙).
const UNKNOWN_LABEL = "미분류(신뢰 확인 불가)";

function formatSourceLine(source: SourceRow, index: number): string {
  const parts = [`${index + 1}. [${source.authority ? AUTHORITY_LABEL[source.authority] : UNKNOWN_LABEL}]`];
  if (source.title) parts.push(source.title);
  const lines = [parts.join(" ")];
  if (source.published_at) lines.push(`   발행: ${source.published_at.slice(0, 10)}`);
  if (source.content) lines.push(`   내용: ${source.content}`);
  if (source.url) lines.push(`   출처: ${source.url}`);
  return lines.join("\n");
}

export type FactCardSummary = {
  total: number;
  countByAuthority: Record<SourceAuthorityLevel | "unknown", number>;
};

export function summarizeSourcesByAuthority(sources: SourceRow[]): FactCardSummary {
  const countByAuthority: FactCardSummary["countByAuthority"] = {
    official: 0,
    medical: 0,
    news: 0,
    community: 0,
    unknown: 0,
  };
  for (const source of sources) {
    countByAuthority[source.authority ?? "unknown"]++;
  }
  return { total: sources.length, countByAuthority };
}

/**
 * 근거 목록을 프롬프트에 넣을 텍스트로 만든다. 등급 순서(official -> medical -> news -> community)로
 * 정렬해 신뢰도 높은 근거를 먼저 보여준다 - LLM이 프롬프트 앞부분에 더 크게 반응하는 경향을 고려한
 * 배치다.
 */
export function buildFactCard(sources: SourceRow[]): string {
  if (sources.length === 0) {
    return "(수집된 근거가 없습니다. 이 경우 확인되지 않은 내용을 절대 단정하지 말고, 일반적으로 알려진 배경 설명 수준으로만 작성하세요.)";
  }

  const order: SourceAuthorityLevel[] = ["official", "medical", "news", "community"];
  const sorted = [...sources].sort((a, b) => {
    const ai = a.authority ? order.indexOf(a.authority) : order.length;
    const bi = b.authority ? order.indexOf(b.authority) : order.length;
    return ai - bi;
  });

  return sorted.map((source, index) => formatSourceLine(source, index)).join("\n\n");
}
