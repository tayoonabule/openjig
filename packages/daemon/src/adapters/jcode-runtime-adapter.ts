import nodePath from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TmuxAdapter } from "./tmux.js";
import { shellQuote } from "./shell-quote.js";
import { JcodeSessionReader, jcodeRuntimeDir, scanJcodeSessions, type JcodeSessionFs } from "./jcode-session.js";
import { mergeManagedBlock } from "../domain/managed-blocks.js";
import { assessNativeResumeProbe } from "../domain/native-resume-probe.js";
import { observeJcodePosture } from "../domain/permission-drift.js";
import { resolveConcreteHint, type RuntimeAdapter, type NodeBinding, type ResolvedStartupFile,
  type InstalledResource, type ProjectionResult, type StartupDeliveryResult, type ReadinessResult,
  type HarnessLaunchResult, type ForkSource } from "../domain/runtime-adapter.js";
import type { ProjectionPlan, ProjectionEntry } from "../domain/projection-planner.js";

// A resume stops the seat's old server, starts a new one and loads the saved
// history: about 15s live, so allow 30s. Fresh launches only wait for an id.
const RESUME_POLL_ATTEMPTS = 120;
const POLL_DELAY_MS = 250;
const JCODE_SHELLS = new Set(["bash", "fish", "nu", "sh", "tmux", "zsh"]);
const FRESH_POLL_ATTEMPTS = 20;

export interface JcodeAdapterFsOps extends JcodeSessionFs {
  writeFile(path: string, content: string): void;
  mkdirp(path: string): void;
  statMode?(path: string): number;
  chmod?(path: string, mode: number): void;
}

export interface JcodeAdapterOptions {
  tmux: TmuxAdapter;
  fsOps: JcodeAdapterFsOps;
  stateRoot: string;
  home?: string;
  launchPath?: string;
  activityRelayPath?: string;
  execDebug?: (socket: string) => string | Promise<string>;
  /** Runs `jcode session fork <id> --json`; returns stdout. Injected in tests. */
  execFork?: (sourceId: string, launchPath?: string) => string | Promise<string>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Clones a saved jcode session and prints the new id (`jcode session fork`). */
async function defaultJcodeFork(sourceId: string, launchPath?: string): Promise<string> {
  const { stdout } = await promisify(execFile)("jcode", ["--quiet", "session", "fork", sourceId, "--json"], {
    encoding: "utf-8", timeout: 15000, env: launchPath ? { ...process.env, PATH: launchPath } : process.env,
  });
  return stdout;
}

/** Jcode reads AGENTS.md and .agents/skills without a config-file install. */
export class JcodeRuntimeAdapter implements RuntimeAdapter {
  readonly runtime = "jcode";
  private reader: JcodeSessionReader;
  private sleep: (ms: number) => Promise<void>;
  private now: () => number;
  private launchIds = new Map<string, string>();
  private launchContexts = new Map<string, { cwd: string; since: number; priorIds: Set<string> }>();

  constructor(private options: JcodeAdapterOptions) {
    this.reader = new JcodeSessionReader({ stateRoot: options.stateRoot, fsOps: options.fsOps,
      execDebug: options.execDebug, home: options.home ?? os.homedir() });
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
  }

  async listInstalled(binding: NodeBinding): Promise<InstalledResource[]> {
    const dir = nodePath.join(binding.cwd, ".agents", "skills");
    if (!this.options.fsOps.exists(dir)) return [];
    const names = [...new Set(this.options.fsOps.listFiles(dir).map((path) => path.split(nodePath.sep)[0]!))];
    return names.map((name) => ({
      effectiveId: name, category: "skill", installedPath: nodePath.join(dir, name),
    }));
  }

