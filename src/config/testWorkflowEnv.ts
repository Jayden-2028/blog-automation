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

// 3) **사용자가 결과를 기다리는 워크플로는 실패하면 그 자리에서 알려야 한다.** 품질 게이트가
//    사람인 파이프라인에서 알림 없는 실패는 파이프라인이 멈춘 것과 같다(2026-11-11 run
//    43040388380 - 사용자는 몇 시간 뒤 뷰어를 직접 열어 보고서야 알았다). 스텝 레벨이어야 하는
//    이유: 그 run은 `npm run`에 닿지도 못하고 죽어, 코드 안의 try/catch로는 잡히지 않는다.
//    2026-11-12에 준비 하나에서 여섯으로 넓혔다 - 조사·집필·번역·수정·이미지 교체도 사용자가
//    기다리는 자리다(교체는 11/11 apt 장애로 run 10개가 죽는 동안 알림이 한 통도 없었다).
{
  // jobId: 어느 원고인지 아는 워크플로는 FAILED_JOB_ID로 넘겨 대기열 추측을 건너뛴다. 출처가
  // 워크플로마다 다르다 - 넷은 workflow_dispatch 입력, image-pick은 뷰어가 보낸 payload다.
  const INPUT_JOB_ID = "${{ inputs.job_id }}";
  const needFailureNotify: { file: string; jobId?: string }[] = [
    { file: "job-research.yml", jobId: INPUT_JOB_ID },
    { file: "job-write.yml", jobId: INPUT_JOB_ID },
    { file: "job-translate.yml", jobId: INPUT_JOB_ID },
    { file: "job-revise.yml", jobId: INPUT_JOB_ID },
    { file: "job-publish-prepare.yml" },
    // 2026-11-12 추가. 11/11 apt 장애 때 run 10개가 죽었는데 알림이 한 통도 없었고, 사용자는
    // 교체가 오는 줄 알고 계속 기다렸다. 되살리는 길은 명령이 아니라 "후보를 한 번 더 누르기"다.
    { file: "image-pick.yml", jobId: "${{ github.event.client_payload.jobId }}" },
  ];

  for (const { file, jobId } of needFailureNotify) {
    const yml = read(file);
    const start = yml.indexOf("실패 알림 (트랙 봇)");
    assert(start > 0, `${file}에 실패 알림 단계가 없다 - 실패하면 아무도 모른다`);
    const nextStep = yml.indexOf("\n      - name:", start);
    const step = yml.slice(start, nextStep === -1 ? undefined : nextStep);

    assert(/if:\s*failure\(\)/.test(step), `${file} 실패 알림 단계에 if: failure()가 없다`);
    assert(
      step.includes("node scripts/notifyWorkflowFailure.mjs"),
      `${file} 실패 알림이 node 직실행이 아니다 - npm ci가 흔들린 run에서는 알림도 같이 죽는다`
    );
    assert(!/npm run|tsx|npx/.test(step), `${file} 실패 알림이 node_modules에 기대고 있다(npm/tsx/npx)`);

    // 트랙 봇을 고르려면 조회(Supabase)와 봇 3종 자격증명이 전부 필요하다.
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
      assert(step.includes(key), `${file} 실패 알림 단계에 ${key.replace(":", "")}가 없다 - 그 트랙 봇으로 보낼 수 없다`);
    }

    // 문구가 워크플로마다 달라야 한다(무엇이 멈췄는지·다시 돌리는 명령). 그 분기는 이 변수로 한다.
    assert(
      step.includes(`FAILED_WORKFLOW_FILE: ${file}`),
      `${file} 실패 알림에 FAILED_WORKFLOW_FILE이 자기 파일명으로 들어가 있지 않다 - 다른 워크플로 문구가 나간다`
    );

    if (jobId) {
      assert(
        step.includes(`FAILED_JOB_ID: ${jobId}`),
        `${file} 실패 알림의 FAILED_JOB_ID가 ${jobId}가 아니다 - 이미 아는 job을 대기열로 추측하게 된다`
      );
    } else {
      assert(!step.includes("FAILED_JOB_ID:"), `${file}에는 job_id 입력이 없는데 FAILED_JOB_ID를 넘긴다`);
    }
  }
  console.log(
    `✅ 사용자가 기다리는 워크플로 ${needFailureNotify.length}개 모두 실패하면 트랙 봇으로 알린다(의존성 없는 node 경로)`
  );
}

