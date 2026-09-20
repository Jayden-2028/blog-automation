# 작업 흐름 — 폴더·브랜치·배포

기준일: 2026-09-15 (⚠️ 2026-09-14 클라우드 이전 Phase 2~4 완료로 §1/§4/§5 일부 낡음 - 아래
갱신 박스부터 읽을 것)

> ## 2026-09-15 갱신 — 폴더를 `~/blog-automation/` 아래로 모았다
>
> 흩어져 있던 폴더 3개를 한곳에 모았다. **역할과 규칙은 그대로이고 위치만 바뀌었다.**
>
> | 예전 | 지금 | 역할 |
> |---|---|---|
> | `~/Documents/blog-automation` | `~/blog-automation/repo` | 메인 저장소(개발 브랜치) |
> | `~/blog-automation-prod` | `~/blog-automation/prod` | worktree · **항상 `main` 고정** |
> | `~/blog-automation-kw` | `~/blog-automation/kw` | worktree · 키워드 수집 브랜치 |
> | `~/Documents/blog-manuscripts` | `~/blog-automation/blog-manuscripts` | 원고·이미지 보관함(사람이 여는 자리) |
>
> 원고 폴더는 처음엔 링크만 걸어 두었다가 **2026-09-20에 실제로 옮겼다**(사용자). 발행용 보관함은
> `blog-manuscripts/whyissuenow/<날짜>/<주제>/`이고, 코드는 `MANUSCRIPT_EXPORT_ROOT`(기본값은
> 워크트리 부모 기준 상대경로)로 이 자리를 가리킨다 - 어느 워크트리에서 실행해도 같은 곳이다.
> 그 아래 `naver-parenting` 등은 이 파이프라인과 무관한 별개 수동 프로젝트라 내부 경로를 흔들지 않는다.
>
> ⚠️ **이동 때 걸린 것**: `prod`의 `.env`·`.local`·`logs`와 `kw`의 `.env`는 `repo`를 가리키는
> 심볼릭 링크인데, 절대경로라 이동 직후 전부 끊겼다(= 로컬 실행 시 비밀값이 통째로 사라짐).
> `repo` 기준 새 경로로 다시 걸어 고쳤다. 앞으로 이 폴더들을 또 옮긴다면 `git worktree repair`
> 다음에 **끊긴 심링크 점검**을 반드시 같이 한다:
> `find prod kw -maxdepth 1 -type l ! -exec test -e {} \; -print`
>
> 아래 §1 표의 경로는 이동 전 이름이다. 읽을 때 위 표로 치환할 것.

세션(창)을 기능별로 여러 개 열어 병렬 작업하면서 "어디에 뭐가 있고 뭐가 반영됐는지"를 놓치는
일이 반복돼 만든 문서다. **헷갈릴 때 여기부터 본다.**

---

> ## 2026-09-14 갱신 — 자동화 실행 환경이 로컬 launchd → GitHub Actions(클라우드)로 바뀜
>
> `docs/ai-handoff/CLOUD_MIGRATION.md` Phase 2~4 완료로, **자동화는 이제 이 맥의 launchd가 아니라
> GitHub Actions가 `origin/main`을 체크아웃해서 돈다.** 로컬 blog-automation launchd 5개는 전부
> `launchctl disable`로 영구 비활성화됐다(`docs/ai-handoff/CURRENT_STATE.md` 참고).
>
> **아래 §1의 "왜 나눴나"(launchd가 그 폴더의 브랜치를 그대로 실행한다)는 더 이상 실행 환경의
> 이유가 아니다** - GitHub Actions는 로컬 폴더가 아니라 GitHub 저장소의 `main` 브랜치를 직접
> 체크아웃하므로, 이 맥의 어느 폴더에 어떤 브랜치가 체크아웃돼 있는지는 자동화 동작에 더 이상
> 영향을 주지 않는다.
>
> **그래도 두 폴더 구분은 유지한다** - 이유가 "launchd 오염 방지"에서 "작업 중인 Claude 세션이
> `main`을 실수로 건드리지 않게" 로 바뀌었을 뿐이다. `~/blog-automation/prod`는 여전히 `main`
> 고정 워크트리로 쓰고, 실제 코드 수정은 개발 폴더/작업 브랜치에서 한다.
>
> **"배포"의 의미도 바뀌었다** - 예전엔 §4처럼 운영 폴더에서 `git pull` + `npm run build`가
> 필요했지만, 지금은 **`main`에 push되는 순간이 곧 배포다**(GitHub Actions가 다음 스케줄/이벤트
> 발화 때 자동으로 최신 `main`을 받아 실행). 로컬 운영 폴더의 코드가 옛날 것이어도 클라우드 실행에는
> 영향 없다 - 다만 이 폴더에서 로컬 스크립트를 직접 돌려보며 검증할 때는 여전히 `git pull`이 필요하다.
>
> Cloudflare Pages 배포(원고 페이지)도 이제 `job-publish-prepare.yml`(GitHub Actions)이 수행한다 -
> 로컬 `publish-poll`이 하던 일과 동일하되 트리거가 텔레그램 승인 콜백 직후 이벤트로 바뀌었다.
>
> §3(세션 병행 규칙)·§5(용어 사전 중 커밋/푸시/머지/브랜치 개념)·§6(자주 겪는 상황)은 실행 환경과
> 무관하게 여전히 유효하다 - "머지 안 하면 다른 세션·클라우드가 못 본다"는 원칙은 그대로다.