  async project(plan: ProjectionPlan, binding: NodeBinding): Promise<ProjectionResult> {
    const projected: string[] = [];
    const skipped: string[] = [];
    const failed: Array<{ effectiveId: string; error: string }> = [];
    for (const entry of plan.entries) {
      if (entry.classification === "no_op" || (entry.category !== "skill" && entry.category !== "guidance")) {
        skipped.push(entry.effectiveId);
        continue;
      }
      try {
        if (entry.category === "guidance") {
          if (entry.effectiveId === "rig-role") {
            skipped.push(entry.effectiveId);
            continue;
          }
          mergeManagedBlock(this.options.fsOps, nodePath.join(binding.cwd, "AGENTS.md"),
            entry.effectiveId, this.options.fsOps.readFile(entry.absolutePath), {
              replaceBlockIds: entry.effectiveId === "openrig-start.md" ? ["using-openrig.md"] : [],
            });
        } else {
          this.projectSkill(entry, binding.cwd);
        }
        projected.push(entry.effectiveId);
      } catch (error) {
        failed.push({ effectiveId: entry.effectiveId, error: (error as Error).message });
      }
    }
    return { projected, skipped, failed };
  }

  private projectSkill(entry: ProjectionEntry, cwd: string): void {
    const fs = this.options.fsOps;
    const dest = nodePath.join(cwd, ".agents", "skills", entry.effectiveId);
    // A projection source may be a SKILL.md file or a whole skill directory.
    let files: string[] = [];
    try { files = fs.listFiles(entry.absolutePath); } catch { /* a file source has no children */ }
    const sources = files.length ? files.map((name) => ({ source: nodePath.join(entry.absolutePath, name), name }))
      : [{ source: entry.absolutePath, name: nodePath.basename(entry.absolutePath) }];
    for (const { source, name } of sources) {
      const target = nodePath.join(dest, name);
      const content = fs.readFile(source);
      fs.mkdirp(nodePath.dirname(target));
      if (!fs.exists(target) || fs.readFile(target) !== content) fs.writeFile(target, content);
      if (fs.statMode && fs.chmod && (fs.statMode(target) & 0o777) !== (fs.statMode(source) & 0o777)) {
        fs.chmod(target, fs.statMode(source) & 0o777);
      }
    }
  }

  async deliverStartup(files: ResolvedStartupFile[], binding: NodeBinding): Promise<StartupDeliveryResult> {
    let delivered = 0;
    const failed: Array<{ path: string; error: string }> = [];
    for (const file of files) {
      try {
        const content = this.options.fsOps.readFile(file.absolutePath);
        const hint = file.deliveryHint === "auto" ? resolveConcreteHint(file.path, content) : file.deliveryHint;
        if (hint === "guidance_merge") {
          if (file.path === "rig-role") continue;
          mergeManagedBlock(this.options.fsOps, nodePath.join(binding.cwd, "AGENTS.md"), file.path, content,
            { replaceBlockIds: file.path === "openrig-start.md" ? ["using-openrig.md"] : [] });
        } else if (hint === "skill_install") {
          const dir = nodePath.join(binding.cwd, ".agents", "skills", nodePath.basename(nodePath.dirname(file.absolutePath)));
          this.options.fsOps.mkdirp(dir);
          this.options.fsOps.writeFile(nodePath.join(dir, nodePath.basename(file.path)), content);
        } else if (binding.tmuxSession) {
          const text = await this.options.tmux.sendText(binding.tmuxSession, content);
          if (!text.ok) throw new Error(text.message);
          await this.sleep(200);
          const enter = await this.options.tmux.sendKeys(binding.tmuxSession, ["C-m"]);
          if (!enter.ok) throw new Error(enter.message);
        }
        delivered++;
      } catch (error) {
        if (file.required) failed.push({ path: file.path, error: (error as Error).message });
      }
    }
    return { delivered, failed };
  }

