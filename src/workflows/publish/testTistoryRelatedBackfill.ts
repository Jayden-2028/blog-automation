// 티스토리 내부 링크 소급 백필 순수 함수 테스트(2026-10-28). 실행: npm run test:tistory-backfill-links
// 네트워크·브라우저·DB를 쓰지 않는다.
import { convertArticleToTistoryHtml } from "../../services/publish/convertArticleToTistoryHtml.js";
import { checkInsertInvariants, snapshotFromRaw, type EditorBlock, type RawEditorState, type RawInsertState } from "../../services/publish/tistory/tistoryPostEdit.js";
import type { PublishedPost } from "../../services/supabase/repositories/publicationRepository.js";
import { appendRelatedPosts } from "../manuscripts/appendRelatedPosts.js";
import {
  blocksFromPublicHtml,
  buildInsertionHtml,
  buildRelatedBlockHtml,
  expectedBlockText,
  findRelatedInsertPosition,
  hasRelatedBlock,
  planRelatedInsertion,
  RELATED_BLOCK_TITLE,
  selectBackfillLinks,
  TISTORY_SPACER_HTML,
  verifyRelatedOnPublicPage,
} from "./tistoryRelatedBackfill.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const HOST = "wooahpapa.tistory.com";
const post = (jobId: string, keyword: string, url: string, category: string | null = "incident"): PublishedPost => ({
  jobId,
  title: `${keyword} 정리`,
  url,
  keyword,
  category,
  publishedAt: "2026-10-20T00:00:00Z",
});

// 1) 선정 - 자기 제외(job·주소), 다른 호스트 제외, 3개 상한
{
  const self = { jobId: "j0", keyword: "서울 지하철 파업 일정", category: "incident", url: `https://${HOST}/entry/self` };
  const candidates = [
    post("j0", "서울 지하철 파업 일정", `https://${HOST}/entry/self`),
    post("jx", "서울 지하철 파업 일정 정리", `https://${HOST}/entry/self/`), // 다른 job인데 같은 주소(재발행 기록) - 빼야 한다
    post("j1", "서울 지하철 파업 협상", `https://${HOST}/entry/a`),
    post("j2", "지하철 파업 대체 교통", `https://${HOST}/entry/b`),
    post("j3", "서울 버스 파업 일정", `https://${HOST}/entry/c`),
    post("j4", "지하철 파업 출근길", `https://${HOST}/entry/d`),
    post("j5", "서울 지하철 파업 일정 총정리", "https://thekoreamanual.blogspot.com/2026/10/x.html"),
    post("j6", "서울 지하철 파업 일정 속보", `https://evil-${HOST}/entry/e`),
  ];
  const picked = selectBackfillLinks(self, candidates, HOST);
  assert(picked.length === 3, `3개 상한 (${picked.length})`);
  assert(picked.every((link) => new URL(link.url).hostname === HOST), "같은 블로그 호스트만");
  assert(!picked.some((link) => link.url.includes("/entry/self")), "자기 자신(job·주소) 제외");
  assert(selectBackfillLinks(self, [candidates[0], candidates[1], candidates[6], candidates[7]], HOST).length === 0, "같은 블로그 후보가 없으면 빈 목록");
  console.log("✅ selectBackfillLinks - 자기 제외·호스트 필터·3개 상한");
}

const LINKS = [
  { title: "A & B <속보>", url: `https://${HOST}/entry/%EA%B0%80%EB%82%98` },
  { title: "둘째 글", url: `https://${HOST}/12` },
];

// 2) 블록 HTML - 신규 발행 경로(appendRelatedPosts → 변환기)의 실제 마크업과 같아야 한다
{
  const block = buildRelatedBlockHtml(LINKS);
  const expected =
    `<p style="font-size:19px"><strong>${RELATED_BLOCK_TITLE}</strong></p>\n` +
    `<ul style="font-size:15px"><li><a href="https://${HOST}/entry/%EA%B0%80%EB%82%98" target="_blank" rel="noopener">A &amp; B &lt;속보&gt;</a></li>` +
    `<li><a href="https://${HOST}/12" target="_blank" rel="noopener">둘째 글</a></li></ul>`;
  assert(block === expected, `블록 마크업\n${block}`);
  const published = convertArticleToTistoryHtml(appendRelatedPosts("본문 문단.\n\n**참고 자료**\n- [출처](https://example.com/a)\n", LINKS)).html;
  assert(published.includes(`${block}\n${TISTORY_SPACER_HTML}\n`), `신규 발행본 안에 같은 블록 + 빈 단락이 있어야 한다\n${published}`);
  assert(buildInsertionHtml(LINKS, "before-references") === `${block}\n${TISTORY_SPACER_HTML}`, "앞에 넣을 때는 블록 뒤에 빈 단락");
  assert(buildInsertionHtml(LINKS, "end") === `${TISTORY_SPACER_HTML}\n${block}`, "끝에 붙일 때는 블록 앞에 빈 단락");
  console.log("✅ buildRelatedBlockHtml - 신규 발행 변환 결과와 같은 마크업");
}

