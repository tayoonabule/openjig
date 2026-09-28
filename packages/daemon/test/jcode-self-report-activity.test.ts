// OPR.99.0.1 — idle jcode seats read `running` forever from TUI repaint motion.
//
// The jcode TUI repaints its pane while idle, so tmux `#{window_activity}` advances every second
// (measured live 2026-09-28: an idle seat's window_activity tracked the wall clock at 1Hz). Motion
// therefore upgraded every idle jcode seat to running and idle-gated fleet work never proceeded.
// The fix: jcode's own seat debug socket (`sessions` → status/is_processing) is an authoritative,
// time-bounded self-report rung that outranks sampling, and vetoes motion when it says idle.

import net from "node:net";
import os from "node:os";
import fs from "node:fs";
import nodePath from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import type Database from "better-sqlite3";
import {
  jcodeActivityFromSessions,
  queryJcodeDebugSocket,
  readJcodeSelfReportEvidence,
  JCODE_SELF_REPORT_VALID_MS,
} from "../src/adapters/jcode-session.js";
import { SeatActivityService } from "../src/domain/seat-activity-service.js";
import { attachAgentActivity } from "../src/domain/node-inventory.js";
import type { AgentActivity } from "../src/domain/types.js";

const IDLE = JSON.stringify([{ session_id: "s1", status: "ready", is_processing: false, working_dir: "/w" }]);
const BUSY = JSON.stringify([{ session_id: "s1", status: "running", is_processing: true, working_dir: "/w" }]);

describe("OPR.99.0.1 jcodeActivityFromSessions", () => {
  it("ready + not processing ⇒ idle-at-prompt; processing or running ⇒ working", () => {
    expect(jcodeActivityFromSessions(IDLE)).toBe("idle-at-prompt");
    expect(jcodeActivityFromSessions(BUSY)).toBe("working");
    expect(jcodeActivityFromSessions(JSON.stringify([{ status: "ready", is_processing: true }]))).toBe("working");
  });

  it("any processing session makes the seat working", () => {
    const rows = [{ status: "ready", is_processing: false }, { status: "running", is_processing: true }];
    expect(jcodeActivityFromSessions(JSON.stringify(rows))).toBe("working");
  });

  it("unknown vocabulary, empty or malformed output ⇒ null (never guess)", () => {
    expect(jcodeActivityFromSessions("[]")).toBeNull();
    expect(jcodeActivityFromSessions("not json")).toBeNull();
    expect(jcodeActivityFromSessions(JSON.stringify([{ status: "levitating", is_processing: false }]))).toBeNull();
    expect(jcodeActivityFromSessions(JSON.stringify({ status: "ready" }))).toBeNull();
  });
});

