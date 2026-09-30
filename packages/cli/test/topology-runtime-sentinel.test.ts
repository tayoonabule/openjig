import { describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { parse } from "yaml";
import { createCommand } from "../src/commands/create.js";
import { growCommand } from "../src/commands/grow.js";
import type { StatusDeps } from "../src/commands/status.js";
import { STATE_FILE } from "../src/daemon-lifecycle.js";

function fixture() {
  const get = vi.fn(async (url: string) => ({ status: 200, data: url.includes("library")
    ? [{ kind: "agent", name: "orchestrator", sourceType: "builtin", sourcePath: "/installed/orchestrator/agent.yaml" }]
    : [{ rigName: "fixture", podNamespace: "main" }] }));
  const node = { logicalId: "main.lead", status: "launched", sessionName: "main-lead@fixture" };
  const postText = vi.fn(async () => ({ status: 201, data: { rigId: "rig", nodes: [node] } }));
  const post = vi.fn(async (_url: string, body: any) => ({ status: 201, data: { ok: true, status: "ok", result: { podNamespace: "main", node }, nodes: (body.pod?.members ?? [body.member]).map((m: any) => ({ ...node, logicalId: "main." + m.id })) } }));
  const deps = { lifecycleDeps: {
    spawn: vi.fn(), fetch: vi.fn(async () => ({ ok: true })), kill: vi.fn(),
    readFile: (p: string) => p === STATE_FILE ? JSON.stringify({ pid: 123, port: 1234, db: "fixture.sqlite", startedAt: "2026-09-30T00:00:00Z" }) : null,
    writeFile: vi.fn(), removeFile: vi.fn(), exists: (p: string) => p === STATE_FILE,
    mkdirp: vi.fn(), openForAppend: vi.fn(), isProcessAlive: () => true,
  }, clientFactory: () => ({ get, postText, post }) } as unknown as StatusDeps;
  return { deps, get, postText, post };
}

async function invoke(cmd: Command, args: string[]) {
  const previous = process.exitCode;
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    process.exitCode = undefined;
    await new Command().addCommand(cmd).parseAsync(["node", "rig", ...args]);
    expect(process.exitCode).toBeUndefined();
  } finally { output.mockRestore(); process.exitCode = previous; }
}

describe("create/grow runtime request authority", () => {
  it.each(["terminal", "jcode"])("create selects the correct %s agent and profile", async runtime => {
    const f = fixture();
    await invoke(createCommand(f.deps), ["create", "fixture", "--runtime", runtime, "--cwd", "/fixture", "--json"]);
    const member = parse(f.postText.mock.calls[0]![1] as string).pods[0].members[0];
    expect(member).toMatchObject({ runtime, agent_ref: runtime === "terminal" ? "builtin:terminal" : "path:/installed/orchestrator", profile: runtime === "terminal" ? "none" : "default" });
    expect(f.get.mock.calls.some(([url]) => url.includes("library"))).toBe(runtime !== "terminal");
  });
  it.each([false, true])("terminal grow emits sentinel for new-pod=%s without agent-library lookup", async newPod => {
    const f = fixture();
    await invoke(growCommand(f.deps), ["grow", "rig", "helper", "--runtime", "terminal", "--cwd", "/fixture", "--json", ...(newPod ? ["--new-pod", "extra"] : [])]);
    const body = f.post.mock.calls[0]![1] as any;
    const member = newPod ? body.pod.members[0] : body.member;
    expect(member).toMatchObject({ runtime: "terminal", agent_ref: "builtin:terminal", profile: "none" });
    expect(f.get.mock.calls.some(([url]) => url.includes("library"))).toBe(false);
  });
});
