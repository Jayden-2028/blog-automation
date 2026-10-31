#!/usr/bin/env bash
# 자료조사 폴러(launchd가 60초마다 부른다. RESEARCH_PROVIDER=codex 전용 - 2026-11-01).
# 맥미니는 Codex만 돌린다(Codex CLI와 ChatGPT 구독 로그인이 맥에만 있다). 대기열이 없으면 조용히 끝난다(DB 조회 1회).
#
# caffeinate를 쓴다: Codex 조사 1건이 최대 25분이라 도중에 맥이 잠들면 통째로 날아간다(브라우저는 안 쓴다).
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG="$HOME/Library/Logs/blog-automation-research.log"
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin"
cd "$REPO"
{
  OUT=$(caffeinate -i npm run --silent job:research-poll 2>&1) || true
  # 처리 건이 있을 때만 로그를 남긴다 - 1분마다 빈 줄이 쌓이면 로그가 소음이 된다.
  if [[ -n "$OUT" ]]; then
    echo "── $(date '+%Y-%m-%d %H:%M:%S')"
    echo "$OUT"
  fi
} >> "$LOG" 2>&1
tail -n 2000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
