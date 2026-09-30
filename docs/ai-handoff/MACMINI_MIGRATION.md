# 맥미니 이전 가이드 (2026-09-29)

**결론**: 자동화 대부분(키워드·조사·집필·Blogspot 발행·감시)은 이미 GitHub Actions에서 돈다.
맥에 남은 일은 **5가지**뿐이다 - 그것만 새 맥미니로 옮기면 된다.

| 로컬 job | 주기 | 하는 일 | 필요한 것 |
|---|---|---|---|
| `naver-poll` | 60초 | 네이버 발행(브라우저 조작) | 네이버 로그인 세션 |
| `instagram-capture-poll` | 60초 | 인스타 캐러셀 캡처 | 인스타 로그인 세션, `IG_CAPTURE_AUTO=true` |
| `export-poll` | 60초 | 텔레그램 `⬇️ 맥으로 내려받기` 버튼 요청을 바로 처리 | 보관함 폴더 |
| `manuscript-export` | 30분 | 원고·이미지를 로컬 보관함으로 내려받기 | 보관함 폴더 |
| `creator-advisor` | 매일 07:30 | 네이버 Creator Advisor 트렌드 수집 → `trend_candidates` | Creator Advisor 로그인 세션, `CREATOR_ADVISOR_BLOG_ID` |

### Creator Advisor가 맥에만 있는 이유 (2026-09-30 추가)

네이버 로그인 세션이 붙은 브라우저 프로필이 필요해서 GitHub Actions 러너에서는 돌릴 수 없다.
클라우드 이전 때 `CREATOR_ADVISOR_ENABLED=false`로 꺼둔 뒤로 이 소스가 비어 있었는데, 맥미니가
생겨서 다시 채운다.

수집과 사용이 `trend_candidates` 테이블로 분리돼 있어 **코드 변경이 필요 없다**:

```
07:30 맥미니 creator-advisor  -> trend_candidates에 source="creator_advisor" 행 upsert
08:00 클라우드 social-issue    -> buildDailyQueryPool이 그 행을 읽어 query pool에 넣는다
```

클라우드 job은 `collectionSources`에 `"creator_advisor"`를 이미 넘기고 있고,
`buildDailyQueryPool`의 `isSourceEnabled()`가 `enabledSources`를 env보다 우선한다. 즉 클라우드의
`CREATOR_ADVISOR_ENABLED=false`는 "크롤링하지 마라"는 뜻이지 "읽지 마라"가 아니다.

**최초 1회 로그인**: `npm run debug:creator-advisor` (브라우저가 떠서 사람이 로그인한다).
프로필은 다른 맥에서 복사해 와도 동작하지 않는다 - 네이버 발행 프로필과 같다.

**수동 확인**: `WRITE=1 npm run collect:creator-advisor` (로그: `~/Library/Logs/blog-automation-creator-advisor.log`)

## 순서 (총 30~40분)

**A. 새 맥미니** (터미널)
1. Homebrew 설치(https://brew.sh) 후 저장소 받기
   `mkdir -p ~/blog-automation && cd ~/blog-automation && git clone <저장소 URL> prod && cd prod`
2. `bash scripts/macmini/setup.sh` (node 22, npm ci, Playwright 크롬, 폴더 생성)
3. 안내대로 직접 실행(sudo): `sudo pmset -a sleep 0 disksleep 0 displaysleep 10 autorestart 1 womp 1`
   + 시스템 설정에서 **자동 로그인**, **원격 로그인(SSH)** 켜기
4. `claude` 설치·로그인 (`curl -fsSL https://claude.ai/install.sh | bash` → `claude`)

**B. 비밀값 옮기기** (옛 맥 → 새 맥, AirDrop/USB. **git에 올리지 말 것**)
5. 옛 맥의 `.env` → 새 `~/blog-automation/prod/.env`
   - `/Users/wooahpapa/...` 같은 **절대경로**(`IG_BROWSER_PROFILE` 등)는 새 사용자 홈으로 고친다.
   - 나머지(Supabase·Telegram·Blogger·GitHub 토큰 등)는 그대로 쓴다.

**C. 로그인 세션 다시 만들기** (브라우저 프로필은 복사해도 안 된다 - 쿠키가 맥 키체인으로 암호화됨)
6. `npm run setup:naver-publish` → 뜨는 창에서 **네이버 발행 계정(whyissuenow)** 로그인
7. (인스타 쓰면) `npm run ig:login` → 인스타 로그인
8. 네이버 첫 확인은 기본 **비공개**(`NAVER_PUBLISH_VISIBILITY` 미설정)로 한다.

**D. 점검 → 전환 (이 순서 지킬 것)**
9. `bash scripts/macmini/doctor.sh` → ❌ 없을 때까지 고친다
10. **옛 맥에서 먼저 내린다**: `launchctl bootout gui/$(id -u)/<라벨>` + `launchctl disable ...`
    (라벨은 `launchctl list | grep -i blog`로 확인 - 옛 plist 이름은 `com.wooahpapa.blog-automation.*`)
    ⚠️ 두 맥이 동시에 돌면 **네이버에 같은 글이 두 번** 올라갈 수 있다(락은 맥 안에서만 유효).
11. 새 맥: `bash scripts/macmini/install-launchd.sh install` → `... status`로 🟢 5개 확인
12. 텔레그램에서 원고 1건으로 `🟢 네이버 발행` 버튼을 눌러 종단 확인 → `~/Library/Logs/blog-automation-*.log`

## 되돌리기
- 새 맥: `bash scripts/macmini/install-launchd.sh uninstall`
- 옛 맥: 위 10번의 `launchctl enable` + `bootstrap`으로 복구. 데이터는 Supabase에 있어 이전으로 잃는 것이 없다.

## 알아둘 점
- 맥미니가 꺼져 있는 동안 네이버 요청은 DB에 쌓였다가 켜지면 처리된다(자동 재시도는 없음 - 실패 시 버튼 `(재시도)`).
- 새 맥 IP/지역이 바뀌면 네이버가 재인증을 요구할 수 있다 → 6번을 다시 한다.
- 전원·자동 로그인은 GUI 브라우저 세션에 필요하다. FileVault를 켰다면 재부팅 뒤 한 번은 직접 로그인해야 한다.
- 이 저장소는 `prod`를 **일반 clone**으로 쓴다(옛 맥의 worktree 구조는 필요 없다). 갱신: `git pull && npm ci`.
- 원고 보관함(`~/blog-automation/blog-manuscripts`)의 **기존 파일**이 필요하면 옛 맥에서 폴더째 복사한다
  (없어도 `manuscript-export`가 Supabase 원본에서 다시 내려받는다).
