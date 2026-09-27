#!/usr/bin/env bash
# openjig-update helper: the mechanical steps of keeping the openjig fork current with
# upstream OpenRig. Each subcommand does one bounded thing and prints what it observed, so the
# agent running /openjig-update can inspect the result before choosing the next step. Judgment
# calls (resolving conflicts, reviewing quality, deciding to push) stay with the agent.
#
# Usage: openjig-update.sh <preflight|sync|continue|abort|validate|compare-failures|install|restart|verify|push>
set -euo pipefail

REPO_ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
cd "$REPO_ROOT"

UPSTREAM_URL="${OPENJIG_UPSTREAM_URL:-https://github.com/mvschwarz/openrig.git}"
FORK_URL="${OPENJIG_FORK_URL:-https://github.com/tayoonabule/openjig.git}"
BRANCH="${OPENJIG_BRANCH:-main}"
STATE_DIR="$REPO_ROOT/.git/openjig-update"
mkdir -p "$STATE_DIR"

log() { printf '[openjig-update] %s\n' "$*"; }
die() { printf '[openjig-update] ERROR: %s\n' "$*" >&2; exit 1; }
conflicted_paths() { git diff --name-only --diff-filter=U; }
# Logs $1, runs "$@" (from $4) to $3, and dies naming $2 on failure.
run_or_die() { local desc="$1" label="$2" logfile="$3"; shift 3; log "$desc"; "$@" >"$logfile" 2>&1 || die "$label failed (see $logfile)"; }

# Native modules (better-sqlite3) are built for the Node that runs npm install. A shell whose PATH
# resolves a different Node (for example a login shell picking up an old /usr/local/bin/node) would
# rebuild them for that ABI and break every later test and the installed daemon.
require_supported_node() {
  local range major
  range="$(node -p 'require("./package.json").engines.node' 2>/dev/null)" || die "node is not on PATH"
  major="$(node -p 'process.versions.node.split(".")[0]')"
  printf '%s' "$range" | tr '|' '\n' | grep -qE "^[[:space:]]*\^${major}[[:space:]]*$" \
    || die "node $(node --version) at $(command -v node) is outside engines.node ($range); fix PATH first"
}

ensure_remote() {
  local name="$1" url="$2" actual
  git remote get-url "$name" >/dev/null 2>&1 || { git remote add "$name" "$url"; log "added remote $name -> $url"; }
  actual="$(git remote get-url "$name")"
  [ "${actual%.git}" = "${url%.git}" ] || die "remote $name points at $actual, expected $url"
}

cmd_preflight() {
  ensure_remote upstream "$UPSTREAM_URL"
  ensure_remote origin "$FORK_URL"
  [ "$(git branch --show-current)" = "$BRANCH" ] || die "not on $BRANCH (on $(git branch --show-current))"
  { [ -d "$(git rev-parse --git-path rebase-merge)" ] || [ -d "$(git rev-parse --git-path rebase-apply)" ]; } \
    && die "a rebase is already in progress; finish it with 'continue' or 'abort'"
  # Untracked files are allowed (scratch, local notes); the rebase leaves them alone and no step
  # below deletes a path it did not create in this run.
  [ -z "$(git status --porcelain --untracked-files=no)" ] || die "tracked changes present; commit or set them aside first"
  git fetch upstream --prune --quiet
  git fetch origin --prune --quiet
  local base ahead behind fork_ahead fork_behind
  base="$(git merge-base HEAD "upstream/$BRANCH")"
  ahead="$(git rev-list --count "upstream/$BRANCH..HEAD")"
  behind="$(git rev-list --count "HEAD..upstream/$BRANCH")"
  fork_ahead="$(git rev-list --count "origin/$BRANCH..HEAD")"
  fork_behind="$(git rev-list --count "HEAD..origin/$BRANCH")"
  log "fork commits on top of upstream: $ahead"
  log "new upstream commits to take:     $behind"
  log "local vs origin/$BRANCH:           ahead $fork_ahead, behind $fork_behind"
  log "current merge-base: $(git log -1 --format='%h %s' "$base")"
  [ "$fork_behind" = "0" ] || log "WARNING: origin/$BRANCH has commits this checkout lacks. Inspect 'git log HEAD..origin/$BRANCH' before syncing."
  echo; log "fork commits (oldest first):"; git log --reverse --format='  %h %s' "upstream/$BRANCH..HEAD"
  echo; log "upstream commits since merge-base (newest first, max 40):"; git log --format='  %h %s' -40 "HEAD..upstream/$BRANCH"
}

