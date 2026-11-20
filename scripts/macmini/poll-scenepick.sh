#!/usr/bin/env bash
# scenepick 폴러(launchd가 120초마다 부른다 - 2026-11-21). 맥미니의 Codex CLI(ChatGPT 구독 로그인)로 원고·이미지를 만든다.
# 대기열이 없으면 조용히 끝난다(DB 조회 1회). 1건이 최대 80분(Codex 40분 x 2회)이라 caffeinate로 잠들기를 막는다.
# 겹친 발화는 Node 쪽 파일 락(logs/.scenepick-poll.lock)이 막는다.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG="$HOME/Library/Logs/blog-automation-scenepick.log"
# codex 설치 위치(보통 /opt/homebrew/bin 또는 ~/.local/bin)가 PATH에 있어야 한다. 다른 곳이면 CODEX_CLI_PATH로 직접 지정한다
# (runHeadlessCodex.ts resolveCodexBinary가 그 값을 먼저 본다).
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin"
cd "$REPO"
{
  OUT=$(caffeinate -i npm run --silent job:scenepick-poll 2>&1) || true
  if [[ -n "$OUT" ]]; then
    echo "── $(date '+%Y-%m-%d %H:%M:%S')"
    echo "$OUT"
  fi
} >> "$LOG" 2>&1
tail -n 2000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
