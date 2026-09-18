#!/usr/bin/env bash
# scripts/install_git_hooks.sh — one-time wire-up of the tracked
# .githooks/ directory as git's hookspath (§465 fork-1 lesson,
# 2026-08-04).
#
# Runs `git config core.hooksPath .githooks` at the workspace root so
# every commit runs .githooks/pre-commit → tools/fork_lint.py. The
# hooks live in the repo so all clones share them; installation is a
# per-clone step (git deliberately does not auto-enable hooks from
# checked-out files, to prevent hostile-repo attacks).
#
# Idempotent — safe to run repeatedly. Reports the resulting
# core.hooksPath so the operator sees the wire is up.

set -euo pipefail

WS="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$WS" ]]; then
    echo "install_git_hooks: not inside a git worktree." >&2
    exit 2
fi
cd "$WS"

if [[ ! -d ".githooks" ]]; then
    echo "install_git_hooks: .githooks/ missing — check out the branch that carries it." >&2
    exit 2
fi
if [[ ! -f ".githooks/pre-commit" ]]; then
    echo "install_git_hooks: .githooks/pre-commit missing." >&2
    exit 2
fi

chmod +x .githooks/pre-commit
git config core.hooksPath .githooks
echo "install_git_hooks: core.hooksPath = $(git config --get core.hooksPath)"
echo "install_git_hooks: pre-commit hook active. Next commit runs tools/fork_lint.py."