const b = (text: string, bold: string[] = []): EditorBlock => ({ tag: "p", text, bold });
const SPACER = b("");

// 3) 삽입 위치 - 참고 자료 앞 / 해시태그 앞 / 끝
{
  const withRefs = [b("도입"), SPACER, b("소제목", ["소제목"]), b("본문"), SPACER, b("참고 자료", ["참고 자료"]), b("출처1"), SPACER, b("#태그1 #태그2")];
  assert(JSON.stringify(findRelatedInsertPosition(withRefs)) === JSON.stringify({ kind: "before-references", index: 5 }), "참고 자료 앞");
  const refsInText = [b("본문에 참고 자료라는 말"), b("#태그1 #태그2")];
  assert(findRelatedInsertPosition(refsInText).kind === "before-hashtags", "굵은 '참고 자료'가 아니면 참고 자료 블록이 아니다");
  const hashOnly = [b("도입"), b("본문"), SPACER, b("#태그1 #태그2 #태그3")];
  assert(JSON.stringify(findRelatedInsertPosition(hashOnly)) === JSON.stringify({ kind: "before-hashtags", index: 3 }), "해시태그 앞");
  const plain = [b("도입"), b("#혼자 해시 하나")];
  assert(JSON.stringify(findRelatedInsertPosition(plain)) === JSON.stringify({ kind: "end", index: 2 }), "둘 다 없으면 끝(해시 하나짜리는 해시태그 줄이 아님)");
  console.log("✅ findRelatedInsertPosition - 참고 자료 앞 / 해시태그 앞 / 끝");
}

// 4) 멱등 판정·계획
{
  const already = [b("본문"), b(RELATED_BLOCK_TITLE, [RELATED_BLOCK_TITLE]), b("링크1")];
  assert(hasRelatedBlock(already), "블록이 있으면 true");
  assert(!hasRelatedBlock([b("함께 보면 좋은 글이 많습니다")]), "문장 속 같은 말은 블록이 아니다");
  const skip = planRelatedInsertion(already, LINKS);
  assert(skip.hrefChanges.length === 0 && !skip.insertBlock && !skip.abort, "이미 있으면 noChange 계획");
  assert(planRelatedInsertion([], LINKS).abort, "블록을 못 읽으면 abort");
  assert(planRelatedInsertion([b("본문")], []).abort, "링크가 없으면 abort");
  const blocks = [b("본문"), SPACER, b("참고 자료", ["참고 자료"]), b("출처")];
  const plan = planRelatedInsertion(blocks, LINKS);
  assert(plan.insertBlock?.beforeIndex === 2 && plan.insertBlock.guardText === "참고 자료" && plan.insertBlock.blockCount === 4, "참고 자료 앞 계획");
  assert(plan.insertBlock.expectedHrefs.join() === LINKS.map((link) => link.url).join(), "계획 링크");
  const endPlan = planRelatedInsertion([b("본문")], LINKS);
  assert(endPlan.insertBlock?.beforeIndex === null && endPlan.insertBlock.guardText === null, "끝 계획");
  console.log("✅ hasRelatedBlock·planRelatedInsertion - 멱등 판정");
}

