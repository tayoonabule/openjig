---
name: openjig-update
description: Sync the openjig fork (tayoonabule/openjig) with upstream OpenRig (mvschwarz/openrig). Rebases the fork's jcode-support commits onto the latest upstream, resolves conflicts, reviews the fork's code against upstream's quality bar, runs the full gate suite, rebuilds and reinstalls the local `rig` CLI, restarts the daemon, and pushes. Use when asked to "update openjig", "pull latest openrig", "sync the fork with upstream", "rebase openjig", or "/openjig-update".
allowed-tools: bash, read, edit, write, agentgrep, todo, swarm
---

# Update openjig from upstream OpenRig

openjig is a thin fork: upstream OpenRig plus a small, rebase-friendly stack of commits that
make `jcode` a first-class runtime (see `OPENJIG.md`). This skill keeps that stack
on top of the newest upstream, holds it to upstream's quality bar, and leaves the machine running
the result.

`SKILL_DIR` is the directory containing this file. The helper does the mechanical steps and
prints what it observed. You own every decision between steps.

```bash
H="$SKILL_DIR/scripts/openjig-update.sh"
```

## Invariants

- Remotes: `origin` = `tayoonabule/openjig` (the fork, pushable), `upstream` =
  `mvschwarz/openrig` (read-only, never push, never open PRs there from this workflow).
- Upstream is authoritative for upstream code. The fork's job is to add jcode support on top,
  not to diverge. When a conflict mixes both, keep upstream's new behaviour AND re-apply the
  fork's jcode intent to it. Never silently drop a fork feature: if one no longer fits, rework
  it on the new upstream shape or report it explicitly.
- Rebase, do not merge: history stays "upstream + fork commits". Every sync writes a backup ref
  `openjig-backup/<timestamp>` first.
