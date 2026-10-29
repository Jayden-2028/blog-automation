// 규격 파일 목록 테스트. 실행: npm run test:spec-files
import { existsSync } from "node:fs";
import { formatSpecList, pickStyleFile, specCategoryOf, writingSpecFiles } from "./specFiles.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`❌ ${msg}`);
}

for (const category of ["entertainment", "ott", "parenting", "living", "community", "incident", "kscene", "person", null]) {
  const files = writingSpecFiles(category);
  assert(files[0].path === "prompts/writing/core-rules.md", `${category}: core-rules가 맨 앞이어야 한다`);
  for (const f of files) assert(existsSync(f.path), `${category}: 파일이 없다 ${f.path}`);
  assert(new Set(files.map((f) => f.path)).size === files.length, `${category}: 중복 파일`);
}
for (const category of ["entertainment", "incident", "kscene", "person", "parenting", null]) {
  const paths = writingSpecFiles(category).map((f) => f.path);
  assert(paths[1] === "prompts/writing/rules/humanize.md", `${category}: humanize.md가 core-rules 바로 다음이어야 한다`);
}
assert(writingSpecFiles("incident").some((f) => f.path.endsWith("style/incident.md")), "incident는 incident.md");
assert(!writingSpecFiles("incident").some((f) => f.path.endsWith("style/voice.md")), "incident에는 voice.md가 없다");
assert(writingSpecFiles("parenting").some((f) => f.path.endsWith("style/voice.md")), "일반 카테고리는 voice.md");
assert(pickStyleFile("ott").endsWith("entertainment.md") && pickStyleFile(null).endsWith("trend.md"), "라우팅");
assert(pickStyleFile("kscene").endsWith("style/kscene.md") && writingSpecFiles("kscene").some((f) => f.path.endsWith("style/voice.md")), "kscene은 kscene.md + voice.md");
assert(pickStyleFile("person").endsWith("style/person.md") && writingSpecFiles("person").some((f) => f.path.endsWith("style/voice.md")), "person은 person.md + voice.md");
assert(!writingSpecFiles("person").some((f) => f.path.endsWith("style/trend.md")), "person은 trend.md로 폴백하지 않는다");
assert(pickStyleFile("incident").endsWith("incident.md"), "incident 우선순위 유지");
assert(formatSpecList(writingSpecFiles(null))[0].startsWith("1. prompts/writing/core-rules.md"), "번호 목록 형식");
assert(formatSpecList(writingSpecFiles(null))[1].startsWith("2. prompts/writing/rules/humanize.md"), "humanize.md는 2번");
console.log("✅ 규격 파일 목록: core-rules 선두, 카테고리 라우팅, 파일 존재, 중복 없음");
// 🌏 국제(변환기 → kscene, 2026-10-29): metadata.track=kscene은 입력 툴 living/tech의 incident 전환과 무관하게 category 그대로 kscene.md.
assert(specCategoryOf({ category: "kscene", metadata: { source: "keyword_input", track: "kscene" } }) === "kscene", "변환기 kscene job은 kscene 규격");
assert(specCategoryOf({ category: "kscene", metadata: { source: "instagram_manual", track: "kscene" } }) === "kscene", "인스타 출처 kscene job도 kscene 규격");
assert(pickStyleFile(specCategoryOf({ category: "kscene", metadata: { track: "kscene" } })).endsWith("style/kscene.md"), "kscene-topic Go job 불변");
console.log("✅ 변환기 출처 kscene job → kscene.md");