// 5) 불변 검증 - 기존 텍스트·이미지·링크 순서 유지 + 링크 수 = 기존 + 추가
{
  const beforeRaw: RawEditorState = {
    text: "본문 문단. 참고 자료출처",
    images: 2,
    hrefs: ["https://example.com/a", "https://example.com/b"],
    content: `<p>본문</p><p><b>참고 자료</b></p><ul><li><a href="https://example.com/a">a</a></li><li><a href="https://example.com/b">b</a></li></ul>`,
  };
  const before = snapshotFromRaw(beforeRaw);
  const insertion = planRelatedInsertion([b("본문 문단."), SPACER, b("참고 자료", ["참고 자료"]), b("출처")], LINKS).insertBlock!;
  const newHrefs = LINKS.map((link) => link.url);
  const good: RawInsertState = {
    text: "본문 문단. " + expectedBlockText(LINKS) + " 참고 자료출처",
    textOutside: beforeRaw.text,
    images: 2,
    hrefs: [...newHrefs, ...beforeRaw.hrefs],
    content: beforeRaw.content + newHrefs.map((href) => `<a href="${href}">x</a>`).join(""),
    insertedText: `${RELATED_BLOCK_TITLE}${LINKS.map((link) => link.title).join("")} `,
    insertedHrefs: newHrefs,
  };
  assert(checkInsertInvariants(before, good, insertion, HOST).ok, "정상 추가는 통과");
  const fail = (patch: Partial<RawInsertState>, why: string) => {
    const result = checkInsertInvariants(before, { ...good, ...patch }, insertion, HOST);
    assert(!result.ok, `${why} - 실패해야 한다`);
  };
  fail({ textOutside: beforeRaw.text + "!" }, "기존 텍스트 변경");
  fail({ images: 1 }, "이미지 수 변경");
  fail({ hrefs: [...newHrefs, "https://example.com/a"], content: good.content.replace(`<a href="https://example.com/b">b</a>`, "") }, "기존 링크 하나 사라짐");
  fail({ hrefs: [...newHrefs, "https://example.com/a", "https://example.com/z"] }, "기존 링크 값 바뀜");
  fail({ hrefs: [newHrefs[0], "https://example.com/a", newHrefs[1], "https://example.com/b"] }, "넣은 링크가 흩어짐");
  fail({ insertedText: "다른 글" }, "넣은 블록 텍스트 다름");
  fail({ insertedHrefs: [newHrefs[0]] }, "넣은 링크 일부만");
  fail({ content: beforeRaw.content + `<a href="${newHrefs[0]}">x</a><a href="https://example.com/q">q</a>` }, "직렬화 본문에 새 주소 누락");
  console.log("✅ checkInsertInvariants - 텍스트·이미지 동일, 링크 수 = 기존 + 추가, 기존 순서 유지");
}

// 6) 공개 페이지 - 본문 영역만 읽고, 발행 뒤 확인은 본문 영역의 링크만 센다
{
  const page = (inner: string) =>
    `<html><body><div class="tt_article_useless_p_margin contents_style">${inner}</div>` +
    `<div class="related"><a href="${LINKS[0].url}">스킨 관련 글</a><a href="${LINKS[1].url}">x</a><p><b>${RELATED_BLOCK_TITLE}</b></p></div></body></html>`;
  const bodyHtml = `<p data-ke-size="size16">본문 &amp; 이야기</p><p data-ke-size="size16">&nbsp;</p><p style="font-size: 19px;"><b>참고 자료</b></p><ul><li><a href="https://example.com/a">a</a></li></ul>`;
  const blocks = blocksFromPublicHtml(page(bodyHtml));
  assert(blocks?.length === 4 && blocks[0].text === "본문 & 이야기" && blocks[1].text === "", `본문 블록 ${JSON.stringify(blocks)}`);
  assert(findRelatedInsertPosition(blocks).kind === "before-references", "공개 페이지의 <b>참고 자료</b>도 인식");
  assert(!hasRelatedBlock(blocks), "스킨 영역의 같은 제목은 무시");
  assert(!verifyRelatedOnPublicPage(page(bodyHtml), LINKS, HOST).ok, "스킨 링크만 있으면 확인 실패");
  const after = bodyHtml.replace(`<p style="font-size: 19px;"><b>참고 자료`, `${buildInsertionHtml(LINKS, "before-references")}<p style="font-size: 19px;"><b>참고 자료`);
  const verified = verifyRelatedOnPublicPage(page(after), LINKS, HOST);
  assert(verified.ok, `블록이 들어간 공개 페이지는 확인 통과 (${verified.detail})`);
  assert(blocksFromPublicHtml("<html><body><p>x</p></body></html>") === null, "본문 영역이 없으면 null");
  console.log("✅ blocksFromPublicHtml·verifyRelatedOnPublicPage - 본문 영역 한정");
}

console.log("\n모든 소급 백필 테스트 통과");