- Seats live in tmux and survive a daemon restart. Never run `rig down` as part of an update.
- Pushing rewritten history uses `--force-with-lease` only (the helper's `push`).

## Workflow

Track these steps with the todo tool.

1. **Preflight.** `bash "$H" preflight`. Stops on uncommitted tracked changes, the wrong branch,
   or an in-progress rebase (untracked scratch is allowed and never deleted). Read the new
   upstream commits: note any touching runtime adapters, `startup.ts`, skill discovery,
   projection, permission posture, or runtime unions — likely follow-up spots even without a conflict.

2. **Sync.** `bash "$H" sync`. Exit 3 means a conflict. For each conflicted path:
   - Read both sides: `git show upstream/main:<path>`, the fork commit being replayed
     (`git show REBASE_HEAD`), and `git log -p upstream/main -- <path>` for why upstream changed.
   - Produce a result that keeps upstream's change and re-expresses the fork's jcode addition in
     upstream's new structure. Do not blindly take ours or theirs.
   - `git add <path>`, then `bash "$H" continue`. Repeat until the rebase completes.
   - If the rebase goes wrong, `bash "$H" abort` restores the pre-sync state.

3. **Semantic follow-up (no conflict does not mean correct).** Find places upstream added that
   enumerate runtimes and now lack jcode:
   ```bash
   git diff "$(cat .git/openjig-update/pre-sync-head)"...upstream/main --stat
   git grep -nE '"(codex|claude-code|pi)"' -- 'packages/*/src' | grep -v jcode
   ```
   Compare each new runtime union, switch, map, or list against how jcode is handled in the
   neighbouring cases. Add jcode where the feature genuinely works for it (see the capability
   table in `OPENJIG.md`), with a test mirroring the codex case. Commit such fixes
   as their own `fix(jcode): ...` commit on top.

   Then check the two kept jcode twins (`specs/rigs/launch/first-project-jcode/`,
   `specs/rigs/launch/implementation-pair-jcode/`) against their upstream starter
   (`../first-project/rig.yaml`, `../implementation-pair/rig.yaml`):
   ```bash
   diff packages/daemon/specs/rigs/launch/first-project/rig.yaml packages/daemon/specs/rigs/launch/first-project-jcode/rig.yaml
   diff packages/daemon/specs/rigs/launch/implementation-pair/rig.yaml packages/daemon/specs/rigs/launch/implementation-pair-jcode/rig.yaml
   ```
   Carry any upstream change over by hand (new/removed seats, agent refs, culture) while keeping
   every seat on `runtime: jcode` with its pinned model. Commit as
   `chore(jcode): sync jcode starter twins`.

4. **Validate.** `bash "$H" validate` runs `npm install`, `build`, `lint`, `test:repo`, and the
   daemon, cli, tui, and ui suites, logging to `.git/openjig-update/logs/`. If any suite fails, run
   `bash "$H" compare-failures`: it re-runs each failing test file on a clean upstream worktree
   and labels it PRE-EXISTING (fails upstream too, not ours) or REGRESSION / FORK-ONLY FAIL (ours
   to fix). Fix every regression before going further. Some upstream suites exercise a real
   `codex`, `ps`, or tmux and fail on some machines; that is exactly what the comparison filters.

5. **Quality review of the fork's changes.** The fork's code must be indistinguishable in quality
   from upstream's. Review the whole fork diff, not just what changed this sync:
   ```bash
   git diff upstream/main...HEAD --stat
   git diff upstream/main...HEAD
   ```
   For a non-trivial diff, spawn reviewers with `swarm` in parallel (for example
   `openai-oauth:gpt-6-sol` for correctness and design, `openai-oauth:gpt-5.6-terra` for tests
   and style), each given the diff range and this checklist, and have them report findings with
   file:line rather than editing. Checklist:
   - Matches surrounding conventions: naming, module layout, error shapes, comment style
     (comments explain why, never narrate), commit message format (`feat(daemon): ...`).
   - Minimal footprint in upstream files: new behaviour lives in new jcode files; shared files get
     a case, a map entry, or a union member, not a refactor. Flag anything that will conflict on
     every sync and suggest how to move it into a jcode-owned file.
   - Honest capability claims: jcode features that do not exist (permission modes) are
     refused or reported as not applicable, never faked.
   - Tests: each jcode behaviour has a deterministic test mirroring the codex or claude one; no
     test depends on a real jcode binary unless it is clearly marked and skipped when absent.
   - No machine-specific values: read the portability section of the validate output.
   Apply the fixes that hold up, re-run the affected tests, and commit them as
   `refactor(jcode): ...` or `fix(jcode): ...`. Re-run `bash "$H" validate` after fixes.

6. **Install locally.** `bash "$H" install` builds the publishable package
   (`scripts/build-package.sh`, which stamps the commit into the build), packs it, and installs it
   globally with `npm install -g`, so `rig` on PATH is this exact commit.

7. **Restart the service.** `bash "$H" restart` stops the daemon (bounded, drain-certified) and
   starts it from the new install. tmux seats keep running. If stop refuses to certify a drain,
   read `$OPENRIG_HOME/daemon.log` before retrying; do not kill processes blindly.

8. **Verify.** `bash "$H" verify` checks that `/healthz` reports the commit just built and that
   `jcode` is on PATH. Then run a real jcode smoke when a jcode seat exists (`rig ps --nodes` and
   confirm jcode seats show ready), or for a quick standalone check:
   ```bash
   rig whoami --help >/dev/null && rig ps --nodes | head
   ```

9. **Publish.** `bash "$H" push` force-pushes `main` to `origin` with a lease. Upstream is never a
   push target.

## Completion report

Report in a few lines: upstream commit synced to, number of fork commits replayed, conflicts and
how each was resolved, semantic follow-ups added, gate results (with PRE-EXISTING failures named),
review findings applied or deferred, installed `rig --version`, daemon commit from `/healthz`,
and the pushed commit. If any step blocked, stop there, leave the backup ref in place, and say
which step and why.