---

## 1. 폴더 두 개의 역할 (2026-09-14 이전 기준 — 위 갱신 박스 참고)

| | `~/Documents/blog-automation` (개발) | `~/blog-automation-prod` (운영) |
|---|---|---|
| 무엇 | Claude·Codex가 코드를 고치는 곳 | Claude가 `main`을 다루는 고정 워크트리 |
| 브랜치 | 작업마다 바뀜 | **항상 `main` 고정** |
| 자동화 실행 환경 | ❌ 무관 | ❌ 무관(2026-09-14부터 - GitHub Actions가 `origin/main`을 직접 실행) |
| 브랜치 변경 | 자유 | **금지** |

`.env` / `.local` / `logs`는 운영 폴더에서 개발 폴더로 심링크돼 있어 설정은 공유된다.

**왜 아직도 나누나**: 예전엔 "launchd가 이 폴더의 브랜치를 그대로 실행해서"였지만, 지금은 자동화가
GitHub 쪽 `main`만 보므로 그 이유는 사라졌다. 지금 이유는 **작업 중인 브랜치 전환이 실수로 `main`
워크트리를 건드리지 않게** 분리해두는 것뿐이다.

**중요한 귀결**: 개발 폴더에서 커밋·푸시해도 자동화에는 자동 반영되지 않는다. **`main`에 병합
(push)해야** GitHub Actions가 다음 실행부터 새 코드를 쓴다 - 아래 §4는 "운영 폴더에 pull하는" 옛
절차이니, 클라우드 자동화 갱신 자체는 push만으로 끝난다는 점에 유의(로컬에서 직접 스크립트를 돌려
검증하고 싶을 때만 pull이 필요).

---

## 2. 현황 확인 (제일 먼저 할 것)

```
npm run status:all
```

한 화면에 나온다:
- 브랜치별 병합 여부와 미병합 커밋 목록
- **운영 폴더가 main보다 몇 커밋 뒤처졌는지**(= 배포 필요 여부)
- 개발 폴더의 커밋 안 된 변경

`logs/status.html`로도 저장되니 브라우저에 띄워두고 새로고침해도 된다.

원고 job 쪽 현황(제목 ↔ jobId)은 별도다:

```
npm run report:jobs
```

---

## 3. 세션이 여러 개일 때의 규칙

병렬 세션이 서로 밟지 않게 하는 최소 규칙이다.

1. **세션 하나 = 브랜치 하나.** 다른 세션의 브랜치를 건드리지 않는다.
2. **브랜치는 짧게 산다.** 한 덩어리 작업이 끝나면 그날 안에 `main`에 병합한다.
   오래 살수록 `main`과 벌어져 병합 비용이 커지고, 다른 세션은 그 변경을 못 받는다.
3. **작업 시작 전에 `main`을 받아온다.** 이것이 "한 곳의 변경이 다른 곳에 적용되는" 유일한 경로다.
   ```
   git fetch origin && git merge origin/main
   ```
4. **공용 파일은 병합을 먼저 한다.** `CLAUDE.md`, `package.json`, `docs/ai-handoff/*`는 여러 세션이
   동시에 고치기 쉬운 파일이라, 여기를 고치는 작업일수록 빨리 병합한다.

