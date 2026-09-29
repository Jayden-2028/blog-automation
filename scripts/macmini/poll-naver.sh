#!/usr/bin/env bash
# 네이버 발행 폴러(launchd가 60초마다 부른다). 브라우저를 띄우므로 caffeinate로 절전을 막는다.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG="$HOME/Library/Logs/blog-automation-naver-poll.log"
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin"
cd "$REPO"
{
  echo "── $(date '+%Y-%m-%d %H:%M:%S')"
  /usr/bin/caffeinate -i npm run --silent job:naver-poll 2>&1
} >> "$LOG" 2>&1
tail -n 2000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
