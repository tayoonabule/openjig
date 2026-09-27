# openjig

openjig is a fork of [OpenRig](https://github.com/mvschwarz/openrig) that makes
[jcode](https://github.com/1jehuang/jcode) a first-class runtime. A rig member can declare
`runtime: jcode` and get the same lifecycle as a Claude Code or Codex seat: launch in tmux,
guidance and skill projection, message delivery, readiness, activity, session capture and
resume.

Everything that is not about jcode is upstream OpenRig, unchanged. The fork is kept as a small
set of commits on top of upstream `main` (see [Staying in sync](#staying-in-sync)).

**Just want to use it?** Read [GUIDE.md](GUIDE.md): rigs, projects, missions and slices in plain
English, and how to switch between projects day to day.

## Using jcode in a rig

```yaml
pods:
  - id: dev
    members:
      - id: impl
        agent_ref: "local:agents/impl"
        runtime: jcode
        model: gpt-6-sol        # optional; passed to `jcode -m`
        cwd: "."
```

Requirements: `jcode` on `PATH` and signed in to at least one provider (`jcode login`). Check
with `rig setup --dry-run`, which reports jcode as an optional harness, and `jcode --version`.

### Running every seat on jcode

- **Kernel:** `rig config set kernel.runtime jcode` (or `OPENRIG_KERNEL_RUNTIME=jcode`) makes the
  auto-booted kernel use the jcode-only variant. The default, `auto`, keeps upstream's
  Claude/Codex order and only falls back to jcode when neither is signed in. The setting applies
  when the kernel is next created; to switch an existing kernel, run `rig down kernel --delete
  --snapshot` and restart the daemon.
- **Models per seat:** the jcode kernel pins a model to each role: advisor lead
  `claude-opus-5` (planning and judgment), operator agent `gpt-6-astra` (balanced), queue worker
  `gpt-5.6-luna` (fast and cheap). Change one with `rig seat set-model <seat> <model>`. A resumed
  jcode session keeps the model it was saved with, so the new model applies to the seat's next
  fresh occupant (for example `rig up <rig> --existing --fresh <seat>`). `jcode
  model list` shows the ids your accounts can use.
- **Your own rigs:** set `runtime: jcode` and a `model:` on each member.
- **Starter rigs:** two upstream starters have a jcode twin with the same seats and agents, all
  on jcode: `first-project-jcode` and `implementation-pair-jcode`. Launch one with, for example,
  `rig up implementation-pair-jcode --cwd <repo>`. Models follow the role: orchestrators, leads
  and release managers get `claude-opus-5`, reviewers and QA `claude-sonnet-5`, planners
  `gpt-6-astra`, builders `gpt-5.6-luna`. Checkers deliberately run on a different provider
  from builders, keeping upstream's cross-runtime review. The twins are hand-maintained copies
  of the upstream starters; write `runtime: jcode` into any other rig yourself.

OpenRig does not choose models by cost or performance on its own. Every seat runs the model its
spec or `set-model` pins, or the harness default when none is set.

## How a jcode seat works

| Concern | How openjig handles it |
| --- | --- |
| Launch | `jcode --no-update --no-selfdev -C <cwd> [-m <model>]` in the seat's tmux pane. |
| Seat identity inside the agent | Each seat runs its own jcode server (`JCODE_RUNTIME_DIR=$OPENRIG_HOME/state/jcode/<seat>/runtime`, `JCODE_TEMP_SERVER=1`). jcode tools run in the server process, so the server must carry the seat's `OPENRIG_*` environment for `rig` commands the agent runs to know which seat they came from. Before every fresh launch or resume, openjig stops any server still left in that seat's runtime dir, so a new occupant never inherits the previous occupant's hooks or environment. If that stop fails, jcode is not launched. The user's shared jcode server is never touched. The temporary server exits 30 minutes after its last client disconnects. |
| Guidance | Managed block in the workspace `AGENTS.md`, which jcode reads natively. |
| Skills | Projected to `<cwd>/.agents/skills`. jcode also discovers `.jcode/skills`, `.claude/skills`, and the user-level equivalents, so the `openrig-skills` seed in `~/.agents/skills` is found without extra setup. |
| Messages | The shared tmux paste then Enter path used for every runtime. Multi-line messages submit as one turn. |
| Readiness | The seat's own debug socket (enabled per seat with `JCODE_DEBUG_SOCKET=1`) is authoritative: `ready` for this workspace means ready, `running` means busy. Without it, readiness falls back to jcode's numbered input prompt (`1>`, `2>`, ...) at the bottom of the pane, with jcode as the foreground process. Old scrollback does not count. Login or onboarding screens are reported as needing attention, not ready. |
| Activity | jcode lifecycle hooks (`turn_start`, `turn_end`, `session_start`, `session_end`) are set per seat through `JCODE_HOOK_*` environment variables and relayed to OpenRig's activity feed. `~/.jcode/config.toml` is not modified. |
| Session capture | The jcode session id is read from the seat's debug socket (`jcode debug sessions`). If the socket is unavailable, openjig falls back to `~/.jcode/sessions/*.json` created after the launch in the same working directory, but only when exactly one such session exists. When two seats start in one directory at once, it records no id rather than guess. Stored as resume type `jcode_id`. |
| Resume | `jcode --resume <session_id>` in the same workspace. |
| Fork | `rig seat handover <seat> --source fork:<seat or session>` and rigspec `session_source: {mode: fork, ref: {kind: native_id, value: <jcode session id>}}` run `jcode session fork <id> --json`, then resume the new copy. The parent session is untouched and the seat records the fork's id. Needs a jcode build with `jcode session fork` (`tayoonabule/jcode`, until it lands upstream). |
| Permission posture | jcode has no approval prompts or permission modes, so its tools always run unattended. OpenRig reports that posture as it is. YOLO mode does not change the jcode command line. |
| Plugins | Claude/Codex plugin bundles are not applicable to jcode. Skill-only content is projected as skills. |

## Local jcode and Herdr forks

Core paths work with upstream jcode: lifecycle hooks, the temporary server environment, the
debug socket `sessions` command, `--resume`, and the standard skill directories. Per-seat
models, a clean relaunch, and seat forks currently need a personal fork such as
`tayoonabule/jcode`, for three reasons:

- `jcode session fork` (used for seat forks).
- Per-seat models: upstream jcode drops `-m` for sessions on a server it auto-spawns, so seats run
  jcode's default model instead of the one the spec pins.
- `jcode server stop --force` for per-seat servers: upstream cannot find a temporary server's
  process, so a relaunched seat can reconnect to its old server.

If a jcode fork reports its session identity to Herdr (the
`herdr pane report-agent-session` hook), that report is scoped to the Herdr pane and does not
interact with OpenRig's seat identity.

OpenRig's Herdr terminal provider (`rig terminal open <rig> --provider herdr`) opens every seat as a
Herdr tile. A tile's pane runs `tmux attach`, so Herdr's own process detection cannot see the agent
inside. openjig therefore reports each tile's agent and live state to Herdr (`pane.report_agent`)
from OpenRig's activity feed: `herdr agent list` shows OpenRig tiles as `jcode`, `claude` or
`codex` with `working`, `idle`/`done` or `blocked`, for any runtime. Verified with Herdr 0.9.1. Herdr only
attaches a reported session id for its own built-in reporters, so tiles show state without a
session id.

## Getting back to work: `openjig`

`scripts/openjig.py` gets you back to your rigs without remembering `rig` commands. Link it once
with `ln -s "$PWD/scripts/openjig.py" ~/.local/bin/openjig`, then in any terminal (cmux
included):

- `openjig` opens Herdr with every running rig as a workspace, each with a **mission
  control** pane (`rig tui`, OpenRig's operator view) beside its agents.
- `openjig <rig>` opens that rig, restarting it first if it is stopped.
- `openjig menu` is a clickable list (click, arrows and Enter, or type to filter):

  - **Your rigs**: jump into a running rig, restart a stopped one, or stop one.
  - **Start a new rig in a project**: pick **one jcode agent** (a one-seat rig named after
    the repo, via `rig create`, so every project can have its own) or a jcode starter, then
    a git repo from `~/Documents/GitHub` (`OPENJIG_PROJECT_ROOTS` changes that list).

Each choice prints the `rig` or `herdr` command it runs. Project work then happens in the
OpenRig TUI (the kernel's `operator.human` tile).

Projects: `rig config init-workspace --root <repo>` also adds the repo to the
`workspace.yaml` project list, and `rig scope` run inside a listed project uses that
project's `missions/` without `--workspace`.

## Installing from source

```bash
git clone https://github.com/tayoonabule/openjig.git
cd openjig
npm install
bash scripts/build-package.sh
(cd packages/cli && npm pack)
npm install -g packages/cli/openrig-cli-*.tgz
rig daemon start
```

The package name stays `@openrig/cli` and the command stays `rig`, so upstream documentation
applies unchanged. Installing openjig replaces any `@openrig/cli` installed from npm.

## Staying in sync

The repository ships the `/openjig-update` skill in `.jcode/skills/openjig-update`. It fetches
upstream, rebases the fork's commits onto upstream `main`, resolves conflicts, looks for new
upstream runtime lists that need jcode, runs every gate and separates fork regressions from
failures upstream also has, reviews the fork's code against upstream's standards, then rebuilds,
reinstalls, restarts the daemon and pushes.

Rules the fork follows so that stays cheap:

- New behaviour lives in new `jcode-*` files. Shared upstream files get a union member, a map
  entry, or a switch case, not a refactor.
- Upstream is never pushed to. openjig changes that would help upstream belong in an upstream
  pull request instead.
- Rebases keep a backup ref (`openjig-backup/<timestamp>`) and publish with
  `--force-with-lease`.