cmd_sync() {
  cmd_preflight >/dev/null
  if git merge-base --is-ancestor "upstream/$BRANCH" HEAD; then
    log "already contains upstream/$BRANCH; nothing to rebase"
    return 0
  fi
  local backup
  backup="openjig-backup/$(date +%Y%m%d-%H%M%S)"
  git branch "$backup" HEAD
  printf '%s\n' "$backup" > "$STATE_DIR/last-backup"
  git rev-parse HEAD > "$STATE_DIR/pre-sync-head"
  log "backup ref: $backup ($(git rev-parse --short HEAD))"
  if git rebase "upstream/$BRANCH"; then
    log "rebase complete: $(git rev-list --count "upstream/$BRANCH..HEAD") fork commits now on $(git rev-parse --short "upstream/$BRANCH")"
  else
    log "rebase stopped on a conflict. Conflicted paths:"
    conflicted_paths | sed 's/^/  /'
    log "resolve each (keep upstream's intent AND the fork's jcode behaviour), 'git add' them, then run: $0 continue"
    exit 3
  fi
}

cmd_continue() {
  local unresolved
  unresolved="$(conflicted_paths)"
  [ -z "$unresolved" ] || die "unresolved paths remain: $(printf '%s' "$unresolved" | tr '\n' ' ')"
  if GIT_EDITOR=true git rebase --continue; then
    log "rebase complete"
  else
    log "rebase stopped again. Conflicted paths:"
    conflicted_paths | sed 's/^/  /'
    exit 3
  fi
}

cmd_abort() {
  git rebase --abort 2>/dev/null || true
  local backup
  backup="$(cat "$STATE_DIR/last-backup" 2>/dev/null || true)"
  log "rebase aborted; HEAD is $(git rev-parse --short HEAD). Last backup ref: ${backup:-none}"
}

# Runs the same gates upstream contributors run (CONTRIBUTING.md), keeping logs so failures can
# be compared against upstream instead of guessed at.
cmd_validate() {
  require_supported_node
  local logs="$STATE_DIR/logs"
  mkdir -p "$logs"
  run_or_die "npm install" "npm install" "$logs/install.log" npm install --no-audit --no-fund
  run_or_die "npm run build" "build" "$logs/build.log" npm run build
  run_or_die "npm run lint (typecheck every package)" "lint" "$logs/lint.log" npm run lint
  local status=0
  log "npm run test:repo"
  npm run test:repo >"$logs/test-repo.log" 2>&1 || { status=1; log "test:repo FAILED (see $logs/test-repo.log)"; }
  for ws in daemon cli tui ui; do
    log "npm run test -w packages/$ws"
    npm run test -w "packages/$ws" >"$logs/test-$ws.log" 2>&1 || { status=1; log "packages/$ws tests FAILED (see $logs/test-$ws.log)"; }
  done
  log "portability report for fork changes"
  node scripts/portability-report.mjs --from "upstream/$BRANCH" --to HEAD >"$logs/portability.log" 2>&1 || true
  grep -q . "$logs/portability.log" && sed 's/^/  /' "$logs/portability.log" | head -40
  if [ "$status" -ne 0 ]; then
    log "some suites failed. Run '$0 compare-failures' to separate fork regressions from failures upstream also has."
    exit 4
  fi
  log "all gates green"
}

