#!/usr/bin/env bash
# 제미나이 인물 그림자 폴러(launchd가 120초마다 부른다 - 2026-11-19). 맥미니의 agy(Antigravity CLI) 구독 로그인으로 돈다.
# 대기열이 없으면 조용히 끝난다(DB 조회 1회). 1건이 최대 30분이라 caffeinate로 잠들기를 막는다.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG="$HOME/Library/Logs/blog-automation-gemini-person.log"
# agy 설치 위치(보통 ~/.local/bin 또는 /opt/homebrew/bin)가 PATH에 있어야 한다.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin"
cd "$REPO"
{
  OUT=$(caffeinate -i npm run --silent job:gemini-person-poll 2>&1) || true
  if [[ -n "$OUT" ]]; then
    echo "── $(date '+%Y-%m-%d %H:%M:%S')"
    echo "$OUT"
  fi
} >> "$LOG" 2>&1
tail -n 2000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
