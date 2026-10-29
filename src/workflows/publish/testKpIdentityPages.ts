// kpIdentityPages.ts 순수 변환 테스트(네트워크 없음). npm run test:kp-identity-pages
// 픽스처는 2026-10-30 라이브 페이지(www.koreaplain.com)에서 그대로 가져온 본문이다.
import {
  KP_ABOUT_HTML,
  KP_EDITORIAL_HEADING,
  applyAboutIdentity,
  applyContactLocalTone,
  applyEditorialLocalReview,
  diffLines,
  pageLines,
} from "./kpIdentityPages.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const liveAbout =
  `<p><b>Korea, in plain English.</b></p><p>&nbsp;Korea Plain (formerly The Korea Manual) is a practical, English-language guide to using everyday life in Korea.</p>` +
  `<p><br /></p><p>Many Korea websites tell you where to go. This one explains what to do when you get there.</p>` +
  `<p><br /></p><p><b>Who runs this</b></p><p>Korea Plain is written and edited from Seoul by Jayden.</p>`;

const liveEditorial =
  `<p>&nbsp;Our goal is to help a reader complete a real task in Korea.</p><p><br /></p>` +
  `<p>Sources</p><p>We prefer official government pages, transport operators, hospitals, banks, telecom companies, app help centers, and other first-party sources.</p>` +
  `<p><br /></p><p>Testing and review</p><p>Drafts may be prepared with AI assistance; every article is fact-checked.</p>` +
  `<p><br /></p><p>Corrections</p><p>Readers can report an error through the Contact page.</p>`;

const liveContact =
  `<p>Found an outdated step, a broken link, or a Korea question that deserves a proper guide?</p><p><br /></p>` +
  `<p>Email: contact.thekoreamanual@gmail.com</p><p><br /></p><p>For corrections, please include:</p><p>&#8226; the article URL;</p>` +
  `<p><br /></p><p>Do not send passport numbers, alien registration numbers, bank details, medical records, reservation codes, or other sensitive personal information.</p>`;

// 1) About: 전문 교체, 로컬 정체성 문장, 멱등
{
  const first = applyAboutIdentity(liveAbout);
  assert(first.changed && first.html === KP_ABOUT_HTML, "About 본문 전문 교체");
  const text = pageLines(first.html).join(" ");
  assert(text.includes("a Korean who was born and raised here and lives in Seoul"), "국적·거주를 밝힌다(§A-3)");
  assert(text.includes("written and edited in Seoul by Jayden, a Korean"), "운영자 문단이 한국인임을 밝힌다");
  assert(text.includes("we don't invent stories"), "지어내지 않는다는 약속(core-rules §1과 같은 말)");
  assert(!text.includes("The Korea Manual"), "옛 이름 없음");
  assert(/^Korea, in plain English\.$/.test(pageLines(first.html)[0]), "태그라인 첫 줄 유지(Q1 유지안)");
  assert(!first.html.includes("<h"), "제목 태그 없이 문단·볼드·목록만");
  const again = applyAboutIdentity(first.html);
  assert(!again.changed && again.html === first.html, "About 멱등");
}

// 2) Editorial Policy: Sources 바로 뒤에 Local review, 나머지 그대로, 멱등
{
  const first = applyEditorialLocalReview(liveEditorial);
  assert(first.changed, "Editorial Policy에 절 추가");
  const lines = pageLines(first.html);
  const at = lines.indexOf(KP_EDITORIAL_HEADING);
  assert(at > lines.indexOf("Sources") && at < lines.indexOf("Testing and review"), `Local review는 Sources 뒤·Testing 앞 (${at})`);
  assert(lines[at + 1].startsWith("Every guide is written by a Korean who lives in Seoul"), "본문 문단이 바로 뒤에");
  const before = pageLines(liveEditorial);
  assert(before.every((line) => lines.includes(line)), "기존 줄은 하나도 지워지지 않는다");
  assert(lines.length === before.length + 2, `추가한 줄은 2개 (${lines.length - before.length})`);
  const again = applyEditorialLocalReview(first.html);
  assert(!again.changed && again.html === first.html, "Editorial Policy 멱등");
  assert(!applyEditorialLocalReview("<p>no sources here</p>").changed, "Sources 절이 없으면 건드리지 않는다");
}

// 3) Contact: 첫 문단만 교체, 이메일·항목·주의 그대로, 멱등
{
  const first = applyContactLocalTone(liveContact);
  assert(first.changed, "Contact 첫 문단 교체");
  const lines = pageLines(first.html);
  assert(lines[0].includes("we especially want to hear it"), "첫 문단이 로컬 톤(§A-6)");
  assert(lines[0].startsWith("Found an outdated step"), "기존 첫 문장은 유지");
  assert(first.html.includes("contact.thekoreamanual@gmail.com"), "이메일 주소 그대로(범위 밖)");
  assert(lines.slice(1).join(" ") === pageLines(liveContact).slice(1).join(" "), "첫 문단 말고는 글자 하나 안 바뀐다");
  const again = applyContactLocalTone(first.html);
  assert(!again.changed && again.html === first.html, "Contact 멱등");
}

// 4) diff 출력 도우미
{
  const diff = diffLines(["a", "b", "c"], ["a", "x", "c"]);
  assert(diff.join("|") === "  a|- b|+ x|  c", `LCS diff (${diff.join("|")})`);
  assert(pageLines("<p>&amp; &#8212; <b>x</b></p><ul><li>y</li></ul>").join("|") === "& — x|y", "문단·목록 줄 추출 + 엔티티 복원");
}

console.log("✅ Korea Plain 정체성 페이지 변환 테스트 통과(About 전문·Local review·Contact 첫 문단·멱등)");
