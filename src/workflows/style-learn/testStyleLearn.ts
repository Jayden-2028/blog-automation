// style-learn 순수 함수 테스트. 네트워크·DB 없음, 고정 샘플만 쓴다. 실행: npm run test:style-learn
import assert from "node:assert/strict";

import { analyzePair } from "./analyze.js";
import { parseClassification, sampleRoundRobin, verifyProposalAnchors } from "./classify.js";
import { collectNaverPosts, selectRecent } from "./collect.js";
import { manuscriptParagraphs } from "./manuscript.js";
import { MATCH_THRESHOLD, matchPosts, scorePair } from "./match.js";
import { computeMetrics, sumMetrics } from "./metrics.js";
import { extractNaverPost, parseNaverRss } from "./naverPost.js";
import { renderReport, renderTelegramSummary } from "./report.js";
import type { ReportInput } from "./report.js";
import { diffSentences } from "./sentenceDiff.js";
import { countChars, countEndings, diceSimilarity, isoWeekLabel, kstDate, ngramJaccard, sentenceStyle, splitSentences } from "./text.js";

let n = 0;
const t = (name: string, fn: () => void | Promise<void>) => {
  n += 1;
  return Promise.resolve(fn()).then(
    () => console.log(`  ✓ ${name}`),
    (e) => {
      console.error(`  ✗ ${name}\n${e instanceof Error ? e.stack : e}`);
      process.exit(1);
    }
  );
};

const RSS = `<?xml version="1.0"?><rss><channel><title><![CDATA[블로그]]></title>
<item><title><![CDATA[첫 글 &amp; 제목]]></title><link><![CDATA[https://blog.naver.com/whyissuenow/224457223194?fromRss=true]]></link><pubDate>Thu, 29 Oct 2026 01:03:52 +0900</pubDate><category><![CDATA[스타/연예인]]></category></item>
<item><title><![CDATA[둘째 글]]></title><link><![CDATA[https://blog.naver.com/whyissuenow/224455996375?fromRss=true]]></link><pubDate>Tue, 27 Oct 2026 23:57:44 +0900</pubDate><category><![CDATA[방송/예능]]></category></item>
<item><title><![CDATA[날짜 깨짐]]></title><link><![CDATA[https://blog.naver.com/whyissuenow/224455996000]]></link><pubDate>garbage</pubDate></item>
<item><title><![CDATA[옛 글]]></title><link><![CDATA[https://blog.naver.com/whyissuenow/224400000000]]></link><pubDate>Mon, 05 Oct 2026 10:00:00 +0900</pubDate></item>
</channel></rss>`;

const para = (text: string, big = false) =>
  `<div class="se-component se-text se-l-default"><div class="se-component-content"><div class="se-section se-section-text"><div class="se-module se-module-text"><p class="se-text-paragraph"><span class="${big ? "se-fs-fs19 " : ""}se-ff-">${text}</span></p></div></div></div></div>`;
const image = (caption: string) =>
  `<div class="se-component se-image se-l-default"><div class="se-module se-module-image"><img src="x"/></div><div class="se-caption"><span>${caption}</span></div></div>`;
const POST_HTML = `<html><head><title>실험 글 제목 : 네이버 블로그</title></head><body><div class="se-main-container">
${para("정가은이 반지를 팔러 갔습니다. 감정 결과가 의외였죠!")}
${image("유튜브 영상 속 정가은. 사진=유튜브")}
${para("소제목입니다", true)}
${para("본문 두 번째 문단입니다. 마지막 문장이에요.")}
<div class="se-component se-horizontalLine"><hr/></div>
${para("함께 보면 좋은 글", true)}
<div class="se-component se-oglink se-l-large_image">링크 카드 텍스트</div>
${para("#정가은 #결혼반지")}
</div></body></html>`;

