// One shared jcode server hosting many seats: a seat's marker file points it at the shared runtime
// dir, and every read of that server is scoped to the seat by the `openrig_seat` field jcode reports.
import { describe, it, expect, vi } from "vitest";
import {
  JcodeSessionReader,
  jcodeActivityFromSessions,
  readJcodeSelfReportEvidence,
  resolveJcodeServerDir,
} from "../src/adapters/jcode-session.js";
import { JcodeRuntimeAdapter } from "../src/adapters/jcode-runtime-adapter.js";
import { mockShellCommand } from "./helpers/shell-command-mock.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

const STATE = "/state/jcode";
const SHARED = "/state/jcode/_shared/runtime";
const ROWS = JSON.stringify([
  { session_id: "s_a", openrig_seat: "seat-a@x", working_dir: "/wa", status: "ready", is_processing: false },
  { session_id: "s_b", openrig_seat: "seat-b@x", working_dir: "/wb", status: "running", is_processing: true },
]);

describe("shared jcode server routing", () => {
  it("per-seat dir by default; shared dir only when the seat has a marker", () => {
    const store: Record<string, string> = { [`${STATE}/seat-b@x/shared-server`]: `${SHARED}\n` };
    const fsx = { exists: (p: string) => p in store, readFile: (p: string) => store[p]! };
    expect(resolveJcodeServerDir(STATE, "seat-a@x", fsx)).toEqual({ dir: `${STATE}/seat-a@x/runtime`, shared: false });
    expect(resolveJcodeServerDir(STATE, "seat-b@x", fsx)).toEqual({ dir: SHARED, shared: true });
  });

  it("reader on a shared server returns only this seat's sessions", async () => {
    const store: Record<string, string> = {
      [`${STATE}/seat-a@x/shared-server`]: SHARED, [`${SHARED}/jcode.sock`]: "",
    };
    const reader = new JcodeSessionReader({
      stateRoot: STATE,
      fsOps: { exists: (p) => p in store, readFile: (p) => store[p]!, listFiles: () => [] },
      execDebug: () => ROWS,
    });
    expect((await reader.debug("seat-a@x")).map((r) => r.id)).toEqual(["s_a"]);
  });

  it("a per-seat server is not filtered (rows carry no seat)", async () => {
    const store: Record<string, string> = { [`${STATE}/solo/runtime/jcode.sock`]: "" };
    const reader = new JcodeSessionReader({
      stateRoot: STATE,
      fsOps: { exists: (p) => p in store, readFile: () => "", listFiles: () => [] },
      execDebug: () => JSON.stringify([{ session_id: "s1", working_dir: "/w", status: "ready" }]),
    });
    expect((await reader.debug("solo")).map((r) => r.id)).toEqual(["s1"]);
  });

  it("activity self-report on a shared server only counts this seat's sessions", async () => {
    const store: Record<string, string> = {
      [`${STATE}/seat-a@x/shared-server`]: SHARED, [`${SHARED}/jcode-debug.sock`]: "",
    };
    const ev = await readJcodeSelfReportEvidence({
      stateRoot: STATE, sessionName: "seat-a@x", seatNodeId: "n",
      exists: (p) => p in store, readMarker: (p) => store[p]!, query: async () => ROWS,
    });
    // seat-b is working but must not make seat-a working
    expect(ev?.activity).toBe("idle-at-prompt");
    expect(jcodeActivityFromSessions(ROWS)).toBe("working");
  });

  it("launch on a shared server joins it and never stops it, keeping the seat model", async () => {
    const store: Record<string, string> = {
      [`${STATE}/seat-a@x/shared-server`]: SHARED, [`${SHARED}/jcode.sock`]: "",
    };
    const tmux = mockShellCommand({
      sendText: vi.fn(async () => ({ ok: true as const })), sendKeys: vi.fn(async () => ({ ok: true as const })),
      hasSession: vi.fn(async () => true), getPaneCommand: vi.fn(async () => "jcode"),
      capturePaneContent: vi.fn(async () => "Jcode\n1> "),
    } as unknown as TmuxAdapter);
    const adapter = new JcodeRuntimeAdapter({
      tmux, stateRoot: STATE, home: "/home/t", sleep: async () => {}, now: () => 1,
      fsOps: { exists: (p) => p in store, readFile: (p) => store[p]!, writeFile: () => {}, mkdirp: () => {}, listFiles: () => [] },
      execDebug: () => JSON.stringify([{ session_id: "session_x_1_aa", openrig_seat: "seat-a@x", working_dir: "/p", status: "ready" }]),
    });
    await adapter.launchHarness({ id: "b", nodeId: "n", tmuxSession: "seat-a@x", tmuxWindow: null, tmuxPane: null,
      cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: "/p", model: "claude-haiku" },
      { name: "seat-a@x", resumeToken: "session_x_1_aa" });
    const cmd = vi.mocked(tmux.sendText).mock.calls[0]![1];
    expect(cmd).toContain(`JCODE_RUNTIME_DIR='${SHARED}'`);
    expect(cmd).toContain("-m 'claude-haiku'");
    expect(cmd).toContain("--resume 'session_x_1_aa'");
    expect(cmd).not.toContain("server stop");
    expect(cmd).not.toContain("JCODE_TEMP_SERVER");
  });
});
