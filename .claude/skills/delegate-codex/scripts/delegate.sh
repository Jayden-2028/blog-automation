#!/usr/bin/env bash

set -euo pipefail

usage() {
  echo "Usage: $0 <read|write> <task-brief.md>" >&2
  exit 2
}

[[ $# -eq 2 ]] || usage

mode="$1"
task_candidate="$2"

command -v git >/dev/null 2>&1 || {
  echo "git is required" >&2
  exit 1
}

command -v codex >/dev/null 2>&1 || {
  echo "codex CLI is required" >&2
  exit 1
}

repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "Run this command inside a Git repository" >&2
  exit 1
}

if [[ "$task_candidate" != /* ]]; then
  task_candidate="$repo_root/$task_candidate"
fi

[[ -f "$task_candidate" ]] || {
  echo "Task brief not found: $task_candidate" >&2
  exit 1
}

task_dir="$(cd "$(dirname "$task_candidate")" && pwd -P)"
task_path="$task_dir/$(basename "$task_candidate")"

case "$task_path" in
  "$repo_root"/*) ;;
  *)
    echo "Task brief must be stored inside the repository" >&2
    exit 1
    ;;
esac

case "$mode" in
  read) sandbox="read-only" ;;
  write) sandbox="workspace-write" ;;
  *) usage ;;
esac

exec codex exec \
  --ephemeral \
  --sandbox "$sandbox" \
  --cd "$repo_root" \
  - < "$task_path"