// 4) 큐를 마감하는 워크플로에서는 실패 알림이 **마감보다 앞**이어야 한다. 마감(always())이 실패한
//    것까지 "집필 실패"로 알리면, 이미 원고를 받은 사용자에게 거짓 경보가 간다.
{
  for (const file of ["job-research.yml", "job-write.yml", "job-revise.yml"]) {
    const yml = read(file);
    const notify = yml.indexOf("실패 알림 (트랙 봇)");
    const drain = yml.indexOf("Drain pipeline queue");
    assert(drain > 0, `${file}에 Drain pipeline queue 단계가 없다`);
    assert(notify < drain, `${file}의 실패 알림이 큐 마감 뒤에 있다 - 마감 실패까지 알림이 나간다(거짓 경보)`);
  }
  console.log("✅ 큐를 마감하는 셋은 실패 알림이 마감보다 앞이다");
}

// 5) 뷰어 후보 클릭 교체의 Chromium·Claude 설치는 **긴 세로 이미지를 자를 때만** 쓰는 보조 도구다.
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

// 6) 같은 원고의 교체는 **한 번에 하나씩** 돌아야 한다. 겹치면 나중에 끝난 run이 옛 상태로 배포해
//    앞 교체를 덮고(2026-11-12 한효주 - 1번 누르고 3번을 눌렀더니 1번만 남았다),
//    `mergeMetadata`가 read-modify-write라 DB의 images 배열까지 되돌아간다.
//
//    그래서 job이 둘이다(2026-11-12 큐 전환):
//      - enqueue: **concurrency 그룹이 없다.** 요청을 image_pick_requests에 적는 쪽이 그룹 안에 들어가면
//        대기 중 취소(그룹당 대기분 1개 한도)로 **요청 자체가 사라진다** - 그게 이번 개편으로 없앤 구멍이다.
//      - apply: jobId별 그룹 + cancel-in-progress: false + needs: enqueue. 큐를 비운다.
{
  const yml = read("image-pick.yml");

  const enqueueStart = yml.indexOf("  enqueue:");
  const applyStart = yml.indexOf("  apply:");
  assert(enqueueStart > 0, "image-pick.yml에 enqueue job이 없다 - 요청을 큐에 적는 자리가 사라졌다");
  assert(applyStart > enqueueStart, "image-pick.yml에서 apply job을 찾지 못했다(enqueue 뒤에 있어야 한다)");

  // enqueue의 job 헤더(steps 앞까지)에 concurrency가 있으면 안 된다.
  const enqueueHeader = yml.slice(enqueueStart, yml.indexOf("    steps:", enqueueStart));
  assert(
    !/concurrency:/.test(enqueueHeader),
    "image-pick.yml의 enqueue job에 concurrency가 걸려 있다 - 대기 중 취소로 요청이 큐에 쌓이지도 못하고 사라진다"
  );
  assert(
    /image_pick_requests/.test(yml.slice(enqueueStart, applyStart)),
    "image-pick.yml의 enqueue가 image_pick_requests에 적지 않는다 - 큐가 비어 apply가 할 일이 없다"
  );

  const applyHeader = yml.slice(applyStart, yml.indexOf("    steps:", applyStart));
  assert(
    /needs:\s*enqueue/.test(applyHeader),
    "image-pick.yml의 apply에 needs: enqueue가 없다 - 큐에 적기 전에 비우려 들면 자기 요청을 놓친다"
  );
  assert(
    /concurrency:/.test(applyHeader),
    "image-pick.yml의 apply job에 concurrency가 없다 - 같은 원고의 교체 둘이 겹치면 나중 배포가 앞 교체를 덮는다"
  );
  assert(
    /group:\s*image-pick-\$\{\{\s*github\.event\.client_payload\.jobId\s*\}\}/.test(applyHeader),
    "image-pick.yml의 concurrency group이 jobId별이 아니다 - 원고 하나가 밀리면 다른 원고까지 같이 기다린다"
  );
  assert(
    /cancel-in-progress:\s*false/.test(applyHeader),
    "image-pick.yml이 cancel-in-progress: true다 - 먼저 누른 교체가 죽는다(이어서 돌아야 한다)"
  );
  // needs만 걸면 enqueue 실패가 apply를 **조용히 skipped로** 만든다 - 스텝이 아예 돌지 않으니
  // if: failure() 알림도 걸리지 않고, run은 초록색으로 끝난 것처럼 보인다. 취소만 멈춤 사유다.
  assert(
    /if:\s*\$\{\{\s*!cancelled\(\)\s*\}\}/.test(applyHeader),
    "image-pick.yml의 apply에 if: !cancelled()가 없다 - enqueue가 실패하면 교체가 조용히 건너뛰어진다"
  );
  console.log("✅ image-pick: 요청은 그룹 밖에서 큐에 쌓이고, 같은 원고의 적용은 줄을 서서 하나씩 비운다");
}

console.log("\n✅ testWorkflowEnv 전체 통과");