  async launchHarness(binding: NodeBinding, opts: { name: string; resumeToken?: string; forkSource?: ForkSource }): Promise<HarnessLaunchResult> {
    if (!binding.tmuxSession) return { ok: false, error: "No tmux session bound; cannot launch Jcode harness" };
    if (opts.resumeToken && opts.forkSource) return { ok: false, error: "resumeToken and forkSource are mutually exclusive; pick one" };
    if (opts.forkSource) {
      // Fork writes a new saved session first, then the seat resumes that copy,
      // so the captured token is always the fork and never the parent.
      const fork = await this.forkSession(opts.forkSource);
      if (!fork.ok) return { ok: false, error: fork.error };
      return this.launchHarness(binding, { name: opts.name, resumeToken: fork.id });
    }
    this.launchIds.delete(opts.name);
    const since = this.now();
    const priorIds = new Set(scanJcodeSessions(this.options.fsOps, this.options.home ?? os.homedir(), { idsOnly: true }).map((row) => row.id));
    for (const row of await this.reader.debug(opts.name)) priorIds.add(row.id);
    this.launchContexts.set(opts.name, { cwd: binding.cwd, since, priorIds });
    const runtimeDir = jcodeRuntimeDir(this.options.stateRoot, opts.name);
    // Jcode exits with ENOENT when JCODE_RUNTIME_DIR does not exist yet.
    try { this.options.fsOps.mkdirp(runtimeDir); } catch (error) {
      return { ok: false, error: `Failed to create Jcode runtime dir ${runtimeDir}: ${(error as Error).message}` };
    }
    const model = binding.model?.trim();
    const relay = this.options.activityRelayPath;
    const hooks = relay && this.options.fsOps.exists(relay)
      ? ["TURN_START", "TURN_END", "SESSION_START", "SESSION_END"].map((event) =>
          ` JCODE_HOOK_${event}=${shellQuote(`node ${shellQuote(relay)}`)}`).join("") : "";
    // A retained seat server keeps the former occupant's hooks and environment.
    // Never stop the user's shared server: scope both stop and launch to this seat.
    // A JCODE_SOCKET inherited from the tmux server (set when it was started from a
    // jcode session) overrides the seat runtime dir, so every seat would join one shared
    // server and run its tools with that server's OPENRIG_* identity and model.
    const command = `unset JCODE_SOCKET; if [ -S ${shellQuote(nodePath.join(runtimeDir, "jcode.sock"))} ]; then JCODE_RUNTIME_DIR=${shellQuote(runtimeDir)} jcode server stop --force >/dev/null 2>&1; fi && JCODE_RUNTIME_DIR=${shellQuote(runtimeDir)} JCODE_TEMP_SERVER=1 JCODE_DEBUG_SOCKET=1${hooks} jcode --no-update --no-selfdev -C ${shellQuote(binding.cwd)}${model ? ` -m ${shellQuote(model)}` : ""}${opts.resumeToken ? ` --resume ${shellQuote(opts.resumeToken)}` : ""}`;
    const launch = await this.options.tmux.sendShellCommand(binding.tmuxSession,
      this.options.launchPath ? `PATH=${shellQuote(this.options.launchPath)}; ${command}` : command);
    if (!launch.ok) return { ok: false, error: `Failed to send launch command: ${launch.message}` };
    const appliedLaunch = observeJcodePosture();
    if (opts.resumeToken) {
      for (let i = 0; i < RESUME_POLL_ATTEMPTS; i++) {
        const last = i === RESUME_POLL_ATTEMPTS - 1;
        // A resumed session may continue its pending work at once, so the seat's
        // socket reporting this exact session (ready or busy) proves the resume.
        const live = await this.reader.debug(opts.name);
        const resumed = live.some((row) => row.id === opts.resumeToken
          && nodePath.resolve(row.workingDir) === nodePath.resolve(binding.cwd));
        const ready = resumed ? { ready: true } as ReadinessResult : await this.checkReady(binding);
        if (ready.ready) {
          if (live.length && !resumed) {
            if (!last) await this.sleep(POLL_DELAY_MS);
            continue;
          }
          this.launchIds.set(opts.name, opts.resumeToken);
          return { ok: true, resumeType: "jcode_id", resumeToken: opts.resumeToken, appliedLaunch };
        }
        if (ready.code === "no_saved_session") return { ok: false, recovery: "retry_fresh", error: "Jcode resume failed: no saved session found" };
        if (ready.code === "login_required") return { ok: false, recovery: "attention_required", error: ready.reason ?? "Jcode login required" };
        if (!last) await this.sleep(POLL_DELAY_MS);
      }
      return { ok: false, recovery: "attention_required", error: "Jcode resume did not reach an interactive prompt" };
    }
    for (let i = 0; i < FRESH_POLL_ATTEMPTS; i++) {
      const id = await this.reader.capture(opts.name, binding.cwd, since, priorIds);
      if (id) {
        this.launchIds.set(opts.name, id);
        return { ok: true, resumeType: "jcode_id", resumeToken: id, appliedLaunch };
      }
      if (i < FRESH_POLL_ATTEMPTS - 1) await this.sleep(POLL_DELAY_MS);
    }
    return { ok: true, appliedLaunch };
  }