async function main(): Promise<void> {
  console.log("text");
  await t("splitSentences는 종결부호+공백에서만 자른다", () => {
    assert.deepEqual(splitSentences('무게는 23.46g입니다. "정품이 아니다."라고 했어요. 정말요? 네!'), ['무게는 23.46g입니다.', '"정품이 아니다."라고 했어요.', "정말요?", "네!"]);
  });
  await t("sentenceStyle 합니다/해요/기타", () => {
    assert.equal(sentenceStyle("그렇게 말했습니다."), "formal");
    assert.equal(sentenceStyle('그랬다고 "합니다."'), "formal");
    assert.equal(sentenceStyle("감도 안 오네요."), "polite");
    assert.equal(sentenceStyle("바로 어제죠!"), "polite");
    assert.equal(sentenceStyle("이유는 양육비"), "other");
  });
  await t("countEndings 어미 빈도", () => {
    assert.deepEqual(countEndings("가는데요. 대단하네요. 그렇죠. 그렇죠. 맞고요."), { 는데요: 1, 네요: 1, 죠: 2, 고요: 1 });
  });
  await t("countChars는 공백 제외", () => assert.equal(countChars("가 나\n다"), 3));
  await t("유사도 지표 범위", () => {
    assert.equal(diceSimilarity("같은 문장입니다", "같은 문장입니다"), 1);
    assert.ok(diceSimilarity("전혀 다른", "xyz abc") < 0.1);
    assert.ok(ngramJaccard("정가은 결혼반지 이야기", "정가은 결혼반지 이야기에요") > 0.6);
  });
  await t("kstDate·isoWeekLabel", () => {
    assert.equal(kstDate(new Date("2026-10-28T16:00:00Z")), "2026-10-29");
    assert.equal(isoWeekLabel("2026-10-29"), "2026-W44");
    assert.equal(isoWeekLabel("2026-10-26"), "2026-W44");
    assert.equal(isoWeekLabel("2027-01-01"), "2026-W53");
  });

  console.log("naverPost");
  await t("parseNaverRss: 디코딩·logNo·KST 날짜·불량 항목 제외", () => {
    const items = parseNaverRss(RSS);
    assert.equal(items.length, 3);
    assert.equal(items[0]?.title, "첫 글 & 제목");
    assert.equal(items[0]?.logNo, "224457223194");
    assert.equal(items[0]?.publishedDate, "2026-10-29");
    assert.equal(items[0]?.category, "스타/연예인");
  });
  await t("extractNaverPost: 캡션·링크카드·해시태그 제외, 소제목 표시, 관련글에서 중단", () => {
    const post = extractNaverPost(POST_HTML);
    assert.ok(post);
    assert.equal(post.title, "실험 글 제목");
    assert.deepEqual(
      post.paragraphs.map((p) => [p.text, p.heading]),
      [
        ["정가은이 반지를 팔러 갔습니다. 감정 결과가 의외였죠!", false],
        ["소제목입니다", true],
        ["본문 두 번째 문단입니다. 마지막 문장이에요.", false],
      ]
    );
  });
  await t("extractNaverPost: 컨테이너 없으면 null", () => assert.equal(extractNaverPost("<html><body>빈 페이지</body></html>"), null));

  console.log("manuscript");
  await t("manuscriptParagraphs: IMAGE·소제목·불릿·꼬리 처리", () => {
    const md = ["첫 문단입니다.", "", "[IMAGE: 스틸컷 — 웹 검색]", "", "**소제목**", "본문입니다.", "- 불릿 항목입니다", "", "**함께 보면 좋은 글**", "- [다른 글](https://x.y/z)", "", "**참고 자료**", "- [이데일리](https://e.d)", "", "#태그1 #태그2"].join("\n");
    assert.deepEqual(manuscriptParagraphs(md), [
      { text: "첫 문단입니다.", heading: false },
      { text: "소제목", heading: true },
      { text: "본문입니다.", heading: false },
      { text: "불릿 항목입니다", heading: false },
    ]);
  });

  console.log("match");
  const postText = "정가은이 10년 가까이 보관해 온 결혼반지를 팔려고 금은방에 갔습니다. 정품이 아닐 확률은 90% 이상이라는 말을 들었습니다. 티파니 각인이 정품과 달랐습니다.";
  const arts = [
    { id: 1, title: "정가은 결혼반지, 가품 확률 90% 한마디", keyword: "정가은 결혼반지", createdDate: "2026-10-28", text: "정가은이 10년 가까이 보관해 온 결혼반지를 팔려고 금은방에 가져갔습니다. 정품이 아닐 확률은 90% 이상이라는 말을 들었습니다. 티파니 각인이 정품과 일치하지 않았습니다." },
    { id: 2, title: "닥터X 방영 중단 청원", keyword: "닥터X 청원", createdDate: "2026-10-28", text: "SBS 금토드라마 닥터X 6회에 5·18이 등장하자 국회 국민동의청원이 올라왔습니다." },
    { id: 3, title: "정가은 결혼반지 옛 글", keyword: "정가은 결혼반지", createdDate: "2026-10-10", text: postText },
  ];
  await t("scorePair: 같은 글 > 다른 글", () => {
    const post = { id: "p", title: "10년 보관한 결혼반지가 가짜?? 정가은", publishedDate: "2026-10-29", text: postText };
    assert.ok(scorePair(post, arts[0]!).score >= MATCH_THRESHOLD);
    assert.ok(scorePair(post, arts[1]!).score < MATCH_THRESHOLD);
  });
  await t("matchPosts: 창 밖 원고는 후보 제외, 짝 없으면 matched=false", () => {
    const posts = [
      { id: "a", title: "10년 보관한 결혼반지가 가짜?? 정가은", publishedDate: "2026-10-29", text: postText },
      { id: "b", title: "순수작 결혼 소식", publishedDate: "2026-10-29", text: "고등래퍼가 8년 연애 끝에 결혼합니다. 딸이 화동을 맡았어요." },
    ];
    const res = matchPosts(posts, arts);
    assert.equal(res[0]?.matched, true);
    assert.equal(res[0]?.best?.articleId, 1);
    assert.equal(res[1]?.matched, false);
  });
  await t("matchPosts: 한 원고는 한 글에만(점수 높은 쪽)", () => {
    const posts = [
      { id: "a", title: "정가은 결혼반지", publishedDate: "2026-10-29", text: postText },
      { id: "c", title: "정가은 결혼반지 일부", publishedDate: "2026-10-29", text: "정가은이 10년 가까이 보관해 온 결혼반지를 팔려고 금은방에 갔습니다." },
    ];
    const res = matchPosts(posts, [arts[0]!]);
    assert.equal(res.filter((r) => r.matched).length, 1);
    assert.equal(res.find((r) => r.matched)?.postId, "a");
  });

  console.log("metrics / diff");
  const before = manuscriptParagraphs("정가은은 반지를 팔려고 했습니다. 감정 결과는 가품이라고 합니다.\n\n출처는 유튜브 영상입니다. 공인 감정서는 없는 상태입니다.");
  const after = [
    { text: "정가은은 반지를 팔려고 금은방에 갔습니다. 감정 결과가 가품이라니 황당하네요!", heading: false },
  { text: "바로 어제죠. 정말 속상했을까요?", heading: false },
  ];
  await t("computeMetrics: 종결·감탄·질문·어미", () => {
    const m = computeMetrics(after);
    assert.equal(m.sentences, 4);
    assert.equal(m.exclaims, 1);
    assert.equal(m.questions, 1);
    assert.equal(m.politeRatio, 0.75);
    assert.equal(m.formalRatio, 0.25);
    assert.deepEqual(m.endings, { 네요: 1, 죠: 1 });
  });
  await t("sumMetrics: 합·가중평균", () => {
    const a = computeMetrics(before);
    const b = computeMetrics(after);
    const s = sumMetrics([a, b]);
    assert.equal(s.sentences, a.sentences + b.sentences);
    assert.equal(s.chars, a.chars + b.chars);
    assert.ok(s.formalRatio > b.formalRatio && s.formalRatio < a.formalRatio);
  });
  await t("diffSentences: 지움·보탬·고침·그대로", () => {
    const d = diffSentences(
      ["첫 문장은 그대로입니다.", "이 문장은 삭제됩니다 완전히 다른 내용입니다.", "정가은은 반지를 팔려고 했습니다."],
      ["첫 문장은 그대로입니다.", "정가은은 반지를 팔려고 금은방에 갔습니다.", "새로 보탠 감상 문장이네요."]
    );
    assert.equal(d.unchanged, 1);
    assert.equal(d.rewritten.length, 1);
    assert.equal(d.rewritten[0]?.before, "정가은은 반지를 팔려고 했습니다.");
    assert.deepEqual(d.removed, ["이 문장은 삭제됩니다 완전히 다른 내용입니다."]);
    assert.deepEqual(d.added, ["새로 보탠 감상 문장이네요."]);
  });
  await t("diffSentences: 순서가 바뀐 고쳐쓰기도 줍는다", () => {
    const d = diffSentences(["가나다라마바사 아자차카타파하 입니다.", "전혀 다른 문장 하나 둘 셋 넷입니다."], ["전혀 다른 문장 하나 둘 셋 넷이에요.", "가나다라마바사 아자차카타파하 입니다."]);
    assert.equal(d.removed.length + d.added.length, 0);
    assert.equal(d.unchanged + d.rewritten.length, 2);
  });
  await t("analyzePair: 제목 변경·첫/끝 문단", () => {
    const a = analyzePair({ title: "원고 제목", paragraphs: before }, { title: "발행 제목!", paragraphs: after });
    assert.equal(a.titleChanged, true);
    assert.ok(a.firstParagraph.similarity > 0.5);
    assert.ok(a.lastParagraph.similarity < a.firstParagraph.similarity);
    assert.ok(a.diff.added.length >= 1);
  });

  console.log("collect");
  await t("selectRecent: 최근 N일만(오늘 포함)", () => {
    const items = parseNaverRss(RSS);
    assert.equal(selectRecent(items, 7, "2026-10-29").length, 2);
    assert.equal(selectRecent(items, 30, "2026-10-29").length, 3);
    assert.equal(selectRecent(items, 1, "2026-10-29").length, 1);
  });
  await t("collectNaverPosts: 고정 응답, 간격 훅, 실패 비치명", async () => {
    const urls: string[] = [];
    const gaps: number[] = [];
    const fake = async (url: string) => {
      urls.push(url);
      if (url.includes("rss.blog")) return { ok: true, status: 200, text: async () => RSS };
      if (url.includes("224455996375")) return { ok: false, status: 403, text: async () => "" };
      return { ok: true, status: 200, text: async () => POST_HTML };
    };
    const res = await collectNaverPosts(7, { fetchImpl: fake, now: new Date("2026-10-29T03:00:00Z"), sleep: async (ms) => void gaps.push(ms) });
    assert.equal(res.listed, 2);
    assert.equal(res.posts.length, 1);
    assert.equal(res.errors.length, 1);
    assert.match(res.errors[0] ?? "", /HTTP 403/);
    assert.ok(urls.every((u) => !u.includes("blog.naver.com/whyissuenow/") || u.includes("m.blog.naver.com")));
    assert.ok(gaps.length === 2 && gaps.every((g) => g >= 1000));
  });
  await t("collectNaverPosts: RSS 실패는 errors로 알린다", async () => {
    const res = await collectNaverPosts(7, { fetchImpl: async () => ({ ok: false, status: 500, text: async () => "" }), sleep: async () => {} });
    assert.equal(res.posts.length, 0);
    assert.match(res.errors[0] ?? "", /^RSS 실패/);
  });

  console.log("classify / report");
  await t("parseClassification: 앞뒤 잡음·형식 오류 허용, 제안 4건 상한", () => {
    const out = '설명입니다\n{"summary":"요약","removedTypes":[{"type":"출처 경위","count":3,"examples":["a","b","c","d"],"cause":{"file":"x.md","section":"S"}}],"addedTypes":[{"type":"감상"}],"proposals":[' +
      Array.from({ length: 6 }, (_, i) => `{"file":"x.md","section":"s${i}","rationale":"r","before":"가","after":"나"}`).join(",") + ']}\n끝';
    const c = parseClassification(out);
    assert.ok(c);
    assert.equal(c.removedTypes[0]?.examples.length, 3);
    assert.equal(c.removedTypes[0]?.cause?.file, "x.md");
    assert.equal(c.addedTypes[0]?.cause, null);
    assert.equal(c.proposals.length, 4);
    assert.equal(parseClassification("JSON 아님"), null);
    assert.equal(parseClassification("{깨진 json"), null);
  });
  await t("verifyProposalAnchors: 현행 문구가 파일에 있는지", () => {
    const res = verifyProposalAnchors(
      [
        { file: "a.md", section: "s", rationale: "", before: "금지 어미", after: "허용" },
        { file: "a.md", section: "s", rationale: "", before: "없는 문구", after: "x" },
        { file: "b.md", section: "s", rationale: "", before: "금지 어미", after: "x" },
      ],
      { "a.md": "본문 금지 어미 목록" }
    );
    assert.deepEqual(res.map((r) => r.anchorFound), [true, false, false]);
  });
  await t("sampleRoundRobin: 글별로 돌아가며 상한", () => {
    assert.deepEqual(sampleRoundRobin([["a1", "a2", "a3"], ["b1"], []], 4), ["a1", "b1", "a2", "a3"]);
    assert.deepEqual(sampleRoundRobin([["a1", "a2"], ["b1", "b2"]], 3), ["a1", "b1", "a2"]);
  });
  await t("renderReport / renderTelegramSummary 스모크", () => {
    const analysis = analyzePair({ title: "원고 제목", paragraphs: before }, { title: "발행 제목!", paragraphs: after });
    const input: ReportInput = {
      label: "2026-W44", days: 7, generatedAt: "2026-10-29 KST", listed: 3, collected: 3, threshold: MATCH_THRESHOLD,
      pairs: [{ logNo: "1", link: "https://blog.naver.com/whyissuenow/1", category: "스타/연예인", publishedDate: "2026-10-29", articleId: 9, articleCategory: "entertainment", score: scorePair({ id: "1", title: "발행 제목", publishedDate: "2026-10-29", text: postText }, arts[0]!), analysis }],
      pure: [], errors: ["경고 하나"], classification: { summary: "요약", removedTypes: [], addedTypes: [], proposals: [] },
      classifyError: null,
      anchors: [{ file: "prompts/writing/style/voice.md", section: "어미", rationale: "근거", before: "기존 문구", after: "새 문구", anchorFound: true }],
    };
    const md = renderReport(input);
    for (const needle of ["# 네이버 문체 학습 보고 2026-W44", "```diff", "- 기존 문구", "+ 새 문구", "규격 파일은 수정하지 않았다", "경고 하나"]) assert.ok(md.includes(needle), needle);
    const tg = renderTelegramSummary(input, "https://github.com/x/pull/1");
    assert.equal(tg.split("\n").length, 3);
    assert.ok(tg.includes("pull/1"));
    const noClaude = renderReport({ ...input, classification: null, classifyError: "CLI 실패", anchors: [] });
    assert.ok(noClaude.includes("분류를 건너뛰었다 — CLI 실패"));
  });

  console.log(`\n✅ style-learn 테스트 ${n}건 통과`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
