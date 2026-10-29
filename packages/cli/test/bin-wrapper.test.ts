import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveBinEntry, resolveNodeReexecBinary, run } from "../src/bin-wrapper.js";

describe("bin-wrapper", () => {
  let tempDir: string | null = null;

  beforeEach(() => {
    vi.stubEnv("JCODE_SESSION_ID", "");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("resolves the real dist entry from a symlinked wrapper path", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-bin-wrapper-"));
    const wrapperSource = fileURLToPath(new URL("../src/bin-wrapper.ts", import.meta.url));
    const symlinkPath = path.join(tempDir, "rig");
    fs.symlinkSync(wrapperSource, symlinkPath);

    const entry = resolveBinEntry(symlinkPath, pathToFileURL(wrapperSource).href);
    expect(entry).toBe(path.resolve(path.dirname(wrapperSource), "../dist/index.js"));
  });

  it("prefers the sibling node next to the invoked rig binary when current node comes from elsewhere", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-bin-wrapper-"));
    const prefixDir = path.join(tempDir, "prefix");
    const binDir = path.join(prefixDir, "bin");
    fs.mkdirSync(binDir, { recursive: true });

    const wrapperSource = fileURLToPath(new URL("../src/bin-wrapper.ts", import.meta.url));
    const rigPath = path.join(binDir, "rig");
    const siblingNodePath = path.join(binDir, "node");
    fs.symlinkSync(wrapperSource, rigPath);
    fs.writeFileSync(siblingNodePath, "");

    const reexecNode = resolveNodeReexecBinary(
      "/opt/homebrew/bin/node",
      rigPath,
      {},
      (candidate) => candidate === siblingNodePath,
      (candidate) => candidate,
    );

    expect(reexecNode).toBe(siblingNodePath);
  });

  it("a command whose module cannot be loaded fails with the CLI's error shape, as JSON under --json", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-bin-wrapper-"));
    const dist = path.join(tempDir, "dist");
    fs.mkdirSync(dist);
    const wrapper = path.join(dist, "bin-wrapper.js");
    fs.writeFileSync(wrapper, "");
    // Its own module type, as the package declares it: Node before 22.7 would read the fixture as CommonJS.
    fs.writeFileSync(path.join(dist, "package.json"), '{ "type": "module" }\n');
    // An install missing one command's module: the lazy program loads, the command's import fails.
    fs.writeFileSync(path.join(dist, "lazy-program.js"),
      "export async function createLazyProgram() { return (await import('./commands/queue.js')).queueCommand(); }\nexport async function runProgram() { return 0; }\n");
    const run1 = async (...args: string[]) => {
      const out: string[] = [];
      const err: string[] = [];
      const codes: number[] = [];
      await run(["node", wrapper, ...args], { out: (l) => out.push(l), err: (l) => err.push(l), exit: (c) => { codes.push(c); } });
      return { out, err, codes };
    };

    const json = await run1("queue", "list", "--json");
    expect(json.codes).toEqual([1]);
    expect(json.err).toEqual([]);
    expect(json.out).toHaveLength(1);
    const parsed = JSON.parse(json.out[0]!);
    expect(parsed).toEqual({ ok: false, error: { code: "ERR_MODULE_NOT_FOUND", message: expect.stringContaining("commands/queue.js") } });

    const human = await run1("queue", "list");
    expect(human.codes).toEqual([1]);
    expect(human.out).toEqual([]);
    expect(human.err).toHaveLength(2);
    expect(human.err[0]).toBe(`error: ${parsed.error.message}`);
    expect(human.err[1]).toContain("commands/queue.js");
    expect(human.err[1]).toMatch(/\n\s+at /);
  });

  it("adopts the runtime seat before dispatching a lazy command", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-bin-wrapper-"));
    const dist = path.join(tempDir, "dist");
    fs.mkdirSync(dist);
    const wrapper = path.join(dist, "bin-wrapper.js");
    fs.writeFileSync(wrapper, "");
    fs.writeFileSync(path.join(dist, "package.json"), '{ "type": "module" }\n');
    fs.writeFileSync(path.join(dist, "lazy-program.js"), [
      "export async function createLazyProgram() { return {}; }",
      "export async function runProgram() { globalThis.__openrigLazyDispatchSeat = process.env.OPENRIG_SESSION_NAME; return 0; }",
    ].join("\n"));

    const originalRuntimeId = process.env["JCODE_SESSION_ID"];
    const originalSeat = process.env["OPENRIG_SESSION_NAME"];
    const originalNode = process.env["OPENRIG_NODE_ID"];
    process.env["JCODE_SESSION_ID"] = "runtime-session-1";
    delete process.env["OPENRIG_SESSION_NAME"];
    delete process.env["OPENRIG_NODE_ID"];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("http://127.0.0.1:7433/api/whoami/seat");
      expect(new Headers(init?.headers).get("X-OpenRig-Runtime-Session")).toBe("runtime-session-1");
      return new Response(JSON.stringify({ seat: "test-seat@kernel" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));

    try {
      await run(["node", wrapper, "queue", "whoami"]);
      expect((globalThis as typeof globalThis & { __openrigLazyDispatchSeat?: string }).__openrigLazyDispatchSeat)
        .toBe("test-seat@kernel");
      expect(process.env["OPENRIG_NODE_ID"]).toBeUndefined();
    } finally {
      delete (globalThis as typeof globalThis & { __openrigLazyDispatchSeat?: string }).__openrigLazyDispatchSeat;
      if (originalRuntimeId === undefined) delete process.env["JCODE_SESSION_ID"];
      else process.env["JCODE_SESSION_ID"] = originalRuntimeId;
      if (originalSeat === undefined) delete process.env["OPENRIG_SESSION_NAME"];
      else process.env["OPENRIG_SESSION_NAME"] = originalSeat;
      if (originalNode === undefined) delete process.env["OPENRIG_NODE_ID"];
      else process.env["OPENRIG_NODE_ID"] = originalNode;
    }
  });

  it("does not re-exec when already running under the sibling node", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-bin-wrapper-"));
    const prefixDir = path.join(tempDir, "prefix");
    const binDir = path.join(prefixDir, "bin");
    fs.mkdirSync(binDir, { recursive: true });

    const wrapperSource = fileURLToPath(new URL("../src/bin-wrapper.ts", import.meta.url));
    const rigPath = path.join(binDir, "rig");
    const siblingNodePath = path.join(binDir, "node");
    fs.symlinkSync(wrapperSource, rigPath);
    fs.writeFileSync(siblingNodePath, "");

    const reexecNode = resolveNodeReexecBinary(
      siblingNodePath,
      rigPath,
      {},
      (candidate) => candidate === siblingNodePath,
      (candidate) => candidate,
    );

    expect(reexecNode).toBeNull();
  });
});
