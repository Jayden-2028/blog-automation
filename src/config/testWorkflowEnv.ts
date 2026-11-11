// GitHub Actions 워크플로가 **코드가 기대하는 환경변수와 실패 처리**를 갖췄는지 정적으로 본다.
// 실행: npm run test:workflow-env (외부 호출 없음 - .github/workflows/*.yml 텍스트만 읽는다)
//
// 왜 코드 테스트인가: 2026-11-11 한효주 인물 백과 사고 두 건이 **코드가 아니라 워크플로 yml**에서 났다.
//  ① telegram-update.yml에 CLOUDFLARE_PAGES_PROJECT_NAME이 없어 키보드를 되살릴 때
//     cloudflarePagesUrl()이 null이었고 `📄 원고 페이지 열기` 줄이 통째로 빠졌다.
//  ② job-publish-prepare.yml의 폰트·Chromium 설치가 하드 실패라, apt 이름풀이 한 번 흔들린 것
//     (run 43040388380)으로 원고 재생성·뷰어 재배포·준비 완료 알림이 통째로 날아갔다.
// 둘 다 단위 테스트가 닿지 않는 자리라 yml 자체를 단정한다.
import { readFileSync } from "node:fs";
import { join } from "node:path";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const WORKFLOWS = join(process.cwd(), ".github", "workflows");
const read = (file: string): string => readFileSync(join(WORKFLOWS, file), "utf-8");

// 1) Pages 주소(cloudflarePagesUrl)가 필요한 워크플로는 전부 프로젝트 이름을 넘겨야 한다.
//    - 알림·키보드를 만드는 쪽(buildReadyKeyboard)과 뷰어를 배포하는 쪽이 같은 변수를 쓴다.
{
  const needPagesUrl = [
    "telegram-update.yml", // 버튼 복원(markReviewButtonsDecided / markPublishButtonSettled)
    "job-publish-prepare.yml", // 준비 완료 알림 + 뷰어 배포
    "manuscripts-refresh.yml",
    "manuscript-edit.yml",
    "image-pick.yml", // 교체 완료 알림에 📄 버튼이 붙는다
  ];
  for (const file of needPagesUrl) {
    assert(
      read(file).includes("CLOUDFLARE_PAGES_PROJECT_NAME:"),
      `${file}에 CLOUDFLARE_PAGES_PROJECT_NAME이 없다 - 📄 원고 페이지 열기 버튼과 뷰어 배포가 조용히 꺼진다`
    );
  }
  console.log(`✅ Pages 주소가 필요한 워크플로 ${needPagesUrl.length}개 모두 CLOUDFLARE_PAGES_PROJECT_NAME을 넘긴다`);
}

// 2) 원고 준비의 폰트·Chromium 설치는 **보조 기능**(페이지 캡처)이라 실패해도 준비를 멈추면 안 된다.
{
  const yml = read("job-publish-prepare.yml");
  const start = yml.indexOf("한글 폰트 + Chromium 설치");
  assert(start > 0, "job-publish-prepare.yml에서 폰트·Chromium 설치 단계를 찾지 못했다");
  const nextStep = yml.indexOf("\n      - name:", start);
  const step = yml.slice(start, nextStep === -1 ? undefined : nextStep);
  assert(
    /continue-on-error:\s*true/.test(step),
    "job-publish-prepare.yml의 폰트·Chromium 설치가 하드 실패다 - apt 한 번 흔들리면 원고 재생성·뷰어 재배포·알림이 통째로 날아간다"
  );
  console.log("✅ job-publish-prepare: 폰트·Chromium 설치 실패가 원고 준비를 멈추지 않는다");
}

