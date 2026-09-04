# 작업 흐름 — 폴더·브랜치·배포

기준일: 2026-09-04

세션(창)을 기능별로 여러 개 열어 병렬 작업하면서 "어디에 뭐가 있고 뭐가 반영됐는지"를 놓치는
일이 반복돼 만든 문서다. **헷갈릴 때 여기부터 본다.**

---

## 1. 폴더 두 개의 역할

| | `~/Documents/blog-automation` (개발) | `~/blog-automation-prod` (운영) |
|---|---|---|
| 무엇 | Claude·Codex가 코드를 고치는 곳 | **자동화가 실제로 실행하는 코드** |
| 브랜치 | 작업마다 바뀜 | **항상 `main` 고정** |
| launchd 4개 job | ❌ 안 봄 | ✅ 여기를 봄 |
| 브랜치 변경 | 자유 | **금지** |

`.env` / `.local` / `logs`는 운영 폴더에서 개발 폴더로 심링크돼 있어 설정은 공유된다.

**왜 나눴나**: launchd job은 그 폴더에 체크아웃된 브랜치를 그대로 실행한다. 한 폴더만 쓰면
개발 중 `git checkout`을 하는 순간 운영 자동화가 미완성 브랜치로 갈아탄다.

**중요한 귀결**: 개발 폴더에서 커밋·푸시해도 **운영에는 자동 반영되지 않는다.** main에 병합한 뒤
아래 배포 명령을 따로 실행해야 한다.

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

운영에 반영(배포):

```
git -C ~/blog-automation-prod pull
npm --prefix ~/blog-automation-prod ci
npm --prefix ~/blog-automation-prod run build
```

배포 후 `npm run status:all`로 "배포 최신"이 뜨는지 확인한다.

---

## 5. 자주 겪는 상황

**"명령이 없다(Missing script)"** — 그 기능이 아직 이 폴더의 브랜치에 없다. `status:all`로 어느
브랜치에 있는지 확인하고 병합하거나 그 브랜치로 이동한다.

**"고쳤는데 자동화가 옛날처럼 동작한다"** — main에는 들어갔지만 운영 폴더에 배포가 안 된 것이다.
§4 배포 명령 실행.

**"어떤 세션이 뭘 했는지 모르겠다"** — `status:all`의 미병합 목록에 커밋 제목이 나온다.
그것으로 어느 창의 작업인지 판별한다.
