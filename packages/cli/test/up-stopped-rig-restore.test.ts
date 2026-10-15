// `rig up <name>` on an already-managed STOPPED rig: the rig owns its name
// (no rig-vs-library ambiguity), restores from the latest good snapshot via
// the rig-name route, never silently starts fresh when restore cannot run, and
// names detached seats with recovery commands after a partial restore.
// Throwaway mock daemon only; no real rig is touched.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import { Command } from "commander";
import { upCommand } from "../src/commands/up.js";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE, type LifecycleDeps, type DaemonState } from "../src/daemon-lifecycle.js";

function lifecycle(port: number): LifecycleDeps {
  return {
    spawn: vi.fn(() => ({ pid: 1, unref: vi.fn() }) as never),
    fetch: vi.fn(async () => ({ ok: true })),
    kill: vi.fn(() => true),
    readFile: vi.fn((p: string) => p === STATE_FILE
      ? JSON.stringify({ pid: 123, port, db: "t.sqlite", startedAt: "2026-06-11T00:00:00Z" } as DaemonState)
      : null),
    writeFile: vi.fn(),
    removeFile: vi.fn(),
    exists: vi.fn((p: string) => p === STATE_FILE),
    mkdirp: vi.fn(),
    openForAppend: vi.fn(() => 3),
    isProcessAlive: vi.fn(() => true),
  };
}

