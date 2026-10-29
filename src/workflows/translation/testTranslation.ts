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
  const calls = {
    prompts: [] as string[],
    merges: [] as Record<string, unknown>[],
    saved: [] as { title: string; content: string }[],
    review: 0,
    failure: [] as string[],
    approved: [] as { jobId: string; articleId: number }[],
    revisions: [] as { before: string; after: string }[],
    texts: [] as string[],
    telegraph: 0,
  };
  let run = 0;
  return {
    calls,
    options: {
      guide: "GUIDE-TEXT",
      // 기본은 게이트 꺼짐(옛 영어 재승인 흐름) - 통합 흐름 테스트만 env를 비워 켠다.
      env: { PIPELINE_SKIP_DRAFT_REVIEW: "false" } as NodeJS.ProcessEnv,
      autoApprove: async (target: { jobId: string; articleId: number }) => {
        calls.approved.push(target);
        return { status: "approved" as const, dispatched: true as const };
      },
      applyRevision: async (_job: ArticleJobRow, before: string, after: string) => {
        calls.revisions.push({ before, after });
        return { plan: { kind: "keep" as const }, dispatched: true };
      },
      notifyText: async (_job: ArticleJobRow, text: string) => {
        calls.texts.push(text);
      },
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
      publishTelegraph: async () => {
        calls.telegraph += 1;
        return { ok: true as const, url: "https://telegra.ph/en-1" };
      },
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

  // "Words you will see" 레이어(2026-10-30): 지침이 한글을 괄호 밖·앞에 쓰라고 요구하는 유일한 자리라
  // 이 블록은 한글 잔존 검사에서 뺀다. 안 빼면 한글 한두 개(실측 11자)로 MAX_STRAY_HANGUL(8)을 넘어
  // 정상 번역이 "덜 번역됨"으로 반려된다.
  const wordsLayer = [
    "**Words you will see**",
    "- 보행자 작동신호기 (pedestrian push-button signal) — on the pole",
    "- 음식물 (food waste) — the button on the bin screen",
    "",
    "**Next steps**",
    "Tap out before you leave.",
  ].join("\n");
  assert(strayHangulCount(wordsLayer) === 0, `Words 레이어가 한글 잔존으로 잡혔다 (${strayHangulCount(wordsLayer)}자)`);
  // 블록 밖의 한글은 그대로 센다 - 면제가 레이어 하나에만 걸린다.
  const leaked = wordsLayer + "\n지하철을 타고 서울역까지 갑니다 그리고 부산까지도 갑니다";
  assert(strayHangulCount(leaked) > 8, "Words 레이어 면제가 본문 전체로 번졌다");
  assert(
    strayHangulCount("**Local note: what Koreans actually do**\n한국 사람들은 보통 뒷문으로 내립니다 그리고 카드를 찍습니다") > 8,
    "다른 레이어는 면제 대상이 아니다"
  );
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
  // 마커 설명이 한글 그대로면 캡션·alt가 한글로 발행된다(2026-10-07 실측 - 첫 발행 글 캡션 5개 전부).
  const koMarker = parseTranslationOutput(output(EN_BODY.replace(/\[IMAGE: A subway[^\]]*\]/, "[IMAGE: 지하철 개찰구에서 카드를 찍는 사람 — 웹 검색]")));
  assert(koMarker.ok && validateTranslation({ koreanBody: KO_BODY, parsed: koMarker.parsed }).some((e) => e.includes("설명이 한글")), "한글 마커 설명 거부");
  console.log("  ✅ 계약 검증(마커 개수·획득 방식·링크·한글 잔존·제목·한글 마커 설명)");

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
  assert(ok.calls.saved[0].content === parsed.body && !/^#\w/m.test(ok.calls.saved[0].content.split("\n").at(-1) ?? ""), "영어 원고는 본문만 저장한다(태그는 channelMeta에)");
  const final = ok.calls.merges.at(-1)!;
  assert(final.ksceneStage === "english_review" && final.reviewDecision === null && final.editRequestMessageId === null && final.translationFeedback === null, "영어본 재승인 단계로 전이(대기 중이던 수정 방향은 비운다)");
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

  // ---- 통합 흐름(2026-10-12): 영어본 단독 재승인 없이 자동 승인 -> 이미지 포함 원고 ----
  const ON = {} as NodeJS.ProcessEnv;
  const unified = harness(makeJob(), [output(EN_BODY)]);
  const unifiedRun = await runTranslateJob(JOB_ID, { ...unified.options, env: ON });
  assert(unifiedRun.status === "success" && unified.calls.review === 0 && unified.calls.telegraph === 0, "게이트 켜짐: 영어본 재승인 알림·Telegraph 없음");
  assert(unified.calls.approved.length === 1 && unified.calls.approved[0].jobId === JOB_ID && unified.calls.approved[0].articleId === 2, "영어 article로 자동 승인 + 준비 발화");
  assert(typeof unified.calls.merges.at(-1)!.englishApprovedAt === "string", "영어본 승인 시각 자동 기록");
  const unifiedPrompt = unified.calls.prompts[0];
  assert(unifiedPrompt.includes("<<<KOREAN_BODY"), "번역 입력은 그대로(한글 원고가 사실의 기준)");
  const dispatchFail = harness(makeJob(), [output(EN_BODY)]);
  await runTranslateJob(JOB_ID, {
    ...dispatchFail.options,
    env: ON,
    autoApprove: async () => ({ status: "approved" as const, dispatched: false as const, error: "boom" }),
  });
  assert(dispatchFail.calls.texts.some((t) => t.includes("원고 준비 발화 실패")), "발화 실패는 사용자에게 알린다(영어본은 보존)");
  const legacyAgain = harness(makeJob(), [output(EN_BODY)]);
  await runTranslateJob(JOB_ID, legacyAgain.options);
  assert(legacyAgain.calls.review === 1 && legacyAgain.calls.approved.length === 0 && legacyAgain.calls.telegraph === 1, "게이트 꺼짐: 옛 영어 재승인 흐름 그대로");
  console.log("  ✅ 통합 흐름(영어 재승인 생략·자동 승인)");

  // 이미 자동 승인된 영어본의 수정 요청: 상태가 approved여도 받고, 이미지 마커 diff 경로로 간다.
  const approvedJob = makeJob({ status: "approved" }, { ksceneStage: "english_review", autoApprovedAt: "2026-10-12T00:00:00Z" });
  const revisedUnified = harness(approvedJob, [output(EN_BODY)], [article(1, null, KO_CONTENT), article(2, "blogspot", "OLD ENGLISH BODY")]);
  const revisedRun = await runTranslateJob(JOB_ID, { ...revisedUnified.options, env: ON, feedback: "Shorten the intro" });
  assert(revisedRun.status === "success" && revisedUnified.calls.approved.length === 0, "승인 후 수정: 다시 자동 승인하지 않는다");
  assert(revisedUnified.calls.revisions.length === 1 && revisedUnified.calls.revisions[0].before === "OLD ENGLISH BODY" && revisedUnified.calls.revisions[0].after === parsed.body, "직전 영어본 vs 새 영어본으로 마커 diff");
  assert(revisedUnified.calls.review === 0 && revisedUnified.calls.texts.some((t) => t.includes("영어본 수정을 반영")), "재승인 알림 없이 안내만");
  const approvedNoFeedback = harness(approvedJob, [output(EN_BODY)]);
  assert((await runTranslateJob(JOB_ID, { ...approvedNoFeedback.options, env: ON })).status === "skipped", "승인 후 수정 요청 없이 다시 만들지 않는다");
  const failedRevision = harness(approvedJob, [bad, bad], [article(1, null, KO_CONTENT), article(2, "blogspot", "OLD ENGLISH BODY")]);
  const failedRun = await runTranslateJob(JOB_ID, { ...failedRevision.options, env: ON, feedback: "x" });
  assert(failedRun.status === "failed" && failedRevision.calls.merges.at(-1)!.ksceneStage === "english_review" && failedRevision.calls.failure.length === 0, "승인 후 수정 실패: translation_failed(죽는 ✅ 버튼)로 가지 않고 english_review 유지");
  assert(failedRevision.calls.texts.some((t) => t.includes("영어본 수정 반영 실패")), "실패 안내");
  console.log("  ✅ 승인 후 영어본 수정(마커 diff·실패 격리)");

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
