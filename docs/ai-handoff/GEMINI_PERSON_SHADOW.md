# 인물 제미나이 그림자 트랙 - 맥미니 설정 (2026-11-19)

사용자의 Google AI 구독을 **Antigravity CLI(`agy`)** 로 쓴다. API 키·요금이 없고, 로그인은 맥미니에만 있어
맥미니 폴러가 돌린다(GitHub Actions 불가). 설계는 `CLAUDE.md`의 "인물 제미나이 그림자 트랙" 문단 참고.

## 설정 순서 (사용자가 맥미니에서)
1. `agy` 설치(공식 문서 https://antigravity.google/docs/cli/headless) 후 `which agy`로 위치 확인.
2. **한 번만 대화형 로그인**: 터미널에서 `agy`를 열어 구독 계정으로 로그인한다.
3. 확인: `agy -p "ping" --output-format json` -> `"status":"SUCCESS"`가 나오면 된다.
   (`agy models`로 모델 목록. 기본은 `gemini-3.8-flash-high`이고, 바꾸려면 `.env`에 `GEMINI_PERSON_MODEL=<id>`.)
4. 맥미니 `.env`(저장소 루트)에 SUPABASE 키는 이미 있다. 추가로 있으면 좋은 것:
   - `GITHUB_TOKEN`, `GITHUB_REPOSITORY`(`owner/repo`) - 있어야 완료 뒤 원고 페이지 갱신을 자동 발화한다. 없으면 텔레그램에 그렇다고 알리고 갱신만 건너뛴다.
   - `CLOUDFLARE_PAGES_PROJECT_NAME` - 텔레그램의 `📄 원고 페이지 열기` 링크용. 텔레그램 봇 토큰은 기존 폴러와 같다.
   - 선택: `AGY_EXTRA_ARGS`(공백 구분 추가 인자), `PERSON_GEMINI_SHADOW=false`(맥 쪽 스위치).
5. 수동 시험(한 건): `npm run job:gemini-person-poll -- <jobId> --force`
6. launchd 등록(**사용자 승인 후**):
   ```
   sed -e "s|REPO_PATH|$PWD|g" -e "s|HOME_PATH|$HOME|g" \
     scripts/macmini/com.blogautomation.gemini-person-poll.plist.template \
     > ~/Library/LaunchAgents/com.blogautomation.gemini-person-poll.plist
   launchctl enable gui/$(id -u)/com.blogautomation.gemini-person-poll
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.blogautomation.gemini-person-poll.plist
   ```
   해제: `launchctl bootout gui/$(id -u)/com.blogautomation.gemini-person-poll`
7. 로그: `~/Library/Logs/blog-automation-gemini-person.log` (처리한 건이 있을 때만 쓴다).

## 로그아웃을 알아채는 법
- `job.metadata.geminiShadow.error`와 텔레그램 한 줄에 **"맥미니 agy 로그인 필요"** 가 뜬다. 원고 페이지 제미나이 탭에도 그 사유가 보인다.
- 다시 로그인한 뒤 실패한 job은 `npm run job:gemini-person-poll -- <jobId> --force`로 다시 돌린다.
- 대기만 쌓이고 아무 일도 없으면: 로그 파일, `launchctl print gui/$(id -u)/com.blogautomation.gemini-person-poll`, `which agy`(launchd PATH에 있는지) 순으로 본다.

## 끄기
repo variable `PERSON_GEMINI_SHADOW=false`(큐에 올리는 쪽, telegram-update.yml) - 이미 올라간 대기분까지 멈추려면 맥 `.env`에도 같은 값을 둔다.
