// 작성 단계 원고(articles.content)의 꼬리를 다루는 작은 도구들(2026-09-30).
// runWritingStage는 content를 [본문, "**참고 자료**" 목록, "#태그 #태그" 줄, 의학 고지]로 이어 붙인다.
// 배리에이션 단계가 없어져 이 원고가 곧 최종본이므로, 채널별로 필요한 부분만 떼어 쓴다.

/** 본문 끝의 "#태그 #태그" 줄을 떼어 태그 배열(# 없이)로 돌려준다. */
export function splitTrailingHashtags(content: string): { body: string; tags: string[] } {
  const tags: string[] = [];
  const kept: string[] = [];
  for (const line of content.split("\n")) {
    const tokens = line.trim().split(/\s+/).filter(Boolean);
    if (tokens.length > 0 && tokens.every((t) => /^#[^\s#]+$/.test(t))) tags.push(...tokens.map((t) => t.slice(1)));
    else kept.push(line);
  }
  return { body: kept.join("\n").replace(/\n{3,}/g, "\n\n").trim(), tags: [...new Set(tags)] };
}

/** "**참고 자료**" 줄과 그 아래 이어지는 "- [제목](url)" 목록만 뺀다. 뒤따르는 해시태그·고지는 남긴다. */
export function removeReferencesBlock(content: string): string {
  const lines = content.split("\n");
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!skipping && /^(#{1,3}\s*|\*\*)참고\s*자료(\*\*)?$/.test(trimmed)) {
      skipping = true;
      continue;
    }
    if (skipping) {
      if (/^[-*]\s+\[[^\]]*\]\([^)]*\)/.test(trimmed)) continue;
      skipping = false;
    }
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
