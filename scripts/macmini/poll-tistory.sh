#!/usr/bin/env bash
# 티스토리 발행 폴러(launchd가 60초마다 부른다). poll-naver.sh와 같은 구조. 브라우저(headless)를 띄우므로
# caffeinate로 절전을 막는다. 로그인이 풀리면 폴러가 사회 봇으로 알리고 대기로 둔다 - 재로그인은
# 이 맥미니에서 `npm run setup:tistory`(창이 뜬다) 로 한다.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG="$HOME/Library/Logs/blog-automation-tistory-poll.log"
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin"
cd "$REPO"
{
  echo "── $(date '+%Y-%m-%d %H:%M:%S')"
  /usr/bin/caffeinate -i npm run --silent job:tistory-poll 2>&1
} >> "$LOG" 2>&1
tail -n 2000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