// 3) 원고 준비가 실패하면 **그 자리에서 알림이 나가야 한다**. 품질 게이트가 사람인 파이프라인에서
//    알림 없는 실패는 파이프라인이 멈춘 것과 같다(2026-11-11 run 43040388380 - 사용자는 몇 시간 뒤
//    뷰어를 직접 열어 보고서야 알았다). 스텝 레벨이어야 하는 이유: 그 run은 job:publish-poll에
//    닿지도 못하고 죽어, 코드 안의 try/catch로는 잡히지 않는다.
{
  const yml = read("job-publish-prepare.yml");
  const start = yml.indexOf("실패 알림 (트랙 봇)");
  assert(start > 0, "job-publish-prepare.yml에 실패 알림 단계가 없다 - 실패하면 아무도 모른다");
  const nextStep = yml.indexOf("\n      - name:", start);
  const step = yml.slice(start, nextStep === -1 ? undefined : nextStep);

  assert(/if:\s*failure\(\)/.test(step), "실패 알림 단계에 if: failure()가 없다");
  assert(
    step.includes("node scripts/notifyWorkflowFailure.mjs"),
    "실패 알림이 node 직실행이 아니다 - npm ci가 흔들린 run에서는 알림도 같이 죽는다"
  );
  assert(!/npm run|tsx|npx/.test(step), "실패 알림이 node_modules에 기대고 있다(npm/tsx/npx)");

  // 트랙 봇을 고르려면 대기열 조회(Supabase)와 봇 3종 자격증명이 전부 필요하다.
  for (const key of [
    "SUPABASE_URL:",
    "SUPABASE_SERVICE_ROLE_KEY:",
    "TELEGRAM_BOT_TOKEN:",
    "TELEGRAM_CHAT_ID:",
    "SOCIAL_TELEGRAM_BOT_TOKEN:",
    "SOCIAL_TELEGRAM_CHAT_ID:",
    "KSCENE_TELEGRAM_BOT_TOKEN:",
    "KSCENE_TELEGRAM_CHAT_ID:",
  ]) {
    assert(step.includes(key), `실패 알림 단계에 ${key.replace(":", "")}가 없다 - 그 트랙 봇으로 보낼 수 없다`);
  }
  console.log("✅ job-publish-prepare: 실패하면 트랙 봇으로 알림이 나간다(의존성 없는 node 경로)");
}

// 4) 뷰어 후보 클릭 교체의 Chromium·Claude 설치는 **긴 세로 이미지를 자를 때만** 쓰는 보조 도구다.
//    없으면 그 경우만 원본을 쓰면 된다(cropTallImage는 launch 실패를 {ok:false}로, pickCropFocus는
//    claude 실행 실패를 focus 0으로 돌린다). 그런데 자체 시한이 없어서, apt가 흔들리면
//    `playwright install --with-deps`가 20초 간격으로 **계속 버티다** job의 10분 시한을 다 먹고
//    `manuscripts:image-pick`이 skipped로 떨어졌다 - 뷰어에서 후보를 눌러도 이미지가 바뀌지 않는다
//    (2026-11-11 14:12~16:02 run 10개 전부 cancelled). 평시 run 전체가 70초쯤이다.
{
  const yml = read("image-pick.yml");
  const start = yml.indexOf("Chromium + Claude Code CLI 설치");
  assert(start > 0, "image-pick.yml에서 Chromium·Claude 설치 단계를 찾지 못했다");
  const nextStep = yml.indexOf("\n      - name:", start);
  const step = yml.slice(start, nextStep === -1 ? undefined : nextStep);

  assert(
    /continue-on-error:\s*true/.test(step),
    "image-pick.yml의 Chromium·Claude 설치가 하드 실패다 - 보조 도구 설치 실패가 이미지 교체를 통째로 막는다"
  );
  const timeout = /timeout-minutes:\s*(\d+)/.exec(step);
  assert(
    timeout !== null,
    "image-pick.yml의 Chromium·Claude 설치에 자체 시한이 없다 - apt가 버티면 job 시한을 다 먹고 교체가 skipped로 떨어진다"
  );
  assert(
    Number(timeout[1]) <= 5,
    `image-pick.yml 설치 단계 시한이 ${timeout[1]}분이다 - 평시 run 전체가 70초쯤이므로 5분 이하여야 교체할 시간이 남는다`
  );
  console.log("✅ image-pick: Chromium·Claude 설치가 늦거나 실패해도 이미지 교체는 돈다");
}

console.log("\n✅ testWorkflowEnv 전체 통과");
