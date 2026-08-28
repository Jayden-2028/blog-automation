---
name: delegate-codex
description: Delegate bounded repetitive coding, test additions, static checks, or research to Codex while Claude remains project lead and independently validates the result. Use when a task is clearly scoped and token efficiency benefits from Codex execution.
---

# Delegate to Codex

Claude remains responsible for scope, architecture, approval gates, validation, and user reporting.

## Before delegation

1. Read `AGENTS.md` and `docs/ai-handoff/CODEX_TASK_TEMPLATE.md`.
2. Confirm the task is bounded repetitive coding, test work, static checking, or research.
3. Keep design decisions, migration execution, production changes, and article writing in Claude.
4. If the task crosses an approval gate in `CLAUDE.md`, get user approval before delegating.
5. Write one completed task brief inside the repository, normally under `.claude/delegations/`.

## Run

For review or research that must not edit files:

```bash
.claude/skills/delegate-codex/scripts/delegate.sh read .claude/delegations/<task>.md
```

For an explicitly bounded coding task:

```bash
.claude/skills/delegate-codex/scripts/delegate.sh write .claude/delegations/<task>.md
```

The wrapper uses an ephemeral Codex session and only `read-only` or `workspace-write` sandboxing. Never replace it
with `danger-full-access`, bypass approval flags, or an unrestricted external directory.

## After delegation

1. Treat Codex output as unverified.
2. Inspect `git status` and the complete diff.
3. Reject scope creep and preserve unrelated user changes.
4. Run or review the relevant tests yourself.
5. Decide whether to accept, revise, or roll back only the delegated changes.
6. Update `docs/ai-handoff/CURRENT_STATE.md` when the project state materially changes.
7. Report the verified result and next approval point to the user.

If Codex cannot proceed without expanded authority, do not silently widen the sandbox or task. Resume the work in
Claude and request the needed decision.
