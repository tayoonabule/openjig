import nodePath from "node:path";
import os from "node:os";
import { describe, expect, it, vi } from "vitest";
import { JcodeRuntimeAdapter, type JcodeAdapterFsOps } from "../src/adapters/jcode-runtime-adapter.js";
import { scanJcodeSessions } from "../src/adapters/jcode-session.js";
import { mockShellCommand } from "./helpers/shell-command-mock.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import type { ProjectionPlan } from "../src/domain/projection-planner.js";
import { diagnoseRuntimePosture, observeJcodePosture } from "../src/domain/permission-drift.js";

const ID = "session_evergreen_1790178908510_a18975cec608bc81";
const HOME = "/home/test";
const STATE = "/state/jcode";
function binding(cwd = "/project"): NodeBinding {
  return { id: "b", nodeId: "n", tmuxSession: "seat", tmuxWindow: null, tmuxPane: null,
    cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd, model: "gpt-5.5" };
}
function fixture(files: Record<string, string> = {}, options: { pane?: string; execDebug?: () => string; execFork?: (source: string) => string; store?: Record<string, string>; tmux?: TmuxAdapter } = {}) {
  const store = options.store ?? { ...files };
  const fsOps: JcodeAdapterFsOps = {
    exists: (p) => p in store,
    readFile: (p) => { if (!(p in store)) throw new Error("not found"); return store[p]!; },
    writeFile: (p, value) => { store[p] = value; },
    mkdirp: () => {},
    listFiles: (dir) => Object.keys(store).filter((p) => nodePath.dirname(p) === dir).map((p) => nodePath.basename(p)),
  };
  const tmux = options.tmux ?? mockShellCommand({
    sendText: vi.fn(async () => ({ ok: true as const })),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
    hasSession: vi.fn(async () => true),
    getPaneCommand: vi.fn(async () => "jcode"),
    capturePaneContent: vi.fn(async () => options.pane ?? "Jcode\n1> "),
  } as unknown as TmuxAdapter);
  const adapter = new JcodeRuntimeAdapter({ tmux, fsOps, stateRoot: STATE, home: HOME,
    execDebug: options.execDebug, execFork: options.execFork, sleep: async () => {}, now: () => 1790178908000 });
  return { adapter, tmux, store, fsOps };
}

