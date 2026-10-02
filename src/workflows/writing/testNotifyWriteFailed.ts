// buildWriteFailedMessage / describeWriteFailure 테스트. 실제 발송 없음.
import { describeShortage } from "../research/describeResearchShortage.js";
import { buildWriteFailedMessage, describeWriteFailure } from "./notifyWriteFailed.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const JOB = { id: "e4ce18e5-2147-4382-8b81-360765dee83f", keyword: "최태원 SK 지분 9440억 매각 결정!" };

// 2026-10-02 실사고 원문(자료조사 verdict blocked라 writer가 draft를 안 만든 경우)
const BLOCKED_ERROR =
  "writer가 draft 파일을 만들지 않았습니다: /home/runner/work/x/drafts/최태원.md - 모델 응답: 자료조사 파일의 `verdict`가 `blocked`라서 원고를 쓰지 않았고 draft 파일도 만들지 않았습니다.";

const research = (counts: string) => `---\nkeyword: x\nverdict: blocked\nsource_counts:\n${counts}\n---\n## 1. 요약\n내용`;

function main(): void {
  console.log("▶ notifyWriteFailed 테스트 시작\n");

  // 1) 실사고 원문 -> 개발 용어·경로 없이 키워드 + 쉬운 사유만, 재시도 버튼 없음(같은 결과라서).
  const blocked = buildWriteFailedMessage(JOB, BLOCKED_ERROR, research("  official: 1\n  medical: 0\n  news: 6\n  community: 3"));
  assert(blocked.text.includes("원고 작성 실패"), "제목이 있어야 한다");
  assert(blocked.text.includes("최태원 SK 지분 9440억 매각 결정!"), "키워드가 있어야 한다");
  assert(blocked.text.includes("자료가 부족"), "쉬운 사유가 있어야 한다");
  assert(blocked.text.includes("공식 자료(공공기관·법원 등)가 1건뿐"), `어떤 자료가 모자란지 알려야 한다: ${blocked.text}`);
  assert(!blocked.text.includes("보강") && !blocked.text.includes("다시 쓸 수"), "이유만 알린다 - 보강/재작성 안내는 없다");
  assert(!/verdict|blocked|draft|\/home|npm run/.test(blocked.text), `개발 용어/경로가 없어야 한다: ${blocked.text}`);
  const row = blocked.replyMarkup?.inline_keyboard[0] ?? [];
  assert(row.length === 2, `자료 부족은 버튼 2개(자료조사 다시 하기 / 반려)여야 한다 (실제: ${row.length})`);
  const [rerunButton, rejectButton] = row;
  assert("callback_data" in rerunButton && rerunButton.callback_data === `research:rerun:${JOB.id}`, "첫 버튼은 rerun");
  assert(rerunButton.text.includes("자료조사 다시"), "rerun 버튼 문구");
  assert("callback_data" in rejectButton && rejectButton.callback_data === `research:reject:${JOB.id}`, "둘째 버튼은 reject");
  assert(rejectButton.text.includes("반려"), "reject 버튼 문구");
  console.log("✅ 자료 부족(blocked) -> 키워드 + 쉬운 사유 + [자료조사 다시 하기][반려] 버튼");

  // 2) 시간 초과 -> 재시도 버튼(research:retry:<jobId>).
  const timeout = buildWriteFailedMessage(JOB, "헤드리스 실행이 1200000ms 안에 끝나지 않아 중단했습니다.");
  assert(timeout.text.includes("너무 오래 걸려"), "시간 초과 사유");
  const button = timeout.replyMarkup?.inline_keyboard[0]?.[0];
  assert(button && "callback_data" in button && button.callback_data === `research:retry:${JOB.id}`, "다시 시도 버튼 callback_data");
  assert(button.text.includes("다시 시도"), "버튼 문구");
  console.log("✅ 시간 초과 -> 쉬운 사유 + [다시 시도] 버튼");

  // 2-1) 모자란 자료 설명: 전체 건수 / 커뮤니티뿐 / 조사 파일 없음.
  assert(describeShortage(research("  official: 0\n  medical: 0\n  news: 1\n  community: 2"))?.includes("3건뿐"), "전체 5건 미만");
  assert(describeShortage(research("  official: 0\n  medical: 0\n  news: 0\n  community: 9"))?.includes("커뮤니티 글뿐"), "커뮤니티뿐");
  assert(describeShortage(research("  official: 3\n  medical: 0\n  news: 6\n  community: 1")) === null, "공식 자료가 충분하면 모자란 점을 지어내지 않는다");
  assert(describeShortage(null) === null, "조사 파일이 없으면 null");
  assert(!buildWriteFailedMessage(JOB, BLOCKED_ERROR, null).text.includes("건뿐"), "조사 파일 없으면 일반 문구만");
  console.log("✅ 모자란 자료 설명(전체 건수 / 커뮤니티뿐 / 공식 자료 부족)");

  // 3) 분류별 사유.
  assert(describeWriteFailure("claude가 종료 코드 1로 끝났습니다").reason.includes("응답하지"), "종료 코드");
  assert(describeWriteFailure("usage limit reached").reason.includes("한도"), "사용 한도");
  assert(describeWriteFailure("[research] NAVER 검색 실패").reason.includes("자료조사"), "자료조사 단계");
  assert(describeWriteFailure("뭔지 모르는 오류").action === "retry", "알 수 없는 오류는 다시 시도 버튼");
  console.log("✅ 오류 분류 -> 쉬운 사유");

  // 4) HTML 특수문자 이스케이프.
  const escaped = buildWriteFailedMessage({ id: JOB.id, keyword: "5<10 & 후기" }, "x");
  assert(escaped.text.includes("5&lt;10 &amp; 후기"), "키워드 이스케이프");
  console.log("✅ 키워드 HTML 이스케이프");

  console.log("\n✅ 전체 테스트 통과");
}

main();