> 대시보드는 벌어진 상태를 **보여줄 뿐 막지 못한다.** 실제로 상태를 하나로 유지하는 것은
> "끝나면 바로 main에 병합"이라는 규칙이다.

---

## 4. 병합과 배포

미병합 브랜치를 main에 넣는다(개발 폴더에서):

```
git fetch origin
git checkout <브랜치>
git merge origin/main
npm run build
git checkout -b temp-merge origin/main
git merge <브랜치>
git push origin temp-merge:main
```

> 개발 폴더에서 `git checkout main`은 안 된다 — main이 운영 worktree에 잡혀 있다.
> 위처럼 임시 브랜치를 거치거나, 운영 폴더에서 직접 병합한다.

운영 폴더 코드 갱신(로컬 검증·수동 실행용 - 2026-09-14부터 **클라우드 자동화 자체엔 필수 아님**,
`main` push만으로 GitHub Actions는 최신 코드를 쓴다):

```
git -C ~/blog-automation/prod pull
npm --prefix ~/blog-automation/prod ci
npm --prefix ~/blog-automation/prod run build
```

배포 후 `npm run status:all`로 "배포 최신"이 뜨는지 확인한다.

---

## 5. 용어 사전

### 코드가 사는 세 곳

```
[내 맥: 개발 폴더]  --푸시-->  [GitHub]  --풀-->  [내 맥: 운영 폴더]
    코드를 고치는 곳            중앙 보관소        자동화가 실행하는 곳
```

### 용어

| 용어 | 뜻 | 비유 |
|---|---|---|
| **커밋**(commit) | 변경한 것들을 하나의 묶음으로 **기록**. 아직 내 컴퓨터 안에만 있다 | 사진 찍어 앨범에 붙이기 |
| **푸시**(push) | 커밋들을 **GitHub로 올림**. 커밋이 없으면 푸시할 것도 없다 | 앨범을 인터넷에 업로드 |
| **풀**(pull) | GitHub 것을 **내 컴퓨터로 받아옴**. 푸시의 반대 | 업로드된 앨범 내려받기 |
| **브랜치**(branch) | 코드의 **평행 작업 사본**. main에서 갈라져 작업하고 다시 합친다 | 문서 사본 떠서 고치기 |
| **main** | **완성된 것만 모이는 기준 브랜치**. 운영 폴더는 이것만 본다 | 원본 문서 |
| **머지**(merge) = **병합** | 브랜치를 다른 브랜치에 **합치기**. 둘은 완전히 같은 말이다 | 사본의 수정사항을 원본에 반영 |
| **PR**(Pull Request) | "이 브랜치를 main에 합쳐도 될까요?"라는 **제안서**. GitHub 웹에서 리뷰·논의용이고, 필수는 아니다(바로 머지도 가능) | 결재 올리기 |
| **배포**(deploy) | 완성된 코드를 **실제 돌아가는 곳(운영 폴더)으로 옮기고 빌드**하는 것 | 원본을 현장에 배포 |
| **세션**(session) | Claude와 대화하는 **창 하나**. 보통 창 하나가 브랜치 하나를 맡는다 | 작업자 한 명 |
| **launchd** | 맥의 **예약 실행 장치**. 2026-09-14 이전엔 이걸로 자동화를 돌렸으나 지금은 blog-automation
  관련 launchd job 5개 전부 `disable` 상태(안 씀) | 알람시계 (윈도우의 작업 스케줄러, 지금은 꺼둠) |
| **GitHub Actions** | 2026-09-14부터의 **실제 실행 장치**. cron(스케줄) 또는 웹훅/이벤트로
  `origin/main`을 체크아웃해 `npm run job:...`을 실행한다 | 클라우드에 있는 알람시계 겸 작업자 |
| **job** | **두 가지 뜻이 있어 헷갈리기 쉽다** ↓ | |

**job의 두 가지 뜻**
1. **워크플로우 job** — 예약/이벤트로 실행되는 작업 단위. 이제는 `.github/workflows/*.yml`
   5종(`social-issue-keyword` 09:00 KST cron, `entertainment-keyword` 09:10 KST cron,
   `community-keyword` 13:00 KST cron, `telegram-update`(텔레그램 웹훅 이벤트),
   `job-research`/`job-write`(리서치·작성 요청 이벤트), `job-publish-prepare`(승인 콜백 이벤트))가
   맡는다. 예전엔 같은 이름의 launchd job이 이 자리를 대신했다(전부 disable됨,
   `docs/ai-handoff/CURRENT_STATE.md` 참고).
