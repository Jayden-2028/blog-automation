// 저장 직전 규칙 집행 테스트. 실행: npm run test:enforce-rules  (외부 호출 없음 - fixer 주입)
import { applyDeterministicFixes, enforceWritingRules, findRuleViolations } from "./enforceWritingRules.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`❌ ${msg}`);
}

// 1) 결정적 교정 - 댓글 유도 문장과 시점 표기
{
  const body = [
    "지원금은 2026년 8월 기준 30만 원입니다. 신청은 온라인으로 합니다.",
    "",
    "여기 정리한 내용은 2026년 9월 18일 기준입니다.",
    "",
    "**신청 방법**",
    "정부24에서 신청합니다. 여러분은 어떻게 생각하시나요? 댓글로 남겨주세요.",
    "",
    "#지원금 #신청",
  ].join("\n");
  const fixed = applyDeterministicFixes(body);
  assert(fixed.body.includes("지원금은 30만 원입니다."), `시점 표기만 지워야 한다 (실제: ${fixed.body})`);
  assert(!fixed.body.includes("기준"), "기준 시점 문장이 남았다");
  assert(!fixed.body.includes("여러분은"), "댓글 유도가 남았다");
  assert(fixed.body.includes("정부24에서 신청합니다."), "정상 문장이 지워졌다");
  assert(fixed.body.includes("**신청 방법**") && fixed.body.includes("#지원금"), "소제목·해시태그는 보존");
  console.log("✅ 결정적 교정: 댓글 유도·기준 시점 삭제, 나머지 보존");
}

// 1-1) 올해 날짜의 연도만 뗀다(2026-10-02). 다른 연도·연도 단독 표기는 그대로 둔다.
{
  const now = new Date("2026-10-02T09:00:00+09:00");
  const body = [
    "2026년 10월 1일에 SNS에서 퍼졌습니다. 2026년 10월 9일은 한글날입니다.",
    "한글날은 1990년 공휴일에서 빠졌고 2012년 12월 28일에 복원됐습니다.",
    "2026년 공휴일은 70일입니다.",
  ].join("\n");
  const fixed = applyDeterministicFixes(body, now);
  assert(fixed.body.includes("10월 1일에 SNS에서 퍼졌습니다."), `올해 연도를 떼야 한다 (${fixed.body})`);
  assert(fixed.body.includes("10월 9일은 한글날입니다."), "한 줄에 두 번 나와도 둘 다 뗀다");
  assert(!fixed.body.includes("2026년 10월"), "올해 연도+월 표기가 남으면 안 된다");
  assert(fixed.body.includes("1990년 공휴일에서 빠졌고 2012년 12월 28일에 복원"), "다른 연도는 그대로 둔다");
  assert(fixed.body.includes("2026년 공휴일은 70일입니다."), "연도 단독 표기는 날짜가 아니라 그대로 둔다");
  assert(fixed.removed.some((r) => r.includes("올해 연도")), "무엇을 뗐는지 남겨야 한다");
  console.log("✅ 결정적 교정: 올해 날짜의 연도만 제거, 다른 연도·연도 단독 보존");
}

// 2) 정상 원고는 손대지 않는다
{
  const clean = "지원금은 30만 원입니다. 지급일은 8월 27일입니다.\n\n**신청 방법**\n정부24에서 신청합니다.";
  const fixed = applyDeterministicFixes(clean);
  assert(fixed.body === clean && fixed.removed.length === 0, `정상 원고가 바뀌었다: ${fixed.body}`);
  assert(findRuleViolations(clean).length === 0, "정상 원고에서 위반이 나왔다");
  console.log("✅ 정상 원고는 그대로");
}

// 3) 위반 탐지 - 참고 자료와 소제목·이미지 마커는 제외
{
  const body = [
    "말한 것으로 보도됐습니다.",
    "[IMAGE: 보도됐습니다 장면]",
    "**요금은 아직 공개되지 않았습니다**",
    "저희도 그랬거든요.",
    "",
    "## 참고 자료",
    "- [보도됐습니다](https://x)",
  ].join("\n");
  const v = findRuleViolations(body);
  assert(v.length === 2, `위반 2건이어야 한다 (실제 ${v.length}: ${JSON.stringify(v)})`);
  console.log("✅ 위반 탐지: 본문 문장만, 마커·소제목·참고 자료 제외");
}

