# STANDING.md — session doctrine
> Always loaded. If this contradicts a memory or an addendum, THIS FILE wins for
> doctrine; the ledger wins for the story of how the doctrine got adopted.
> Small on purpose (target ≤ 3 KB): rules that govern every session, not lore.

## Session rules (operator-set, hard)

1. **Every code-touching session ends with a commit.** The auto-deployer
   (`roboai-autodeploy.path` → `autodeploy_wrapper.sh`) watches the working
   branch and fires `scripts/deploy.sh` on any commit that touches `src/` or
   `frontend/`. A commit IS a deploy — there is no separate "deploy" step.
   Do not leave a session with uncommitted work; if the session is not
   code-touching, say so explicitly.

2. **No session may report "fixed" without a commit sha.** The report must
   include the sha (or the range for multi-commit work). Reports that say
   "deployed" without a sha are wrong — deploys are triggered by commits.

3. **Directives from the operator are executed, not deferred.** Do not
   decline. Do not "queue for later". If a safety rule is violated by the
   directive, say so in ONE line and stop — otherwise carry it out.

4. **Deploy is safety-gated for arm motion, not for opinions.** The wrapper
   waits for `jog_active == false` and `program.state != 2` before
   restarting services. It NEVER restarts under active motion. It NEVER
   silently gives up. Waiting >600s writes a heartbeat entry; the UI banner
   escalates.

5. **Deploy status is visible.** `/api/deploy_status` reads
   `/opt/cobot/deploy_log.jsonl`; the frontend renders a footer banner. A
   failed deploy is a red banner on every open client, not a silent nothing.

6. **When adding standing rules, follow the Program Doctrine flow**
   (`docs/PROGRAM_DOCTRINE.md`): amend the doctrine, land a `tests/doctrine/`
   pin, name the operator's approval in the commit message.

7. **Fork Registry is authoritative** (§465 fork-1 lesson, 2026-08-04).
   Before implementing any shared capability, grep `tools/fork_registry.yaml`.
   If the capability exists, route through the canonical owner — do not write
   a second implementation. Any NEW shared capability lands in the SAME commit
   as a registry entry (`id`, `canonical`, at least one `forbidden` block).
   A fix that adds a second implementation of a registered capability is a
   defect regardless of tests passing. The pre-commit hook + the auto-deploy
   `phase="lint_failed"` gate refuse forks automatically — `--no-verify`
   bypasses the local hook but the deploy still blocks. When a duplicate is
   truly load-bearing, file it as `known_debt` under the capability with a
   `why:` and an `owner:` — never silent-suppress.

## Ledger doctrine (addendum-36 §532; L249)

- **Ledger is a transaction log; sessions load a materialized view.** The
  full history lives in `docs/ledger/addendum-NN-*.md` (grep-on-demand).
  Small distillates load every session: this file (STANDING.md), STATE.md
  (current-truth), HARDWARE.md (constants), INDEX.md (topic map),
  LESSONS.md (one-line lesson index with pointers).
- **STATE.md wins for current state; ledger wins for history.**
- **Session ritual = three writes:** new `docs/ledger/addendum-NN-<slug>.md`
  + LESSONS.md append + STATE.md rewrite. Commit and push.
- **Lesson numbering:** tail-grep LESSONS.md before assigning a new N.
  Post-v46 lessons are a single continuous stream (244+), no per-addendum
  reset.

## Tool doctrine

- **Claude Code runs in tmux** (`tmux new -s claude`; L250). Anything whose
  death costs work — including this agent — must survive an SSH drop.
- **Verification before claim:** if a memory names a file/function/flag,
  grep or Read to confirm it exists before recommending action on it.
