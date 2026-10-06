// 한→영 번역 단계 테스트 - 모델·DB·Telegram·Telegraph 없음(전부 주입).
import { buildTranslationPrompt } from "./buildTranslationPrompt.js";
import { buildEnglishReviewMessages, buildTranslationFailedMessage } from "./notifyEnglishReview.js";
import { imageMarkerDescriptions, parseTranslationOutput, splitSections, strayHangulCount, validateTranslation } from "./parseTranslationOutput.js";
import { ksceneStageOf, runTranslateJob } from "./runTranslateJob.js";
import type { ArticleJobRow, ArticleRow } from "../../types/database.js";

function assert(c: unknown, m: string): asserts c {
  if (!c) throw new Error(`❌ ${m}`);
}

const KO_BODY = [
  "# T-money 카드 사용법",
  "",
  "T-money는 편의점에서 사고 충전할 수 있습니다. 2026년 10월 기준 카드 값은 4,000원입니다.",
  "",
  "[IMAGE: 편의점 계산대에서 T-money 카드를 고르는 장면 — 웹 검색]",
  "",
  "**충전하는 방법**",
  "지하철역 충전기에서 현금으로 충전합니다.",
  "",
  "[IMAGE: 지하철역 충전기 화면 — AI 생성]",
  "",
  "**참고 자료**",
  "- [서울교통공사](https://www.seoulmetro.co.kr/en)",
  "- [T-money 공식 안내](https://www.t-money.co.kr/)",
].join("\n");
const KO_CONTENT = `${KO_BODY}\n\n#티머니 #지하철`;

const EN_BODY = [
  "# How to Use a T-money Card in Korea",
  "",
  `You can buy and top up a T-money card at convenience stores. As of October 2026, the card costs 4,000 won. ${"x".repeat(200)}`,
  "",
  "[IMAGE: Choosing a T-money card at a convenience store counter — 웹 검색]",
  "",
  "**How to top up**",
  "Top up with cash at the machines in subway stations. Look for the sign (충전) on the machine.",
  "",
  "[IMAGE: A subway station top-up machine screen — AI 생성]",
  "",
  "**References**",
  "- [Seoul Metro](https://www.seoulmetro.co.kr/en)",
  "- [T-money official guide](https://www.t-money.co.kr/)",
].join("\n");

const output = (body: string, title = "How to Use a T-money Card in Korea"): string =>
  [
    "<<<TITLE>>>",
    title,
    "<<<SEARCH_DESCRIPTION>>>",
    "Where to buy, top up, and refund a T-money card in Korea.",
    "<<<SLUG>>>",
    "How to Use a T-money Card!",
    "<<<TAGS>>>",
    "#TMoney, Korea Travel, subway , TMoney",
    "<<<BODY>>>",
    body,
    "<<<KO_SUMMARY>>>",
    "- 편의점에서 사고 충전한다",
    "2. 지하철역 충전기에서 현금 충전",
    "<<<END>>>",
  ].join("\n");

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const makeJob = (over: Partial<ArticleJobRow> = {}, metadata: Record<string, unknown> = {}): ArticleJobRow =>
  ({
    id: JOB_ID,
    keyword: "how to use t money card in korea",
    status: "review",
    category: "kscene",
    metadata: {
      track: "kscene",
      ksceneStage: "translating",
      draftMeta: { searchDescription: "티머니 안내", shortName: "티머니" },
      channelMeta: { other: { x: 1 } },
      ...metadata,
    },
    ...over,
  }) as ArticleJobRow;

const article = (id: number, platform: string | null, content: string, title = "T-money 카드 사용법"): ArticleRow =>
  ({ id, job_id: JOB_ID, title, content, status: "review", platform, ai_model: null, keyword_id: null, created_at: "", updated_at: "" }) as ArticleRow;