# Re-runs only the failing test files against a pristine upstream worktree, so a failure is
# attributed to the fork only when upstream passes that same file on this machine.
cmd_compare_failures() {
  require_supported_node
  local logs="$STATE_DIR/logs" wt
  local failing=()
  for ws in daemon cli tui ui; do
    [ -f "$logs/test-$ws.log" ] || continue
    while IFS= read -r file; do [ -n "$file" ] && failing+=("$ws:$file"); done \
      < <(grep -E '^ FAIL ' "$logs/test-$ws.log" | sed -E 's/^ FAIL +([^ ]+).*/\1/' | sort -u)
  done
  local repo_failing=()
  if [ -f "$logs/test-repo.log" ]; then
    while IFS= read -r name; do [ -n "$name" ] && repo_failing+=("$name"); done \
      < <(grep -E '^not ok [0-9]+ - ' "$logs/test-repo.log" | sed -E 's/^not ok [0-9]+ - //' | sort -u)
  fi
  [ "${#failing[@]}" -gt 0 ] || [ "${#repo_failing[@]}" -gt 0 ] || { log "no failing tests recorded"; return 0; }
  # A fresh directory this run created is the only thing it may remove afterwards.
  wt="$(mktemp -d "${TMPDIR:-/tmp}/openjig-upstream.XXXXXX")"
  git worktree add --detach "$wt" "upstream/$BRANCH" >/dev/null
  log "installing and building upstream in $wt (per-worktree install, never a symlinked node_modules)"
  (cd "$wt" && npm install --no-audit --no-fund >/dev/null 2>&1 && npm run build >/dev/null 2>&1) || die "upstream worktree build failed"
  local regressions=0
  for entry in ${failing[@]+"${failing[@]}"}; do
    local ws="${entry%%:*}" file="${entry#*:}"
    if [ ! -f "$wt/packages/$ws/$file" ]; then
      log "FORK-ONLY FAIL  packages/$ws/$file (file does not exist upstream)"
      regressions=$((regressions + 1))
    elif (cd "$wt/packages/$ws" && npx vitest run "$file" >/dev/null 2>&1); then
      log "REGRESSION      packages/$ws/$file (passes upstream, fails in fork)"
      regressions=$((regressions + 1))
    else
      log "PRE-EXISTING    packages/$ws/$file (fails upstream too)"
    fi
  done
  if [ "${#repo_failing[@]}" -gt 0 ]; then
    # Repository scripts use node --test, so compare failing test names rather than files.
    local upstream_repo_fail
    upstream_repo_fail="$(cd "$wt" && node --test scripts/*.test.mjs 2>&1 | grep -E '^not ok [0-9]+ - ' | sed -E 's/^not ok [0-9]+ - //' || true)"
    for name in "${repo_failing[@]}"; do
      if printf '%s\n' "$upstream_repo_fail" | grep -qxF "$name"; then
        log "PRE-EXISTING    test:repo \"$name\" (fails upstream too)"
      else
        log "REGRESSION      test:repo \"$name\" (passes upstream, fails in fork)"
        regressions=$((regressions + 1))
      fi
    done
  fi
  git worktree remove --force "$wt"
  [ "$regressions" -eq 0 ] || { log "$regressions fork regression(s) to fix"; exit 5; }
  log "every failure also fails upstream on this machine"
}

cmd_install() {
  require_supported_node
  run_or_die "building the publishable package (scripts/build-package.sh)" "build-package" \
    "$STATE_DIR/build-package.log" bash scripts/build-package.sh
  local pack_dir tarball
  # Pack outside the tree so no untracked tarball of the user's is ever touched.
  pack_dir="$(mktemp -d "${TMPDIR:-/tmp}/openjig-pack.XXXXXX")"
  tarball="$(cd packages/cli && npm pack --silent --pack-destination "$pack_dir" | tail -n1)"
  [ -f "$pack_dir/$tarball" ] || die "npm pack produced no tarball"
  run_or_die "installing $tarball globally" "global install" \
    "$STATE_DIR/install-global.log" npm install -g "$pack_dir/$tarball" --no-audit --no-fund
  rm -rf "$pack_dir"
  log "installed: $(rig --version) at $(command -v rig)"
}