  private async forkSession(source: ForkSource): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
    if (source.kind !== "native_id") {
      return { ok: false, error: `jcode fork: ref.kind="${source.kind}" is not supported; use ref.kind="native_id" with a jcode session id` };
    }
    const parentId = source.value?.trim();
    if (!parentId) return { ok: false, error: "jcode fork: forkSource.value is required (parent session id)" };
    const exec = this.options.execFork ?? defaultJcodeFork;
    let output: string;
    try {
      output = await exec(parentId, this.options.launchPath);
    } catch (error) {
      const detail = (error as { stderr?: string }).stderr?.trim() || (error as Error).message;
      return { ok: false, error: /unrecognized subcommand|invalid value|unexpected argument/i.test(detail)
        ? "jcode fork needs a jcode build with `jcode session fork` (tayoonabule/jcode or newer upstream)"
        : `jcode fork failed: ${detail}` };
    }
    try {
      const id = (JSON.parse(output) as { session_id?: unknown }).session_id;
      if (typeof id === "string" && id && id !== parentId) return { ok: true, id };
    } catch { /* fall through */ }
    return { ok: false, error: "jcode fork did not report a new session id" };
  }

  async captureSessionId(sessionName: string): Promise<string | undefined> {
    const context = this.launchContexts.get(sessionName);
    return this.launchIds.get(sessionName) ?? (context
      ? this.reader.capture(sessionName, context.cwd, context.since, context.priorIds)
      : this.reader.capture(sessionName));
  }

  async checkReady(binding: NodeBinding): Promise<ReadinessResult> {
    if (!binding.tmuxSession) return { ready: false, reason: "No tmux session bound" };
    if (!await this.options.tmux.hasSession(binding.tmuxSession)) return { ready: false, reason: "tmux session not responsive" };
    // The debug socket belongs to this seat and supersedes stale pane scrollback.
    const debug = await this.reader.debug(binding.tmuxSession);
    const current = debug.find((row) => nodePath.resolve(row.workingDir) === nodePath.resolve(binding.cwd));
    if (current?.status === "ready") return { ready: true };
    if (current?.status === "running") return { ready: false, reason: "Jcode is processing a turn", code: "runtime_busy" };
    if (debug.length) return { ready: false, reason: "The seat debug socket does not identify this workspace", code: "awaiting_runtime" };
    let command = await this.options.tmux.getPaneCommand(binding.tmuxSession);
    // Seats start jcode through a `/bin/sh <script>` wrapper, so the pane's foreground command is a
    // shell while jcode runs as its child. A live non-shell descendant is the runtime, not a bare shell.
    if (command && JCODE_SHELLS.has(command.replace(/^-/, ""))
      && await this.options.tmux.paneHasNonShellDescendant?.(binding.tmuxSession, (c) => JCODE_SHELLS.has(c)) === true) {
      command = "jcode";
    }
    const content = (await this.options.tmux.capturePaneScreen?.(binding.tmuxSession))
      ?? await this.options.tmux.capturePaneContent(binding.tmuxSession, 40);
    const probe = assessNativeResumeProbe({ runtime: "jcode", paneCommand: command, paneContent: content });
    if (probe.status === "attention_required" || probe.status === "failed") {
      return { ready: false, reason: probe.detail, code: probe.code };
    }
    return probe.status === "resumed" ? { ready: true }
      : { ready: false, reason: probe.detail, code: probe.code };
  }
}