async function run(port: number, args: string[]): Promise<{ out: string; exitCode: number | undefined }> {
  const logs: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  const origExit = process.exitCode;
  process.exitCode = undefined;
  console.log = (...a: unknown[]) => logs.push(a.join(" "));
  console.error = (...a: unknown[]) => logs.push(a.join(" "));
  try {
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(upCommand({ lifecycleDeps: lifecycle(port), clientFactory: (u: string) => new DaemonClient(u) }));
    await prog.parseAsync(["node", "rig", "up", ...args]);
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  const exitCode = process.exitCode;
  process.exitCode = origExit;
  return { out: logs.join("\n"), exitCode };
}

describe("rig up <name> on a stopped managed rig", () => {
  let server: http.Server;
  let port: number;
  let summaries: Array<Record<string, unknown>>;
  let upStatus: number;
  let upReply: Record<string, unknown>;
  let upBodies: Array<Record<string, unknown>>;
  let libraryHits: number;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c: Buffer) => { raw += c; });
      req.on("end", () => {
        const url = req.url ?? "";
        const send = (status: number, body: unknown) => {
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(body));
        };
        if (url.startsWith("/api/specs/library")) {
          libraryHits++;
          return send(200, [{ id: "lib1", name: "alpha", kind: "rig", sourceType: "builtin", sourcePath: "/specs/alpha/rig.yaml" }]);
        }
        if (url === "/api/rigs/summary") return send(200, summaries);
        if (url.startsWith("/api/rigs/summary?archived=only")) return send(200, []);
        if (url === "/api/up" && req.method === "POST") {
          upBodies.push(JSON.parse(raw || "{}"));
          return send(upStatus, upReply);
        }
        send(200, {});
      });
    });
    await new Promise<void>((r) => { server.listen(0, r); });
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => { server.close(); });

  beforeEach(() => {
    summaries = [{ id: "rig-a", name: "alpha", nodeCount: 2, lifecycleState: "recoverable" }];
    upStatus = 200;
    upReply = {
      status: "restored", rigId: "rig-a", rigName: "alpha", snapshotKind: "auto-pre-down",
      rigResult: "fully_restored", nodes: [{ logicalId: "dev.impl", status: "resumed" }], warnings: [],
    };
    upBodies = [];
    libraryHits = 0;
  });

  it("exact name collides with a library spec: restores the stopped rig, no ambiguity", async () => {
    const { out, exitCode } = await run(port, ["alpha"]);
    expect(out).not.toContain("ambiguous");
    expect(out).toContain('Recovering rig "alpha" from latest snapshot');
    expect(out).toContain('Rig "alpha" restored');
    expect(upBodies).toHaveLength(1);
    expect(upBodies[0]!.sourceRef).toBe("alpha"); // rig-name route, not the library spec path
    expect(libraryHits).toBe(0);
    expect(exitCode).toBeUndefined();
  });

  it("stopped (not just recoverable) rigs also own their name", async () => {
    summaries = [{ id: "rig-a", name: "alpha", nodeCount: 2, lifecycleState: "stopped" }];
    const { out } = await run(port, ["alpha"]);
    expect(out).not.toContain("ambiguous");
    expect(out).toContain('Turning on rig "alpha"');
    expect(upBodies[0]!.sourceRef).toBe("alpha");
  });

  it("a RUNNING rig with a colliding library name keeps the existing ambiguity guard", async () => {
    summaries = [{ id: "rig-a", name: "alpha", nodeCount: 2, lifecycleState: "running" }];
    const { out, exitCode } = await run(port, ["alpha"]);
    expect(out).toContain("ambiguous");
    expect(upBodies).toHaveLength(0);
    expect(exitCode).toBe(1);
  });

  it("no managed rig of that name: library spec still launches as before", async () => {
    summaries = [];
    upReply = { status: "running", rigId: "rig-new", stages: [] };
    await run(port, ["alpha"]);
    expect(upBodies[0]!.sourceRef).toBe("/specs/alpha/rig.yaml");
  });

  it("no usable snapshot: clear non-destructive fallback, nothing started fresh", async () => {
    upStatus = 404;
    upReply = { error: "Rig exists but has no restore-usable snapshot and current DB state is insufficient for rehydrate.", code: "no_snapshot", rigId: "rig-a" };
    const { out, exitCode } = await run(port, ["alpha"]);
    expect(out).toContain('Could not restore rig "alpha"');
    expect(out).toContain("The restore did not run, so no sessions were started.");
    expect(out).not.toContain("no rig state was changed");
    expect(out).toContain("rig up alpha --existing --plan");
    expect(out).toContain("rig snapshot list rig-a");
    expect(out).toContain("rig restore <snapshotId> --rig rig-a");
    expect(out).not.toContain("validate your spec");
    expect(upBodies).toHaveLength(1); // no retry, no fresh fallback POST
    expect(upBodies[0]!.freshLogicalIds).toBeUndefined();
    expect(exitCode).toBe(2);
  });

  it("restore failure: same honest fallback with recovery commands", async () => {
    upStatus = 400;
    upReply = { error: "tmux server unavailable", code: "restore_error", rigId: "rig-a", rigName: "alpha" };
    const { out } = await run(port, ["alpha"]);
    expect(out).toContain('Could not restore rig "alpha": tmux server unavailable');
    expect(out).toContain("some seats may already be running");
    expect(out).toContain("Check before retrying:              rig ps --nodes --rig alpha");
    expect(out).not.toContain("no sessions were started");
    expect(out).toContain("--fresh <seat...>  (loses those seats' conversations)");
    expect(upBodies).toHaveLength(1);
  });

  it("live sessions block restore: inspect first, no copy-paste down/up chain", async () => {
    upStatus = 409;
    upReply = { error: "Rig rig-a has live sessions.", code: "rig_not_stopped", rigId: "rig-a", rigName: "alpha" };
    const { out } = await run(port, ["alpha"]);
    expect(out).toContain("Inspect them first:  rig ps --nodes --rig alpha");
    expect(out).toContain("Only if you deliberately choose to stop every live seat");
    expect(out).not.toContain("&&");
    expect(upBodies).toHaveLength(1);
  });

  it("partial restore: lists detached seats and how to recover each", async () => {
    upReply = {
      status: "restored", rigId: "rig-a", rigName: "alpha", snapshotKind: "auto-periodic", rigResult: "partially_restored",
      nodes: [
        { logicalId: "dev.impl", status: "resumed" },
        { logicalId: "dev.qa", status: "failed", error: "launch error" },
        { logicalId: "orch.lead", status: "awaiting-decision", error: "no resume token" },
        { logicalId: "rev.r1", status: "attention_required" },
      ],
      warnings: [],
    };
    const { out, exitCode } = await run(port, ["alpha"]);
    expect(out).toContain("Detached seats (no running session): dev.qa, orch.lead");
    expect(out).toContain("dev.qa: relaunch with  rig launch rig-a dev.qa");
    expect(out).toContain("--fresh orch.lead");
    expect(out).toContain("Live seats waiting on a prompt (not detached): rev.r1");
    expect(out).not.toMatch(/Detached seats.*(dev\.impl|rev\.r1)/);
    expect(upBodies).toHaveLength(1); // headless: no auto fresh-prime
    expect(exitCode).toBe(1);
  });
});