// 4) 에이전트 교정 - 성공, 실패(위반 안 줄어듦), 마커 수 변경, 호출 실패
const bad = "말한 것으로 보도됐습니다. 지원금은 30만 원입니다.\n\n[IMAGE: 창구 — 웹 검색]\n[IMAGE PROMPT: 주민센터 창구]\n\n저희도 그랬거든요.";
{
  const ok = await enforceWritingRules({
    body: bad,
    category: "living",
    runFixer: async () => ({
      ok: true,
      output: "### BODY\n그는 이렇게 말했습니다. 지원금은 30만 원입니다.\n\n[IMAGE: 창구 — 웹 검색]\n[IMAGE PROMPT: 주민센터 창구]\n\n저희도 그랬어요.",
      durationMs: 1,
    }),
  });
  assert(ok.agentApplied && ok.violationsAfter === 0, "성공한 교정이 적용돼야 한다");

  const noGain = await enforceWritingRules({
    body: bad,
    category: "living",
    runFixer: async () => ({ ok: true, output: `### BODY\n${bad}`, durationMs: 1 }),
  });
  assert(!noGain.agentApplied && noGain.body === bad, "위반이 안 줄면 원본을 유지해야 한다");

  const lostMarker = await enforceWritingRules({
    body: bad,
    category: "living",
    runFixer: async () => ({ ok: true, output: "### BODY\n지원금은 30만 원입니다. 저희도 그랬어요. 지원금 안내를 길게 적습니다. 신청은 온라인으로 합니다.", durationMs: 1 }),
  });
  assert(!lostMarker.agentApplied, "마커가 사라진 결과는 버려야 한다");

  const failed = await enforceWritingRules({
    body: bad,
    category: "living",
    runFixer: async () => ({ ok: false, error: "timeout", durationMs: 1 }),
  });
  assert(!failed.agentApplied && failed.body === bad, "호출 실패는 원본 유지(fail-open)");

  let called = false;
  const clean = await enforceWritingRules({
    body: "지원금은 30만 원입니다.",
    category: null,
    runFixer: async () => {
      called = true;
      return { ok: true, output: "", durationMs: 1 };
    },
  });
  assert(!called && !clean.agentApplied, "위반이 없으면 에이전트를 부르지 않는다");
  console.log("✅ 에이전트 교정: 적용 / 위반 미감소 폐기 / 마커 변경 폐기 / 호출 실패 fail-open / 위반 없으면 미호출");
}

// 5) person 분기(2026-10-15) - 허용 어미(~거든요·~고요)는 교정 대상이 아니다. 나머지 어미·타 카테고리는 기존대로.
{
  const personBody = "두 작품이 같은 시기에 겹쳤거든요. 일정이 빠듯했고요.\n\n[IMAGE: 장면 — 웹 검색]";
  assert(findRuleViolations(personBody, "person").length === 0, "person의 거든요·고요는 위반이 아니다");
  assert(findRuleViolations(personBody, "entertainment").length === 2, "타 카테고리의 거든요·고요는 기존대로 위반(문장 2개)");
  assert(findRuleViolations(personBody).length === 2, "category 미지정도 기존대로 위반(문장 2개)");
  assert(findRuleViolations("분위기가 좋네요. 그랬잖아요.", "person").length === 1, "person에서 네요는 허용(2026-10-16), 잖아요만 위반");
  assert(findRuleViolations("분위기가 좋네요.", "entertainment").length === 0, "엔터도 네요는 허용(2026-10-16 voice.md)");
  assert(findRuleViolations("분위기가 좋네요.", "incident").length === 1, "incident는 구어 완화 예외 - 네요도 위반");
  assert(findRuleViolations("그렇더라고요.", "entertainment").length === 1, "더라고요는 전 카테고리 금지 유지");

  let called = false;
  const personRun = await enforceWritingRules({
    body: personBody,
    category: "person",
    runFixer: async () => {
      called = true;
      return { ok: true, output: "", durationMs: 1 };
    },
  });
  assert(!called && !personRun.agentApplied && personRun.body === personBody && personRun.violationsBefore === 0, "person 허용 어미만 있으면 에이전트를 부르지 않고 원고를 바꾸지 않는다");

  let prompt = "";
  await enforceWritingRules({
    body: "그 장면이 압권이잖아요. 두 작품이 겹쳤거든요.",
    category: "person",
    runFixer: async (p: string) => {
      prompt = p;
      return { ok: false, error: "stub", output: "", durationMs: 1 } as never;
    },
  });
  assert(prompt.includes("압권이잖아요") && !prompt.includes("] 두 작품이 겹쳤거든요"), "person 교정 목록에는 금지 어미(잖아요) 문장만 들어간다 - 허용 어미(거든요) 문장은 목록 제외");
  assert(prompt.includes("`~거든요`·`~고요`를 허용"), "person 교정 지시에 허용 어미 안내가 있다");
  console.log("✅ person 분기: 허용 어미 미교정 / 금지 어미 교정 / 타 카테고리 기존대로");
}

