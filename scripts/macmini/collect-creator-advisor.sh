#!/usr/bin/env bash
# Creator Advisor 수집(launchd가 매일 07:30에 한 번 부른다). 브라우저를 띄우므로 caffeinate로 절전을 막는다.
#
# 왜 맥에서 도는가: Creator Advisor는 네이버 로그인 세션이 붙은 persistent 브라우저 프로필에
# 의존해서 GitHub Actions 러너에서는 돌릴 수 없다(그래서 클라우드 이전 때 CREATOR_ADVISOR_ENABLED=false로
# 꺼뒀다). 이 스크립트가 그 공백을 메운다.
#
# 클라우드 job과 어떻게 이어지는가: 수집과 사용이 trend_candidates 테이블로 이미 분리돼 있다.
#   07:30 이 스크립트     -> trend_candidates에 source="creator_advisor" 행 upsert
#   08:00 social-issue    -> buildDailyQueryPool이 그 행을 읽어 query pool에 넣는다
# 클라우드 job은 collectionSources에 "creator_advisor"를 이미 넘기고 있고, buildDailyQueryPool의
# isSourceEnabled()가 enabledSources를 env보다 우선하므로(그 파일 주석 참고) **코드 변경이 필요 없다**.
# 클라우드의 CREATOR_ADVISOR_ENABLED=false는 "크롤링하지 마라"는 뜻일 뿐 "읽지 마라"가 아니다.
#
# 그래서 08:00보다 확실히 먼저 끝나야 한다 - 30분 여유를 뒀다(실측 수집 약 5초).
#
# 최초 1회 준비: npm run debug:creator-advisor (headless:false로 브라우저가 떠서 사람이 로그인한다).
# 프로필 폴더는 .env의 CREATOR_ADVISOR_PROFILE_DIR. 다른 맥에서 복사해 와도 동작하지 않는다.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG="$HOME/Library/Logs/blog-automation-creator-advisor.log"
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin"
cd "$REPO"
{
  echo "── $(date '+%Y-%m-%d %H:%M:%S')"
  # WRITE=1이 없으면 dry-run이라 DB에 아무것도 안 들어간다(runCollectionCli.ts).
  # enabled:true는 CLI가 직접 넘기므로 .env의 CREATOR_ADVISOR_ENABLED 값과 무관하게 수집된다.
  WRITE=1 /usr/bin/caffeinate -i npm run --silent collect:creator-advisor 2>&1
} >> "$LOG" 2>&1
tail -n 2000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
