#!/usr/bin/env bash
# 6주치 46커밋을 스프린트별 PR 6개로 소급 정리한다.
#
# 배경: docs/ai-handoff/CURRENT_STATE.md "인프라 정리". 그동안 로컬 단일 브랜치
# (feat/sprint-1-selection-loop)에 Sprint 1~4가 전부 쌓여 있어 되돌리기 지점도, 원격 백업도 없었다.
#
# Claude가 이미 한 것:
#   - backup/full-linear-history : 정리 전 46커밋 선형 히스토리 그대로 보존한 안전 브랜치
#   - feat/sprint-{0..5}-*       : 각 스프린트 경계 커밋을 가리키도록 재구성한 브랜치 (로컬만)
#
# 이 스크립트가 하는 것 (전부 원격 쓰기 - 그래서 Claude가 아니라 사용자가 실행):
#   1. origin/main에 베이스 4커밋 push
#   2. 스프린트 브랜치 6개 push
#   3. 스프린트별 PR 6개 생성 (base: main)
#
# PR 병합은 순서대로 해야 다음 PR diff가 깨끗하다(0 → 1 → 2 → 3 → 4 → 5).
# 병합까지 자동으로 하려면 끝의 MERGE=1 블록 주석을 풀거나 --merge로 실행한다.

set -euo pipefail

REPO="Jayden-2028/blog-automation"

BRANCHES=(
  "feat/sprint-0-daily-keyword-pipeline|Sprint 0 — 매일 키워드 수집·랭킹·알림 파이프라인 실가동"
  "feat/sprint-1-selection-loop|Sprint 1 — Telegram 선택 루프 (Go/Pass 버튼 → article_jobs)"
  "feat/sprint-2-research-writing|Sprint 2 — 자료조사 + 헤드리스 원고 생성 + 집필 전 체크포인트"
  "feat/sprint-3-review-images|Sprint 3 — 검수 게이트 4종 + AI 이미지 자동 생성·삽입"
  "feat/sprint-4-naver-publish|Sprint 4 — 네이버 반자동 발행 (임시저장까지)"
  "feat/sprint-5-infra-cleanup|인프라 정리 — 클라우드 감시인 + Supabase CLI 동기화"
)

echo "▶ 1. origin/main 베이스 push"
git push origin main

echo
echo "▶ 2. 스프린트 브랜치 push"
for entry in "${BRANCHES[@]}"; do
  b="${entry%%|*}"
  git push -u origin "$b"
done

echo
echo "▶ 3. PR 6개 생성 (base: main)"
for entry in "${BRANCHES[@]}"; do
  b="${entry%%|*}"
  title="${entry#*|}"
  if gh pr view "$b" --repo "$REPO" >/dev/null 2>&1; then
    echo "  · $b PR 이미 존재 - 건너뜀"
    continue
  fi
  gh pr create --repo "$REPO" --base main --head "$b" \
    --title "$title" \
    --body "스프린트별 소급 정리 PR. 상세는 \`docs/ai-handoff/\` 의 해당 SPRINT_*_DESIGN.md / CURRENT_STATE.md.

⚠️ 병합 순서: sprint-0 → 1 → 2 → 3 → 4 → 5. 앞 PR을 병합해야 이 PR diff가 해당 스프린트 커밋만 남는다.

정리 전 선형 히스토리는 \`backup/full-linear-history\` 브랜치에 그대로 보존돼 있다."
done

echo
echo "완료. 병합은 GitHub에서 순서대로(0→5) 'Create a merge commit'으로."
echo "또는 CLI로 순서대로:"
for entry in "${BRANCHES[@]}"; do
  echo "  gh pr merge ${entry%%|*} --repo $REPO --merge --delete-branch"
done
