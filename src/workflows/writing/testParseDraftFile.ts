// parseDraftFile 테스트. writer.md §9 규격 파일을 파싱한다.

import { parseDraftFile } from "./parseDraftFile.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const SAMPLE = `---
keyword: 아기 밤중수유 끊는 시기
research_file: research/아기-밤중수유-끊는-시기.md
skill_used: content-blog
title: 아기 밤중수유 끊는 시기, 6개월설이 전부는 아니었어요
written_at: 2026-09-01
humanized: true
char_count: 2140
hashtags: 10
verdict_from_research: ok
---

# 아기 밤중수유 끊는 시기, 6개월설이 전부는 아니었어요

지난주에 아이가 새벽마다 깨서 잠을 설쳤습니다.

[IMAGE: 밤중 수유 중인 젖병과 수면등이 놓인 침대 옆 협탁, 어두운 조명]

## 밤중수유는 언제부터 끊나요

결론부터 말씀드리면 만 6개월 이후부터 고려할 수 있다고 해요.

[IMAGE: 질병관리청 성장도표 캡처 — 24~30개월 구간 표시]

## 참고 자료

- [질병관리청 영유아 수면 안내](https://health.kdca.go.kr/a)

#아기밤중수유 #밤중수유끊는시기 #6개월수유 #영유아수면 #수면교육 #밤중수유중단 #아기수면 #육아정보 #신생아수유 #수유텀

<!-- 확인 필요
- 국내 연령별 야간수유 중단 비율: 공공 통계에서 해당 지표 미발견
-->

<!-- 사용한 출처
1. [official] 질병관리청 — https://health.kdca.go.kr/a
-->
`;

function main(): void {
  console.log("▶ parseDraftFile 테스트 시작\n");

  const p = parseDraftFile(SAMPLE);

  assert(p.title === "아기 밤중수유 끊는 시기, 6개월설이 전부는 아니었어요", `title 파싱 (실제: ${p.title})`);
  assert(p.keyword === "아기 밤중수유 끊는 시기", "keyword 파싱");
  assert(p.skillUsed === "content-blog", "skill_used 파싱");
  assert(p.verdictFromResearch === "ok", "verdict_from_research 파싱");
  console.log("✅ frontmatter 파싱");

  assert(p.hashtags.length === 10, `해시태그 10개 (실제: ${p.hashtags.length})`);
  assert(p.hashtags[0] === "#아기밤중수유", "첫 해시태그");
  assert(!p.body.includes("#아기밤중수유"), "본문에서 해시태그 줄이 제거돼야 한다");
  console.log("✅ 해시태그 줄 분리");

  assert(p.body.includes("## 밤중수유는 언제부터 끊나요"), "## 소제목이 본문에 유지돼야 한다");
  assert(p.body.includes("[IMAGE: 밤중 수유 중인 젖병"), "[IMAGE:] 마커가 본문에 유지돼야 한다");
  assert((p.body.match(/\[IMAGE:/g) ?? []).length === 2, "이미지 마커 2개 모두 유지");
  assert(!p.body.startsWith("# "), "본문 맨 앞의 # 제목 줄은 제거돼야 한다(articles.title로 분리)");
  console.log("✅ 본문: ## 소제목 + [IMAGE:] 마커 유지, 최상위 # 제목 제거");

  assert(p.checkNotes.length === 2, `HTML 주석 2블록 (실제: ${p.checkNotes.length})`);
  assert(p.checkNotes[0].label.includes("확인 필요"), "첫 주석 라벨");
  assert(p.checkNotes[1].body.includes("질병관리청"), "둘째 주석 본문");
  assert(!p.body.includes("<!--"), "본문에서 HTML 주석이 제거돼야 한다");
  console.log("✅ HTML 주석 블록 분리(확인 필요 / 사용한 출처)");

  // frontmatter 없는 파일도 죽지 않고, 첫 # 헤더를 title 폴백으로.
  const noFm = parseDraftFile("# 폴백 제목\n\n본문 내용\n\n#태그하나 #태그둘");
  assert(noFm.title === "폴백 제목", "frontmatter 없으면 첫 # 헤더가 title");
  assert(noFm.hashtags.length === 2, "frontmatter 없어도 해시태그 추출");
  console.log("✅ frontmatter 없음 -> 첫 # 헤더 title 폴백");

  console.log("\n✅ parseDraftFile 테스트 완료");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
