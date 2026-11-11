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

console.log("\n✅ testWorkflowEnv 전체 통과");