// 6) 직접 인용(따옴표 안)은 전 카테고리에서 구어 어미 교정 대상이 아니다. 인용 밖은 그대로 잡는다. 따옴표가 문장 경계를 넘어도 동일.
{
  assert(findRuleViolations('그는 "저희도 그랬잖아요. 처음엔 어렵더라고요."라고 말했습니다.', "living").length === 0, "인용 안 어미는 위반이 아니다(문장 경계를 넘는 인용 포함)");
  assert(findRuleViolations('그는 "그랬잖아요."라고 했는데 본문은 그렇더라고요.', "living").length === 1, "인용 밖 금지 어미는 기존대로 위반(네요는 2026-10-16부터 허용)");
  assert(findRuleViolations("그는 “겹쳤거든요.”라고 했습니다.", "entertainment").length === 0, "큰따옴표(곡선) 인용도 제외");
  console.log("✅ 직접 인용 안 어미 제외(문장 경계 넘는 인용 포함), 인용 밖은 기존대로");
}

// 7) C-11 연결어미 직후 쉼표 제거(2026-10-15) - 과교정 방지 픽스처를 먼저 고정한다.
//    제거/보존 문장은 차정원 원고(job 355ce8ea, 윤문 전 원본)의 실측 16건이다: 제거 13 / 보존 3(이고 병렬).
{
  const NOW = new Date("2026-10-15T12:00:00+09:00");
  const fix = (text: string) => applyDeterministicFixes(text, NOW);
  const dropComma = (sentence: string, token: string) => sentence.replace(`${token}, `, `${token} `);

  const targets: Array<[string, string]> = [
    ["2020년 연예계 동료로 만난 두 사람은 2월 4일 양측 소속사를 통해 교제를 인정했고, 약 8개월 만에 결혼 날짜를 알렸습니다.", "인정했고"],
    ["2020년 연예계 동료로 만나 연인이 됐고, 2월 4일 양측 소속사가 교제를 인정했습니다.", "됐고"],
    ["결혼 날짜가 나오자 이 발언이 다시 떠올랐고, 두 사람의 2세 소식에 관심이 쏠리고 있습니다.", "떠올랐고"],
    ["열애 인정 당시 배우 쪽 소속사가 교제 상대를 '비연예인'이라고 안내해 혼선이 생겼고, 그 대처는 비판을 받았습니다.", "생겼고"],
    ["하늘색 바람막이 사진에 \"열애설은 못 막아도 바람은 막을 수 있다\"고 적은 의류 광고였고, 정면 돌파가 멋있다는 반응과 하정우가 쓴 문구 같다는 농담이 붙었습니다.", "광고였고"],
    ["맡은 역은 조연이었고, 캐스팅 소감도 선배들을 향해 있었습니다.", "조연이었고"],
    ["2017년 SBS Plus '수요일 오후 3시 30분'에서는 공나연 역으로 주연을 맡았고, 2024년 tvN '플레이어 2: 꾼들의 전쟁'에서는 강지애로 출연했습니다.", "맡았고"],
    ["2025년에는 영화 '폭락'에 출연했고, 지금은 영화 '변신금지구역'으로 스크린 연기에 도전하고 있습니다.", "출연했고"],
    ["2016년 뷰티 인터뷰에서 \"화장품 자체에 관심이 없었다\"고 말했고, 고등학교 때까지 화장을 하지 않았으며 메이크업을 시작한 지 2~3년이라고 했습니다.", "말했고"],
    ["이 방송은 하정우와의 열애를 축하받는 자리였고, 본인의 이미지를 직접 짚은 방송이기도 했습니다.", "자리였고"],
    ["\"내가 워낙 저음이다 보니 목소리만 듣고 차분할 거라고 오해를 하시더라\"고 털어놨고, 사복까지 스타일리스트가 입혀 주는 줄 아는 시선에는 \"전부 내가 고른 것\"이라고 답했습니다.", "털어놨고"],
    ["하정우는 10월 1일 '변신금지구역' 촬영장에 커피차를 보냈고, 배우가 이를 인스타그램에 인증했습니다.", "보냈고"],
    ["배우는 \"잘 먹었슴다 감사함다\"라는 글과 함께 하정우 계정을 태그했고, 하정우는 \"변신금지구역 모든 배우, 스태프들 응원합니다\"라고 적었습니다.", "태그했고"],
  ];
  const preserved = [
    "강연희는 재이(서예지)와 학창 시절부터 맞서 온 라이벌이고, 차문숙(이혜영)의 그림자 남순자(염혜란)의 딸입니다.",
    "배우의 본명은 차미영이고, 1989년 10월 18일 부산에서 태어났습니다.",
    "화제가 된 아이템은 메종 마르지엘라 룩과 발목 위로 올라오는 장목 양말이고, 7월 8일에는 블랙 튜브톱에 블랙 와이드팬츠를 입은 사진을 올렸습니다.",
  ];
  assert(targets.length === 13 && preserved.length === 3, "실측 픽스처 개수 (13 + 3)");

  for (const [sentence, token] of targets) {
    const out = fix(sentence);
    assert(out.body === dropComma(sentence, token), `제거 대상: ${sentence}\n  → ${out.body}`);
  }
  for (const sentence of preserved) {
    assert(fix(sentence).body === sentence, `보존 대상이 바뀌었다(이고 병렬·다중 쉼표): ${sentence}`);
  }
  const whole = fix(targets.map((t) => t[0]).join("\n\n") + "\n\n" + preserved.join("\n\n"));
  assert(whole.removed.filter((r) => r.includes("연결어미 뒤 쉼표")).length === 13, `제거 로그 13건 (실제 ${whole.removed.length})`);
  assert(fix(whole.body).body === whole.body && fix(whole.body).removed.length === 0, "멱등: 두 번 돌려도 같다");

  // 과교정 방지 - 아래는 전부 그대로여야 한다.
  const untouched: Array<[string, string]> = [
    ["쉼표 2개 이상(나열)", "그는 데뷔했고, 영화에 출연했고, 드라마에도 나왔습니다."],
    ["쉼표 2개 이상(절 나열)", "A는 웃었고, B는 울었으며, C는 떠났습니다."],
    ["인용 안 쉼표", "그는 \"웃었고, 울었다\"고 말했습니다."],
    ["곡선 따옴표 인용 안", "그는 “웃었고, 울었다”고 말했습니다."],
    ["명사 신고·광고·공고", "광고 신고, 접수는 공고 기간에 가능합니다."],
    ["문두 접속부사 하지만", "하지만, 결과는 달랐습니다."],
    ["문두 접속부사 그래서·따라서", "그래서, 그는 떠났습니다. 따라서, 결론은 같습니다."],
    ["문두 접속부사 이어서", "이어서, 다음 순서를 보겠습니다."],
    ["그렇지만", "그렇지만, 선택은 달랐습니다."],
    ["이며 병렬", "그는 배우이며, 감독이기도 합니다."],
    ["소제목", "**데뷔했고, 이후 활동했습니다**"],
    ["이미지 마커", "[IMAGE: 웃었고, 울었다 — 웹 검색]"],
    ["불릿", "- 데뷔했고, 이후 활동했습니다"],
    ["표 행", "| 데뷔했고, 이후 | 활동 |"],
    ["frontmatter 줄", "search_description: 데뷔했고, 이후 활동했습니다"],
    ["는데·으나 등 다른 어미", "작품은 좋았는데, 반응은 갈렸습니다. 기대는 컸으나, 결과는 달랐습니다."],
    ["인용 조사 라고", "그는 이렇게 말했다고, 기자는 전했습니다."],
    ["쉼표 뒤 공백 없음", "출연료는 1,200원이었고1,500원이 됐습니다."],
    ["참고 자료 이후", "본문입니다.\n\n## 참고 자료\n\n- 데뷔했고, 이후 활동했습니다"],
  ];
  for (const [name, text] of untouched) {
    const out = fix(text);
    assert(out.body === text, `과교정: ${name}\n  전: ${text}\n  후: ${out.body}`);
  }
  // 숫자 쉼표는 나열 쉼표로 세지 않는다 - 단일 쉼표면 정상 제거된다.
  assert(fix("금액은 1,200원이었고, 이후 1,500원이 됐습니다.").body === "금액은 1,200원이었고 이후 1,500원이 됐습니다.", "숫자 천 단위 쉼표는 나열로 세지 않는다");
  // 문장마다 따로 판정한다.
  assert(
    fix("그는 웃었고, 모두가 따라 웃었습니다. 그는 울었고, 모두가 따라 울었습니다.").body === "그는 웃었고 모두가 따라 웃었습니다. 그는 울었고 모두가 따라 울었습니다.",
    "문장 단위로 각각 판정"
  );
  // 한 문장에 인용 밖 쉼표가 하나 + 인용 안 쉼표는 세지 않는다.
  assert(
    fix("그는 \"안녕, 친구\"라고 인사했고, 곧 떠났습니다.").body === "그는 \"안녕, 친구\"라고 인사했고 곧 떠났습니다.",
    "인용 안 쉼표는 문장 쉼표 개수에서 제외"
  );
  console.log("✅ C-11: 차정원 실측 13건 제거 / 3건 보존, 과교정 방지 19종, 멱등");
}

console.log("\n🎉 규칙 집행 테스트 통과");