describe("OPR.99.0.1 queryJcodeDebugSocket (real unix socket)", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

  function serve(reply: (line: string) => string | null): string {
    const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "jc-sock-"));
    const path = nodePath.join(dir, "jcode-debug.sock");
    const server = net.createServer((conn) => {
      let buf = "";
      conn.on("data", (d) => {
        buf += d.toString();
        const nl = buf.indexOf("\n");
        if (nl < 0) return;
        const out = reply(buf.slice(0, nl));
        if (out !== null) conn.write(out + "\n");
      });
    });
    server.listen(path);
    cleanups.push(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    return path;
  }

  it("sends the sessions debug_command and returns the output", async () => {
    let seen: unknown = null;
    const path = serve((line) => {
      seen = JSON.parse(line);
      return JSON.stringify({ type: "debug_response", id: 1, ok: true, output: IDLE });
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(await queryJcodeDebugSocket(path)).toBe(IDLE);
    expect(seen).toMatchObject({ type: "debug_command", command: "sessions" });
  });

  it("a silent server times out to null; a missing socket is null; an error reply is null", async () => {
    const silent = serve(() => null);
    const failing = serve(() => JSON.stringify({ type: "debug_response", ok: false, output: "boom" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(await queryJcodeDebugSocket(silent, 100)).toBeNull();
    expect(await queryJcodeDebugSocket(failing)).toBeNull();
    expect(await queryJcodeDebugSocket("/nonexistent/jcode-debug.sock")).toBeNull();
  });
});

describe("OPR.99.0.1 readJcodeSelfReportEvidence", () => {
  const base = { stateRoot: "/state", sessionName: "qa@rig", seatNodeId: "n1", now: () => new Date(1_000_000), exists: () => true };

  it("reads the seat-scoped debug socket and emits time-bounded self-report evidence", async () => {
    let asked = "";
    const evd = await readJcodeSelfReportEvidence({ ...base, query: async (p) => { asked = p; return IDLE; } });
    expect(asked).toBe("/state/qa@rig/runtime/jcode-debug.sock");
    expect(evd).toMatchObject({ rung: "self-report", sourceId: "jcode:debug-socket", activity: "idle-at-prompt", validForMs: JCODE_SELF_REPORT_VALID_MS });
  });

  it("absent socket or unreadable reply ⇒ null (the rung stales, never errors)", async () => {
    expect(await readJcodeSelfReportEvidence({ ...base, exists: () => false, query: async () => IDLE })).toBeNull();
    expect(await readJcodeSelfReportEvidence({ ...base, query: async () => null })).toBeNull();
  });
});

describe("OPR.99.0.1 oracle: jcode self-report outranks repaint motion", () => {
  const SEAT = "node-jc-1";
  const NAME = "cleanup-qa@audit-tool";

  function harness(runtime: string, report: () => "working" | "idle-at-prompt" | null) {
    const clock = { now: 5_000_000 };
    const svc = new SeatActivityService({
      // The pane is ALWAYS in motion (TUI repaint): window_activity == now.
      tmux: { readPaneLastActivity: async () => clock.now / 1000 },
      defaultWindowSeconds: 3,
      now: () => new Date(clock.now),
      selfReportReader: async (sessionName, seatNodeId, rt) => {
        if (rt !== "jcode") return null;
        const activity = report();
        return activity
          ? { seatNodeId, sessionName, rung: "self-report", sourceId: "jcode:debug-socket", seq: clock.now, observedAt: new Date(clock.now).toISOString(), activity, validForMs: JCODE_SELF_REPORT_VALID_MS }
          : null;
      },
    });
    const db = { prepare: () => ({ all: () => [{ session_name: NAME, node_id: SEAT, runtime }] }) } as unknown as Database.Database;
    return { svc, db, clock };
  }

  it("[acceptance 1] an idle jcode seat with a repainting pane reads idle, decided by self-report", async () => {
    const { svc, db } = harness("jcode", () => "idle-at-prompt");
    await svc.pollAllRunningTmuxSeats(db);
    const s = svc.getSeatState(SEAT)!;
    expect(s.activity).toBe("idle-at-prompt");
    expect(s.decidedBy).toBe("self-report");
  });

  it("[acceptance 1] stays idle across repeated repaint sweeps", async () => {
    const { svc, db, clock } = harness("jcode", () => "idle-at-prompt");
    for (let i = 0; i < 5; i++) { clock.now += 1000; await svc.pollAllRunningTmuxSeats(db); }
    expect(svc.getSeatState(SEAT)!.activity).toBe("idle-at-prompt");
  });

  it("[acceptance 2] a jcode seat mid-turn reads working", async () => {
    const { svc, db } = harness("jcode", () => "working");
    await svc.pollAllRunningTmuxSeats(db);
    expect(svc.getSeatState(SEAT)!).toMatchObject({ activity: "working", decidedBy: "self-report" });
  });

  it("the idle→working→idle turn boundary follows the self-report instantly", async () => {
    let now: "working" | "idle-at-prompt" = "idle-at-prompt";
    const { svc, db, clock } = harness("jcode", () => now);
    await svc.pollAllRunningTmuxSeats(db);
    now = "working"; clock.now += 1000; await svc.pollAllRunningTmuxSeats(db);
    expect(svc.getSeatState(SEAT)!.activity).toBe("working");
    now = "idle-at-prompt"; clock.now += 1000; await svc.pollAllRunningTmuxSeats(db);
    expect(svc.getSeatState(SEAT)!.activity).toBe("idle-at-prompt");
  });

  it("a dead socket's last idle answer expires: the seat falls back to sampling (never frozen idle)", async () => {
    let alive = true;
    const { svc, db, clock } = harness("jcode", () => (alive ? "idle-at-prompt" : null));
    await svc.pollAllRunningTmuxSeats(db);
    alive = false;
    clock.now += JCODE_SELF_REPORT_VALID_MS + 1000;
    await svc.pollAllRunningTmuxSeats(db);
    expect(svc.getSeatState(SEAT)!).toMatchObject({ activity: "working", decidedBy: "window-sampling" });
  });

  it("a throwing reader falls down the ladder without breaking the sweep", async () => {
    const { svc, db } = harness("jcode", () => { throw new Error("socket exploded"); });
    await svc.pollAllRunningTmuxSeats(db);
    expect(svc.getSeatState(SEAT)!.decidedBy).toBe("window-sampling");
  });

  it("[acceptance 4] codex seats are untouched: no self-report rung, sampling decides", async () => {
    const { svc, db } = harness("codex", () => "idle-at-prompt");
    await svc.pollAllRunningTmuxSeats(db);
    const s = svc.getSeatState(SEAT)!;
    expect(s).toMatchObject({ activity: "working", decidedBy: "window-sampling" });
    expect(s.rungs.some((r) => r.rung === "self-report")).toBe(false);
  });
});

describe("OPR.99.0.1 node-inventory ACTIVITY: jcode self-report vetoes repaint motion", () => {
  const NOW = new Date("2026-09-28T20:00:00.000Z");
  const motion = {
    paneId: "s@rig", isActiveWithinWindow: true, silenceWindowSeconds: 3,
    lastObservedAt: NOW.toISOString(), lastActivityAt: new Date(NOW.getTime() - 500).toISOString(),
  };
  const tmux = { hasSession: async () => true, getPaneCommand: async () => "jcode", capturePaneContent: async () => "" } as never;
  const hook = (state: AgentActivity["state"], reason: string): AgentActivity => ({
    state, reason, evidenceSource: "runtime_hook", sampledAt: "2026-09-28T12:25:02.004Z", evidence: null,
  });

  async function activityOf(opts: {
    runtime: string;
    arb: { activity: string; decidedBy: string | null } | null;
    hook?: AgentActivity | null;
  }): Promise<AgentActivity> {
    const out = await attachAgentActivity(
      [{ canonicalSessionName: "s@rig", runtime: opts.runtime, attachmentType: "tmux", logicalId: "pod.qa" }] as never,
      {
        now: NOW,
        tmuxAdapter: tmux,
        activityStore: { getLatestForNode: () => opts.hook ?? null } as never,
        seatActivity: { getSeatActivity: () => motion, getSeatStateBySession: () => opts.arb },
      },
    );
    return (out[0] as unknown as { agentActivity: AgentActivity }).agentActivity;
  }

  it("[acceptance 1] idle jcode + live repaint motion + stale idle hook ⇒ idle (the observed fleet state)", async () => {
    const a = await activityOf({ runtime: "jcode", arb: { activity: "idle-at-prompt", decidedBy: "self-report" }, hook: hook("idle", "stop") });
    expect(a.state).toBe("idle");
    expect(a.evidenceSource).toBe("runtime_self_report");
  });

  it("[acceptance 2] working jcode ⇒ running from its self-report", async () => {
    const a = await activityOf({ runtime: "jcode", arb: { activity: "working", decidedBy: "self-report" } });
    expect(a).toMatchObject({ state: "running", reason: "jcode_self_report" });
  });

  it("jcode with NO self-report (socket unreadable) keeps the old motion behavior ⇒ running", async () => {
    const a = await activityOf({ runtime: "jcode", arb: { activity: "working", decidedBy: "window-sampling" } });
    expect(a).toMatchObject({ state: "running", reason: "window_activity_motion" });
  });

  it("[acceptance 3] Claude D2 preserved: idle hook + live motion ⇒ running, even if an oracle says idle", async () => {
    const a = await activityOf({ runtime: "claude-code", arb: { activity: "idle-at-prompt", decidedBy: "self-report" }, hook: hook("idle", "stop_hook") });
    expect(a).toMatchObject({ state: "running", reason: "window_activity_motion" });
  });

  it("[acceptance 4] Codex D1 preserved: hook-less codex with motion ⇒ running", async () => {
    const a = await activityOf({ runtime: "codex", arb: { activity: "working", decidedBy: "window-sampling" } });
    expect(a).toMatchObject({ state: "running", reason: "window_activity_motion" });
  });

  it("[acceptance 5] needs_input still outranks a jcode idle self-report", async () => {
    const a = await activityOf({ runtime: "jcode", arb: { activity: "idle-at-prompt", decidedBy: "self-report" }, hook: hook("needs_input", "permission_request") });
    expect(a.state).toBe("needs_input");
  });
});
