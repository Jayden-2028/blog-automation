#!/usr/bin/env bash
# 인물 백과 소스팩 수집 폴러(launchd가 60초마다 부른다. WRITING-HUMANIZE-2026-10.md §B-1).
# 브라우저 없이 plain fetch만 하므로 caffeinate가 필요 없다. 대기열이 없으면 조용히 끝난다(DB 조회 1회).
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG="$HOME/Library/Logs/blog-automation-person-pack.log"
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin"
cd "$REPO"
{
  OUT=$(npm run --silent job:person-pack 2>&1) || true
  # 처리 건이 있을 때만 로그를 남긴다 - 1분마다 빈 줄이 쌓이면 로그가 소음이 된다.
  if [[ -n "$OUT" ]]; then
    echo "── $(date '+%Y-%m-%d %H:%M:%S')"
    echo "$OUT"
  fi
} >> "$LOG" 2>&1
tail -n 2000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