describe("JcodeRuntimeAdapter", () => {
  it("reports unconfigurable unrestricted posture without a sandbox claim", () => {
    expect(observeJcodePosture()).toMatchObject({ runtime: "jcode", axis: "not_applicable", value: "unrestricted" });
    const diagnostic = diagnoseRuntimePosture({ runtime: "jcode", cwd: "/project", applied: observeJcodePosture(),
      fs: { readFile: () => "", cwdReadable: () => true, commandAvailable: () => true, claudePermissionModes: () => null } });
    expect(diagnostic.commandPath.state).toBe("available");
    expect(diagnostic.enforcement).toMatchObject({ axis: "not_applicable", effective: "unrestricted", reason: "permission_flags_unavailable" });
  });
  it("creates the seat runtime dir before launch because jcode will not", async () => {
    const { adapter, fsOps, tmux } = fixture();
    const made: string[] = [];
    fsOps.mkdirp = (p) => { made.push(p); };
    await adapter.launchHarness(binding(), { name: "seat" });
    expect(made).toContain(`${STATE}/seat/runtime`);
    expect(tmux.sendText).toHaveBeenCalled();
  });

  it("refuses to launch when the seat runtime dir cannot be created", async () => {
    const { adapter, fsOps, tmux } = fixture();
    fsOps.mkdirp = () => { throw new Error("EACCES"); };
    const result = await adapter.launchHarness(binding(), { name: "seat" });
    expect(result).toMatchObject({ ok: false });
    expect(result.error).toContain("EACCES");
    expect(tmux.sendText).not.toHaveBeenCalled();
  });

  it("launches with isolated per-seat server, cwd, model and shell quoting", async () => {
    const socket = `${STATE}/seat/runtime/jcode.sock`;
    let probes = 0;
    const { adapter, tmux } = fixture({ [socket]: "" }, {
      execDebug: () => JSON.stringify(++probes === 1 ? [] : [{ session_id: ID, working_dir: "/repo with space", status: "ready" }]),
    });
    const result = await adapter.launchHarness(binding("/repo with space"), { name: "seat" });
    expect(result).toMatchObject({ ok: true, resumeType: "jcode_id", resumeToken: ID });
    expect(vi.mocked(tmux.sendText).mock.calls[0]![1]).toContain(
      `JCODE_RUNTIME_DIR='${STATE}/seat/runtime' JCODE_TEMP_SERVER=1 JCODE_DEBUG_SOCKET=1 jcode --no-update --no-selfdev -C '/repo with space' -m 'gpt-5.5'`,
    );
    expect(vi.mocked(tmux.sendText).mock.calls[0]![1]).toContain(
      `JCODE_RUNTIME_DIR='${STATE}/seat/runtime' jcode server stop --force`,
    );
    expect(tmux.sendKeys).toHaveBeenCalledWith("seat", ["Enter"]);
  });

  it("sets seat-scoped lifecycle hook env without changing user config", async () => {
    const relay = "/daemon assets/activity-relay.cjs";
    const { tmux } = fixture();
    const hooked = new JcodeRuntimeAdapter({ tmux, fsOps: {
      exists: (p) => p === relay,
      readFile: () => "", writeFile: () => {}, mkdirp: () => {}, listFiles: () => [],
    }, stateRoot: STATE, home: HOME, activityRelayPath: relay, now: () => 1790178908000, sleep: async () => {} });
    await hooked.launchHarness(binding(), { name: "seat" });
    const command = vi.mocked(tmux.sendText).mock.calls[0]![1];
    for (const event of ["TURN_START", "TURN_END", "SESSION_START", "SESSION_END"]) {
      expect(command).toContain(`JCODE_HOOK_${event}=`);
    }
    expect(command).toContain("activity-relay.cjs");
  });

  it("falls back to newly created session metadata, not an old matching cwd", async () => {
    const dir = `${HOME}/.jcode/sessions`;
    const { adapter, tmux, store, fsOps } = fixture({
      [`${dir}/old.json`]: JSON.stringify({ id: "session_old_1790178907000_aaaaaaaa", working_dir: "/project", created_at: 1790178907000 }),
    });
    vi.mocked(tmux.sendText).mockImplementationOnce(async () => {
      store[`${dir}/new.json`] = JSON.stringify({ id: ID, working_dir: "/project", created_at: 1790178908510 });
      return { ok: true };
    });
    const result = await adapter.launchHarness(binding(), { name: "seat" });
    expect(store[`${dir}/new.json`]).toBeDefined();
    expect(scanJcodeSessions(fsOps, HOME)).toContainEqual(expect.objectContaining({ id: ID }));
    expect(result).toMatchObject({ ok: true, resumeToken: ID });
  });

  it("does not guess an identity for two seats launched in the same cwd without debug", async () => {
    const dir = `${HOME}/.jcode/sessions`;
    const first = "session_first_1790178908510_aaaaaaaaaaaaaaaa";
    const second = "session_second_1790178908511_bbbbbbbbbbbbbbbb";
    const { adapter, tmux, store } = fixture();
    vi.mocked(tmux.sendText).mockImplementation(async () => {
      store[`${dir}/first.json`] = JSON.stringify({ id: first, working_dir: "/project", created_at: 1790178908510 });
      store[`${dir}/second.json`] = JSON.stringify({ id: second, working_dir: "/project", created_at: 1790178908511 });
      return { ok: true };
    });
    const { adapter: other } = fixture({}, { store, tmux });
    const [one, two] = await Promise.all([
      adapter.launchHarness(binding(), { name: "seat" }),
      other.launchHarness(binding(), { name: "other-seat" }),
    ]);
    expect(one.resumeToken).toBeUndefined();
    expect(two.resumeToken).toBeUndefined();
    expect(await adapter.captureSessionId("seat")).toBeUndefined();
    expect(await other.captureSessionId("other-seat")).toBeUndefined();
  });

  it.each([undefined, ID])("retires only the seat server before %s launch", async (resumeToken) => {
    const socket = `${STATE}/seat/runtime/jcode.sock`;
    const { adapter, tmux } = fixture({ [socket]: "" }, {
      execDebug: () => JSON.stringify([{ session_id: ID, working_dir: "/project", status: "ready" }]),
    });
    await adapter.launchHarness(binding(), { name: "seat", ...(resumeToken ? { resumeToken } : {}) });
    const command = vi.mocked(tmux.sendText).mock.calls[0]![1];
    expect(command).toContain(`if [ -S '${socket}' ]; then JCODE_RUNTIME_DIR='${STATE}/seat/runtime' jcode server stop --force`);
    expect(command).not.toMatch(/(^|;)\s*jcode server stop/);
    // An inherited JCODE_SOCKET would put every seat on one shared server and identity.
    expect(command.startsWith("unset JCODE_SOCKET; ")).toBe(true);
    expect(command.indexOf("server stop --force")).toBeLessThan(command.indexOf("jcode --no-update"));
    // A failed stop must skip the launch without exiting the seat's interactive shell.
    expect(command).toContain("2>&1; fi && JCODE_RUNTIME_DIR=");
    expect(command).not.toMatch(/\bexit\b/);
  });

  it("resumes the exact session id and rejects a stale debug identity", async () => {
    const socket = `${STATE}/seat/runtime/jcode.sock`;
    const stale = "session_previous_1790178907000_aaaaaaaa";
    const { adapter, tmux } = fixture({ [socket]: "" }, {
      execDebug: () => JSON.stringify([{ session_id: stale, working_dir: "/project", status: "ready" }]),
    });
    const result = await adapter.launchHarness(binding(), { name: "seat", resumeToken: ID });
    expect(result).toMatchObject({ ok: false, recovery: "attention_required" });
    expect(vi.mocked(tmux.sendText).mock.calls[0]![1]).toContain(`--resume '${ID}'`);
  });

  it("treats a resumed session that is already busy as resumed", async () => {
    // Live repro: jcode resumed the saved session and immediately continued a
    // pending todo, so the socket said `running` and the resume was misreported.
    const socket = `${STATE}/seat/runtime/jcode.sock`;
    const { adapter } = fixture({ [socket]: "" }, {
      execDebug: () => JSON.stringify([{ session_id: ID, working_dir: "/project", status: "running" }]),
    });
    const result = await adapter.launchHarness(binding(), { name: "seat", resumeToken: ID });
    expect(result).toMatchObject({ ok: true, resumeType: "jcode_id", resumeToken: ID });
  });

  it("refuses mixed resume/fork and unsupported fork refs without touching tmux", async () => {
    const { adapter, tmux } = fixture();
    expect(await adapter.launchHarness(binding(), { name: "seat", resumeToken: ID, forkSource: { kind: "native_id", value: ID } })).toMatchObject({ ok: false });
    expect(await adapter.launchHarness(binding(), { name: "seat", forkSource: { kind: "last" } })).toMatchObject({ ok: false });
    expect(await adapter.launchHarness(binding(), { name: "seat", forkSource: { kind: "native_id", value: " " } })).toMatchObject({ ok: false });
    expect(tmux.sendText).not.toHaveBeenCalled();
  });

  it("forks via `jcode session fork` and resumes the new session, never the parent", async () => {
    const FORK = "session_fork_1790178909000_bbbbbbbbbbbbbbbb";
    const socket = `${STATE}/seat/runtime/jcode.sock`;
    const forked: string[] = [];
    const { adapter, tmux } = fixture({ [socket]: "" }, {
      execDebug: () => JSON.stringify([{ session_id: FORK, working_dir: "/project", status: "ready" }]),
      execFork: (source) => { forked.push(source); return JSON.stringify({ session_id: FORK, parent_session_id: source }); },
    });
    const result = await adapter.launchHarness(binding(), { name: "seat", forkSource: { kind: "native_id", value: ID } });
    expect(forked).toEqual([ID]);
    expect(result).toMatchObject({ ok: true, resumeType: "jcode_id", resumeToken: FORK });
    const command = vi.mocked(tmux.sendText).mock.calls[0]![1];
    expect(command).toContain(`--resume '${FORK}'`);
    expect(command).not.toContain(ID);
  });

  it("explains when the installed jcode has no session fork command", async () => {
    const { adapter, tmux } = fixture({}, {
      execFork: () => { throw Object.assign(new Error("exit 2"), { stderr: "error: unrecognized subcommand 'fork'" }); },
    });
    const result = await adapter.launchHarness(binding(), { name: "seat", forkSource: { kind: "native_id", value: ID } });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("jcode session fork");
    expect(tmux.sendText).not.toHaveBeenCalled();
  });

  it("treats login as attention and busy debug status as not ready", async () => {
    const login = fixture({}, { pane: "Log in to continue" });
    expect(await login.adapter.checkReady(binding())).toMatchObject({ ready: false, code: "login_required" });
    const socket = `${STATE}/seat/runtime/jcode.sock`;
    const busy = fixture({ [socket]: "" }, { execDebug: () => JSON.stringify([{ session_id: ID, working_dir: "/project", status: "running" }]) });
    expect(await busy.adapter.checkReady(binding())).toMatchObject({ ready: false, code: "runtime_busy" });
  });

  it("trusts seat debug ready over stale login and pane scrollback", async () => {
    const socket = `${STATE}/seat/runtime/jcode.sock`;
    const { adapter, tmux } = fixture({ [socket]: "" }, { pane: "Log in to continue\n1> old\nwaiting for response…",
      execDebug: () => JSON.stringify([{ session_id: ID, working_dir: "/project", status: "ready" }]) });
    vi.mocked(tmux.getPaneCommand).mockResolvedValue("zsh");
    expect(await adapter.checkReady(binding())).toMatchObject({ ready: true });
  });

  it("treats a shell-wrapped jcode as live, but a bare shell as returned", async () => {
    const wrapped = fixture({}, { pane: "Jcode\n1> " });
    vi.mocked(wrapped.tmux.getPaneCommand).mockResolvedValue("bash");
    (wrapped.tmux as any).paneHasNonShellDescendant = vi.fn(async () => true);
    expect(await wrapped.adapter.checkReady(binding())).toMatchObject({ ready: true });
    const bare = fixture({}, { pane: "light@host % " });
    vi.mocked(bare.tmux.getPaneCommand).mockResolvedValue("bash");
    (bare.tmux as any).paneHasNonShellDescendant = vi.fn(async () => false);
    expect(await bare.adapter.checkReady(binding())).toMatchObject({ ready: false, code: "returned_to_shell" });
  });

  it("never opens session transcripts when asked for a seat with no launch window", async () => {
    const dir = `${nodePath.join(os.homedir(), ".jcode", "sessions")}`;
    const reads: string[] = [];
    const big = `${dir}/session_big_1790000000000_abc.json`;
    const { adapter } = fixture({ [big]: "{}" });
    const fsOps = (adapter as any).reader.fs;
    const original = fsOps.readFile;
    fsOps.readFile = (p: string) => { reads.push(p); return original(p); };
    expect(await adapter.captureSessionId("never-launched-seat")).toBeUndefined();
    expect(reads).toEqual([]);
  });

  it("does not trust a different cwd on the seat debug socket", async () => {
    const socket = `${STATE}/seat/runtime/jcode.sock`;
    const { adapter } = fixture({ [socket]: "" }, { pane: "Jcode\n1> ",
      execDebug: () => JSON.stringify([{ session_id: ID, working_dir: "/other", status: "ready" }]) });
    expect(await adapter.checkReady(binding())).toMatchObject({ ready: false, code: "awaiting_runtime" });
    await adapter.launchHarness(binding(), { name: "seat" });
    expect(await adapter.captureSessionId("seat")).toBeUndefined();
  });

  it("projects guidance and skill files into AGENTS.md and .agents/skills", async () => {
    const { adapter, store } = fixture({ "/source/guide.md": "Follow team guidance", "/source/SKILL.md": "# Skill" });
    const entry = (category: "guidance" | "skill", effectiveId: string, absolutePath: string) =>
      ({ category, effectiveId, absolutePath, classification: "safe_projection", mergeStrategy: "managed_block" as const });
    const plan = { entries: [entry("guidance", "team", "/source/guide.md"), entry("skill", "test", "/source/SKILL.md")] } as ProjectionPlan;
    expect(await adapter.project(plan, binding())).toMatchObject({ projected: ["team", "test"], failed: [] });
    expect(store["/project/AGENTS.md"]).toContain("Follow team guidance");
    expect(store["/project/.agents/skills/test/SKILL.md"]).toBe("# Skill");
  });

  it("sends startup text as one paste followed by a separate submit key", async () => {
    const { adapter, tmux } = fixture({ "/source/start.txt": "first line\nsecond line" });
    expect(await adapter.deliverStartup([{
      path: "start.txt", absolutePath: "/source/start.txt", deliveryHint: "send_text", required: true,
    }], binding())).toEqual({ delivered: 1, failed: [] });
    expect(tmux.sendText).toHaveBeenCalledWith("seat", "first line\nsecond line");
    expect(tmux.sendKeys).toHaveBeenCalledWith("seat", ["C-m"]);
    expect(vi.mocked(tmux.sendText).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(tmux.sendKeys).mock.invocationCallOrder[0]!);
  });
});