type Harness = ReturnType<typeof harness>;
function harness(job: ArticleJobRow, outputs: Array<string | { error: string }>, articles = [article(1, null, KO_CONTENT)]) {
  const calls = { prompts: [] as string[], merges: [] as Record<string, unknown>[], saved: [] as { title: string; content: string }[], review: 0, failure: [] as string[] };
  let run = 0;
  return {
    calls,
    options: {
      guide: "GUIDE-TEXT",
      now: () => new Date("2026-10-07T12:30:00Z"),
      loadJob: async () => job,
      loadArticles: async () => articles,
      runTranslator: async (prompt: string) => {
        calls.prompts.push(prompt);
        const next = outputs[Math.min(run++, outputs.length - 1)];
        return typeof next === "string" ? { ok: true as const, output: next } : { ok: false as const, error: next.error };
      },
      saveArticle: async (input: { jobId: string; title: string; content: string }) => {
        calls.saved.push({ title: input.title, content: input.content });
        return article(2, "blogspot", input.content, input.title);
      },
      mergeMetadata: async (_id: string, patch: Record<string, unknown>) => {
        calls.merges.push(patch);
      },
      publishTelegraph: async () => ({ ok: true as const, url: "https://telegra.ph/en-1" }),
      notifyReview: async () => {
        calls.review += 1;
      },
      notifyFailure: async (_job: unknown, reason: string) => {
        calls.failure.push(reason);
      },
    },
  };
}