2. **article_jobs** — **원고 1건**의 작업 단위. 텔레그램에서 Go를 누르면 하나 생긴다.
   재시도 명령에 넣는 `jobId`가 바로 이것이다.

### 코드에서 자주 나오는 말

**파서**(parser) — 덩어리 텍스트에서 **필요한 정보만 뽑아 구조로 만드는 것**. 영수증에서 날짜·금액만
뽑아 가계부에 옮겨 적는 일과 같다. AI·웹사이트는 사람이 읽는 형태로 결과를 주는데 프로그램은 딱
떨어지는 값이 필요해서, 그 사이를 번역한다.

- `parseResearchFile` — 자료조사 `.md`에서 verdict·출처 개수·§10 표
- `parseDraftFile` — 원고 `.md`에서 제목·본문·해시태그
- `parseTrendPage` — Creator Advisor HTML에서 키워드 목록

> 파서가 틀리면 **파일 내용은 멀쩡한데 시스템만 잘못 판단한다.** 2026-09-03에 실제로
> `verdict: ok        # ok | thin | blocked`의 주석까지 값으로 읽어 `ok`를 `thin`으로 오분류했다.

**폴링**(polling) — 주기적으로 "새 거 있나?"를 **계속 물어보는 방식**. 우편함을 5분마다 열어보는 것.
반대는 초인종(webhook)으로, 상대가 알려주는 방식이다. **2026-09-14 이전엔** 맥에 인터넷에서 접근
가능한 서버 주소가 없어 `telegram-poll`(5분)·`publish-poll`(10분)로 폴링했다.

**2026-09-14부터는 둘 다 초인종(이벤트) 방식으로 바뀌었다** - Cloudflare Worker가 텔레그램 웹훅을
받아 GitHub Actions를 즉시 발화하고(`telegram-update`), 승인(✅) 콜백 처리 직후 발행 준비도 바로
발화한다(`job-publish-prepare`). 폴링의 부작용(버튼 반응 최대 5분 지연, 맥이 꺼지면 무응답)은
해소됐다 - 상세는 `docs/ai-handoff/CLOUD_MIGRATION.md` Phase 3/4.

### 흐름과 "빠뜨리면 생기는 증상"

```
브랜치 만들기 → 코드 수정 → 커밋 → 푸시 → (PR) → 머지(=병합) → 배포
```

| 빠뜨린 단계 | 증상 |
|---|---|
| 커밋 | 푸시할 것이 없다 |
| 푸시 | GitHub에 없어서 **다른 세션·다른 컴퓨터가 못 본다** |
| 머지 | main에 없어서 **다른 세션에도 운영에도 반영되지 않는다**. 다른 폴더에서 `npm run ...` 하면 "Missing script" |
| 배포(로컬 운영 폴더만 해당) | `main`에는 있지만 로컬 운영 폴더가 옛 코드라 **로컬에서 직접 돌린
  스크립트만 예전처럼 동작한다** - 2026-09-14부터 GitHub Actions 자동화는 `main` push만으로 갱신됨 |

`npm run status:all`은 이 중 **머지와 (로컬 폴더) 배포가 빠졌는지**를 보여준다.

---

## 6. 자주 겪는 상황

**"명령이 없다(Missing script)"** — 그 기능이 아직 이 폴더의 브랜치에 없다. `status:all`로 어느
브랜치에 있는지 확인하고 병합하거나 그 브랜치로 이동한다.

**"고쳤는데 클라우드 자동화가 옛날처럼 동작한다"** — 그 커밋이 `main`에 병합(push)되지 않은 것이다.
GitHub Actions는 `main`만 본다 - 로컬 pull/build는 필요 없다.

**"고쳤는데 로컬에서 직접 돌린 스크립트가 옛날처럼 동작한다"** — main에는 들어갔지만 지금 실행
중인 로컬 폴더에 배포(pull)가 안 된 것이다. §4 배포 명령 실행.

**"어떤 세션이 뭘 했는지 모르겠다"** — `status:all`의 미병합 목록에 커밋 제목이 나온다.
그것으로 어느 창의 작업인지 판별한다.
