// 규격 파일 목록 테스트. 실행: npm run test:spec-files
import { existsSync, readFileSync } from "node:fs";
import { formatSpecList, pickStyleFile, specCategoryOf, writingSpecFiles } from "./specFiles.js";
import { LOCAL_CALLOUT_CLASSES } from "../../services/publish/renderPublishBlocks.js";

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
assert(pickStyleFile("kscene").endsWith("style/koreaplain.md") && writingSpecFiles("kscene").some((f) => f.path.endsWith("style/voice.md")), "koreaplain은 koreaplain.md + voice.md");
assert(pickStyleFile("person").endsWith("style/person.md") && writingSpecFiles("person").some((f) => f.path.endsWith("style/voice.md")), "person은 person.md + voice.md");
assert(!writingSpecFiles("person").some((f) => f.path.endsWith("style/trend.md")), "person은 trend.md로 폴백하지 않는다");
assert(pickStyleFile("incident").endsWith("incident.md"), "incident 우선순위 유지");
assert(formatSpecList(writingSpecFiles(null))[0].startsWith("1. prompts/writing/core-rules.md"), "번호 목록 형식");
assert(formatSpecList(writingSpecFiles(null))[1].startsWith("2. prompts/writing/rules/humanize.md"), "humanize.md는 2번");
console.log("✅ 규격 파일 목록: core-rules 선두, 카테고리 라우팅, 파일 존재, 중복 없음");
// 🌏 국제(변환기 → koreaplain, 2026-10-29): metadata.track=kscene은 입력 툴 living/tech의 incident 전환과 무관하게 category 그대로 koreaplain.md.
assert(specCategoryOf({ category: "kscene", metadata: { source: "keyword_input", track: "kscene" } }) === "kscene", "변환기 koreaplain job은 koreaplain 규격");
assert(specCategoryOf({ category: "kscene", metadata: { source: "instagram_manual", track: "kscene" } }) === "kscene", "인스타 출처 koreaplain job도 koreaplain 규격");
assert(pickStyleFile(specCategoryOf({ category: "kscene", metadata: { track: "kscene" } })).endsWith("style/koreaplain.md"), "kscene-topic Go job 불변");
console.log("✅ 변환기 출처 koreaplain job → koreaplain.md");

// ---------- Korea Plain 로컬 레이어 3개의 3자 계약 (2026-10-30) ----------
//
// 한글 소제목(koreaplain.md) → 고정 영문 소제목(koreaplain-ko-en.md) → 콜아웃 클래스(renderPublishBlocks)가
// **문자열로** 이어진다. 한 곳에서 한 글자만 달라지면 박스가 조용히 사라지므로 세 파일을 함께 잠근다.
const koreaplainStyle = readFileSync("prompts/writing/style/koreaplain.md", "utf8");
const koreaplainTranslation = readFileSync("prompts/translation/koreaplain-ko-en.md", "utf8");
const coreRules = readFileSync("prompts/writing/core-rules.md", "utf8");
const voice = readFileSync("prompts/writing/style/voice.md", "utf8");

const LOCAL_LAYERS: Array<[string, string]> = [
  ["**현지인은 이렇게 합니다**", "Local note: what Koreans actually do"],
  ["**외국인이 자주 오해하는 점**", "Common misreading"],
  ["**이 글자를 보게 됩니다**", "Words you will see"],
];
for (const [korean, english] of LOCAL_LAYERS) {
  assert(koreaplainStyle.includes(korean), `koreaplain.md에 한글 소제목이 없다: ${korean}`);
  assert(koreaplainTranslation.includes(korean), `번역 지침에 한글 소제목이 없다: ${korean}`);
  assert(koreaplainTranslation.includes(`**${english}**`), `번역 지침에 고정 영문 소제목이 없다: ${english}`);
  assert(LOCAL_CALLOUT_CLASSES.has(english), `변환기 콜아웃 표에 없다: ${english}`);
}
assert(LOCAL_CALLOUT_CLASSES.size === LOCAL_LAYERS.length, "변환기 콜아웃 표에 규격 밖 항목이 있다");
console.log("✅ 로컬 레이어 3개: 한글 소제목 = 고정 영문 소제목 = 콜아웃 클래스");

// 화자·마무리·소제목 상한 개정이 규격에 반영돼 있고, 10/29 개정은 되돌아가지 않았다.
assert(koreaplainStyle.includes("한국에서 나고 자라 서울에 사는 한국인 필자"), "koreaplain.md 화자 절이 로컬 필자로 바뀌지 않았다");
assert(!koreaplainStyle.includes("개인 경험·사적 화자를 쓰지"), "koreaplain.md에 옛 1인칭 전면 금지 문구가 남았다");
assert(koreaplainStyle.includes("저희 집") && koreaplainStyle.includes("지난주 강남에서"), "koreaplain.md에 금지 예(거주지·일화)가 있어야 한다");
assert(koreaplainStyle.includes("koreaplain 한정 2~9개"), "koreaplain.md에 소제목 상한 예외가 없다");
assert(coreRules.includes("`person`·`kscene`은 2~9개"), "core-rules §5에 koreaplain 소제목 예외가 없다");
assert(coreRules.includes("로컬 필자의 한마디") && !coreRules.includes("`kscene`은 요약 한두 문장"), "core-rules §3 koreaplain 마무리가 바뀌지 않았다");
assert(voice.includes('`kscene`은 "한국인 필자" 정체를 쓴다'), "voice.md §3에 koreaplain 한 줄이 없다");
// 10/29 개정 보존(엔터·person 감흥 마무리, §1-12 경위·한정·계산 금지)
assert(coreRules.includes("마무리 — 요약이 아니라 감흥"), "core-rules §3 제목(10/29 감흥 마무리)이 바뀌었다");
assert(coreRules.includes("경위·한정·계산 서술"), "core-rules §1-12(10/29)가 사라졌다");
assert(koreaplainTranslation.includes("Practice, not psychology"), "번역 지침 Tone guards 개정이 없다");
assert(!koreaplainTranslation.includes('no "I"'), "번역 지침에 옛 'Korea Plain has no I'가 남았다");
assert(koreaplainTranslation.includes("Written by Jayden, a Korean living in Seoul"), "번역 지침에 바이라인 안내가 없다");
console.log("✅ koreaplain 화자·마무리·소제목 상한 개정 + 10/29 개정 보존");