async function main(): Promise<void> {
  // ---- 파서 ----
  const split = splitSections(output(EN_BODY));
  assert(split.errors.length === 0 && split.sections.TITLE === "How to Use a T-money Card in Korea", "구분자 파싱");
  assert(splitSections("<<<TITLE>>>\nx\n<<<BODY>>>\ny").errors.some((e) => e.includes("SEARCH_DESCRIPTION")), "빠진 구분자를 오류로 알린다");
  const parsedResult = parseTranslationOutput(output(EN_BODY));
  assert(parsedResult.ok, "파싱 성공");
  const parsed = parsedResult.parsed;
  assert(parsed.slug === "how-to-use-a-t-money-card" && parsed.tags.join() === "TMoney,KoreaTravel,subway", `슬러그 정규화·태그 정리(${parsed.slug}|${parsed.tags.join()})`);
  assert(parsed.koSummary.join("|") === "편의점에서 사고 충전한다|지하철역 충전기에서 현금 충전", "요약 불릿·번호 제거");
  console.log("  ✅ 구분자 파서");

  // ---- 검증 ----
  assert(imageMarkerDescriptions(KO_BODY).length === 2, "마커 추출");
  assert(strayHangulCount(EN_BODY) === 0, "허용 자리(마커 접미사·괄호 안 한글)는 세지 않는다");
  assert(strayHangulCount("Take the 지하철 to 서울 and 부산 for 여행 with a 티머니 card") > 8, "번역 안 된 한글은 센다");
  assert(validateTranslation({ koreanBody: KO_BODY, parsed }).length === 0, "정상 번역은 통과");

  const dropped = parseTranslationOutput(output(EN_BODY.replace(/\[IMAGE: A subway[^\n]*\n/, "")));
  assert(dropped.ok && validateTranslation({ koreanBody: KO_BODY, parsed: dropped.parsed }).some((e) => e.includes("마커 개수")), "마커가 줄면 거부");
  const swapped = parseTranslationOutput(output(EN_BODY.replace("counter — 웹 검색", "counter — AI 생성")));
  assert(swapped.ok && validateTranslation({ koreanBody: KO_BODY, parsed: swapped.parsed }).some((e) => e.includes("획득 방식")), "획득 방식 접미사가 바뀌면 거부");
  const noLink = parseTranslationOutput(output(EN_BODY.replace("https://www.t-money.co.kr/", "https://example.com/")));
  assert(noLink.ok && validateTranslation({ koreanBody: KO_BODY, parsed: noLink.parsed }).some((e) => e.includes("링크")), "링크 URL이 바뀌면 거부");
  const untranslated = parseTranslationOutput(output(`${EN_BODY}\n\n지하철역에서 티머니 카드를 충전할 수 있습니다.`));
  assert(untranslated.ok && validateTranslation({ koreanBody: KO_BODY, parsed: untranslated.parsed }).some((e) => e.includes("한글")), "번역 안 된 한글이 남으면 거부");
  const hangulTitle = parseTranslationOutput(output(EN_BODY, "티머니 Guide"));
  assert(hangulTitle.ok && validateTranslation({ koreanBody: KO_BODY, parsed: hangulTitle.parsed }).some((e) => e.includes("제목")), "한글 제목 거부");
  console.log("  ✅ 계약 검증(마커 개수·획득 방식·링크·한글 잔존·제목)");

  // ---- 프롬프트 ----
  const prompt = buildTranslationPrompt({ keyword: "k", koreanTitle: "제목", koreanSearchDescription: null, koreanBody: KO_BODY, koreanTags: ["티머니"], guide: "GUIDE-TEXT" });
  assert(prompt.includes("GUIDE-TEXT") && prompt.includes("<<<KO_SUMMARY>>>") && prompt.includes("<<<KOREAN_BODY") && prompt.includes("개수와 순서를 한 개도 바꾸지 않는다"), "지침 + 계약 + 입력");
  assert(prompt.indexOf("GUIDE-TEXT") < prompt.indexOf("출력 계약"), "지침이 계약보다 앞이다(계약이 이긴다고 명시)");
  const revisePrompt = buildTranslationPrompt({ keyword: "k", koreanTitle: "제목", koreanSearchDescription: null, koreanBody: KO_BODY, koreanTags: [], guide: "G", feedback: "Make it shorter", previousEnglishBody: "PREV EN", retryErrors: ["마커 개수가 다릅니다"] });
  assert(revisePrompt.includes("Make it shorter") && revisePrompt.includes("PREV EN") && revisePrompt.includes("마커 개수가 다릅니다"), "수정 요청·직전 영어본·재시도 오류 주입");
  console.log("  ✅ 프롬프트 조립");

  // ---- 성공 경로 ----
  const ok: Harness = harness(makeJob(), [output(EN_BODY)]);
  const success = await runTranslateJob(JOB_ID, ok.options);
  assert(success.status === "success" && success.attempts === 1, "정상 번역 성공");
  assert(ok.calls.saved.length === 1 && ok.calls.saved[0].title === "How to Use a T-money Card in Korea", "영어 article 저장");
  assert(ok.calls.saved[0].content.endsWith("#TMoney #KoreaTravel #subway"), "영어 태그 줄이 본문 끝에 붙는다(발행 변환이 다시 뗀다)");
  const final = ok.calls.merges.at(-1)!;
  assert(final.ksceneStage === "english_review" && final.reviewDecision === null && final.editRequestMessageId === null, "영어본 재승인 단계로 전이");
  const meta = (final.channelMeta as Record<string, { searchDescription: string; slug: string; tags: string[]; shortName: string }>);
  assert(meta.other && (meta.other as unknown as { x: number }).x === 1, "기존 channelMeta 키를 지우지 않는다");
  assert(meta.blogspot.slug === "how-to-use-a-t-money-card" && meta.blogspot.shortName === "티머니" && meta.blogspot.searchDescription.startsWith("Where to buy"), "영어 발행 메타(검색 설명·slug·태그)를 channelMeta.blogspot에");
  assert((final.translation as { articleId: number; koSummary: string[] }).articleId === 2 && (final.translation as { koSummary: string[] }).koSummary.length === 2, "번역 기록");
  assert(ok.calls.merges[0].ksceneStage === "translating", "시작 시 translating 표시");
  assert(ok.calls.review === 1 && ok.calls.failure.length === 0, "재승인 알림 1건");
  console.log("  ✅ 성공 경로(저장·메타·재승인 알림)");

  // ---- 자동 재시도 ----
  const bad = output(EN_BODY.replace(/\[IMAGE: A subway[^\n]*\n/, ""));
  const retry = harness(makeJob(), [bad, output(EN_BODY)]);
  const retried = await runTranslateJob(JOB_ID, retry.options);
  assert(retried.status === "success" && retried.attempts === 2 && retry.calls.prompts[1].includes("마커 개수가 다릅니다"), "계약 위반은 오류를 되먹여 한 번 재시도");
  const execRetry = harness(makeJob(), [{ error: "timeout" }, output(EN_BODY)]);
  assert((await runTranslateJob(JOB_ID, execRetry.options)).status === "success", "실행 실패도 한 번 재시도");

  // ---- 실패 경로 ----
  const fail = harness(makeJob(), [bad, bad]);
  const failed = await runTranslateJob(JOB_ID, fail.options);
  assert(failed.status === "failed" && fail.calls.saved.length === 0, "두 번 다 어기면 실패, 저장 없음");
  assert(fail.calls.merges.at(-1)!.ksceneStage === "translation_failed" && fail.calls.failure.length === 1 && fail.calls.review === 0, "실패 단계·실패 알림");
  const failMsg = buildTranslationFailedMessage({ id: JOB_ID, keyword: "k" }, "<b>x</b>");
  assert(failMsg.replyMarkup?.inline_keyboard[0][0].callback_data === `review:confirm:${JOB_ID}` && failMsg.text.includes("&lt;b&gt;"), "다시 만들기 버튼은 ✅ 콜백 재사용, 사유는 HTML 이스케이프");
  const execFail = harness(makeJob(), [{ error: "한도" }]);
  assert((await runTranslateJob(JOB_ID, execFail.options)).status === "failed", "실행이 계속 실패하면 실패");
  const noBase = harness(makeJob(), [output(EN_BODY)], []);
  assert((await runTranslateJob(JOB_ID, noBase.options)).status === "failed", "한글 기준 원고가 없으면 실패");
  console.log("  ✅ 재시도·실패 경로");

  // ---- 건너뜀 ----
  const skip = async (job: ArticleJobRow | null, feedback?: string) =>
    runTranslateJob(JOB_ID, { ...harness(job ?? makeJob(), [output(EN_BODY)]).options, loadJob: async () => job, feedback });
  assert((await skip(null)).status === "skipped", "job 없음");
  assert((await skip(makeJob({}, { track: "social" }))).status === "skipped", "kscene 트랙이 아니면 건너뜀");
  assert((await skip(makeJob({ status: "approved" }))).status === "skipped", "이미 승인된 job은 건너뜀(승인 후 번역으로 덮지 않는다)");
  assert((await skip(makeJob({}, { ksceneStage: undefined }))).status === "skipped", "한글 승인 전(stage 없음)은 건너뜀");
  assert((await skip(makeJob({}, { ksceneStage: "english_review" }))).status === "skipped", "수정 요청 없이 영어본을 다시 만들지 않는다");
  assert(ksceneStageOf(makeJob({}, { ksceneStage: "english_review" })) === "english_review" && ksceneStageOf(makeJob({}, { ksceneStage: "x" })) === null, "stage 읽기");
  console.log("  ✅ 건너뜀 조건");

  // ---- 수정 요청 재번역 ----
  const revise = harness(makeJob({}, { ksceneStage: "english_review" }), [output(EN_BODY)], [article(1, null, KO_CONTENT), article(2, "blogspot", "OLD ENGLISH BODY\n\n#old")]);
  const revised = await runTranslateJob(JOB_ID, { ...revise.options, feedback: "Shorten the intro" });
  assert(revised.status === "success" && revise.calls.prompts[0].includes("Shorten the intro") && revise.calls.prompts[0].includes("OLD ENGLISH BODY"), "수정 요청 + 직전 영어본으로 재번역");
  assert((revise.calls.merges.at(-1)!.translation as { revisedWithFeedback: boolean }).revisedWithFeedback === true, "수정 반영 표시");
  const retryFromFailed = harness(makeJob({}, { ksceneStage: "translation_failed" }), [output(EN_BODY)]);
  assert((await runTranslateJob(JOB_ID, retryFromFailed.options)).status === "success", "실패 단계에서 다시 만들기");
  console.log("  ✅ 수정 요청 재번역·실패 후 재시도");

  // ---- 알림 메시지 ----
  const base = { job: makeJob(), englishTitle: "Title <1>", koreanTitle: "제목", koSummary: ["요지1", "요지2"], isRevision: false, englishBody: EN_BODY };
  const withPage = buildEnglishReviewMessages({ ...base, telegraphUrl: "https://telegra.ph/x" });
  assert(withPage.length === 1 && withPage[0].text.includes("Title &lt;1&gt;") && withPage[0].text.includes("재승인"), "Telegraph 있으면 1건, 제목 이스케이프");
  const keyboard = withPage[0].replyMarkup!.inline_keyboard;
  assert(keyboard[0][0].url === "https://telegra.ph/x" && keyboard[1].map((b) => b.callback_data).join() === [`review:confirm:${JOB_ID}`, `review:edit:${JOB_ID}`, `review:discard:${JOB_ID}`].join(), "영어본 보기 + 승인/수정/반려(한글 검수와 같은 콜백)");
  const noPage = buildEnglishReviewMessages({ ...base, telegraphUrl: null });
  assert(noPage.length >= 3 && noPage.at(-1)!.replyMarkup && noPage.slice(1, -1).some((m) => m.text.includes("한글 대역 요약")), "Telegraph 실패 시 본문·요약 dump + 마지막에 결정 버튼");
  assert(buildEnglishReviewMessages({ ...base, telegraphUrl: "u", isRevision: true })[0].text.includes("수정 반영됨"), "재번역 문구");
  console.log("  ✅ 재승인 알림 메시지");

  console.log("\n✅ testTranslation 통과");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
