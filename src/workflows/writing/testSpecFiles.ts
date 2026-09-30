// 규격 파일 목록 테스트. 실행: npm run test:spec-files
import { existsSync } from "node:fs";
import { formatSpecList, pickStyleFile, writingSpecFiles } from "./specFiles.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`❌ ${msg}`);
}

for (const category of ["entertainment", "ott", "parenting", "living", "community", "incident", null]) {
  const files = writingSpecFiles(category);
  assert(files[0].path === "prompts/writing/core-rules.md", `${category}: core-rules가 맨 앞이어야 한다`);
  for (const f of files) assert(existsSync(f.path), `${category}: 파일이 없다 ${f.path}`);
  assert(new Set(files.map((f) => f.path)).size === files.length, `${category}: 중복 파일`);
}
assert(writingSpecFiles("incident").some((f) => f.path.endsWith("style/incident.md")), "incident는 incident.md");
assert(!writingSpecFiles("incident").some((f) => f.path.endsWith("style/voice.md")), "incident에는 voice.md가 없다");
assert(writingSpecFiles("parenting").some((f) => f.path.endsWith("style/voice.md")), "일반 카테고리는 voice.md");
assert(pickStyleFile("ott").endsWith("entertainment.md") && pickStyleFile(null).endsWith("trend.md"), "라우팅");
assert(formatSpecList(writingSpecFiles(null))[0].startsWith("1. prompts/writing/core-rules.md"), "번호 목록 형식");
console.log("✅ 규격 파일 목록: core-rules 선두, 카테고리 라우팅, 파일 존재, 중복 없음");