# Restarts only the daemon. Seats live in tmux and survive this; `rig down` is never part of an
# update.
cmd_restart() {
  command -v rig >/dev/null || die "rig is not on PATH; run install first"
  log "status before: $(rig daemon status 2>&1 | head -1)"
  if rig daemon status 2>&1 | grep -q '^Daemon running'; then
    if ! rig daemon stop; then
      # A busy daemon can exhaust its drain budget and still exit. Only an actually stopped
      # daemon is restarted; the preserved shutdown record is surfaced for the agent to inspect.
      rig daemon status 2>&1 | grep -q '^Daemon running' \
        && die "daemon stop failed and the daemon is still running; inspect \$OPENRIG_HOME/daemon.log"
      log "WARNING: daemon exited without a clean drain. Shutdown record:"
      sed 's/^/  /' "${OPENRIG_HOME:-$HOME/.openrig}/daemon-shutdown.json" 2>/dev/null || true
    fi
  fi
  rig daemon start
  log "status after:  $(rig daemon status 2>&1 | head -1)"
}

cmd_verify() {
  local expected base healthz
  expected="$(git rev-parse HEAD)"
  log "expected commit: $expected"
  log "rig --version: $(rig --version)"
  rig daemon status
  base="$(daemon_base_url)"
  healthz="$(curl -fsS "$base/healthz" 2>/dev/null || true)"
  if [ -n "$healthz" ]; then
    log "healthz ($base): $healthz"
  else
    log "no /healthz answer from $base"
  fi
  if printf '%s' "$healthz" | grep -q "$expected"; then
    log "daemon reports the expected commit"
  else
    log "could not confirm the daemon commit from /healthz; compare 'rig --version' output with the expected commit"
  fi
  log "jcode runtime verification:"
  if command -v jcode >/dev/null; then jcode --version; else log "jcode not on PATH"; fi
}

# The daemon records the host and port it actually bound in daemon.json; OPENRIG_URL wins when an
# operator points the CLI somewhere else on purpose.
daemon_base_url() {
  if [ -n "${OPENRIG_URL:-}" ]; then printf '%s' "${OPENRIG_URL%/}"; return; fi
  local state="${OPENRIG_HOME:-$HOME/.openrig}/daemon.json"
  if [ -f "$state" ]; then
    node -e 'const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const host = !s.host || s.host === "0.0.0.0" ? "127.0.0.1" : s.host;
      process.stdout.write(`http://${host}:${s.port}`);' "$state" 2>/dev/null && return
  fi
  printf 'http://127.0.0.1:%s' "${OPENRIG_PORT:-7433}"
}

# The fork's history is rewritten by every rebase, so publishing needs a lease-protected force
# push. The lease refuses to clobber commits pushed to origin since our last fetch.
cmd_push() {
  git fetch origin --quiet
  git push --force-with-lease="$BRANCH:origin/$BRANCH" origin "$BRANCH"
  log "pushed $(git rev-parse --short HEAD) to origin/$BRANCH"
}

case "${1:-}" in
  preflight) cmd_preflight ;;
  sync) cmd_sync ;;
  continue) cmd_continue ;;
  abort) cmd_abort ;;
  validate) cmd_validate ;;
  compare-failures) cmd_compare_failures ;;
  install) cmd_install ;;
  restart) cmd_restart ;;
  verify) cmd_verify ;;
  push) cmd_push ;;
  *) sed -n '2,8p' "$0"; exit 64 ;;
esac
