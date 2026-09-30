import { describe, expect, it } from "vitest";
import { observerRuntimeLife } from "../src/domain/terminal/managed-herdr-inventory.js";
import type { NativeProcessRow } from "../src/domain/native-process-lineage.js";
const shell: NativeProcessRow = { pid: 10, ppid: 1, command: "/bin/sh", executableName: "sh" };
describe("managed observer process truth", () => {
  it("recognizes the exact resumed Jcode client beneath a launch wrapper", () => {
    expect(observerRuntimeLife([shell, { pid: 11, ppid: 10, command: "/build/jcode --resume native-token -m model", executableName: "jcode" }], 10, "jcode", "native-token")).toBe("running");
  });
  it("never treats a wrong-token client or a server-only process as the target TUI", () => {
    expect(observerRuntimeLife([shell, { pid: 11, ppid: 10, command: "jcode --resume another" }], 10, "jcode", "native-token")).toBe("unknown");
    expect(observerRuntimeLife([{ pid: 10, ppid: 1, command: "jcode serve", executableName: "jcode" }], 10, "jcode")).toBe("unknown");
  });
  it("proves a natural return to bare shell but retains ambiguous/transient observations", () => {
    expect(observerRuntimeLife([shell], 10, "jcode")).toBe("absent");
    expect(observerRuntimeLife([], 10, "jcode")).toBe("unknown");
    expect(observerRuntimeLife([{ pid: 10, ppid: 1, command: "node something", executableName: "node" }], 10, "jcode")).toBe("unknown");
    expect(observerRuntimeLife([shell, { pid: 11, ppid: 10, command: "sleep 20" }], 10, "jcode")).toBe("unknown");
  });
  it("includes infrastructure seats but does not invent unsupported runtime identity", () => {
    expect(observerRuntimeLife([shell], 10, "terminal")).toBe("running");
    expect(observerRuntimeLife([shell], 10, "unknown-provider")).toBe("unknown");
  });
  it("recognizes native Claude and Codex resume arguments", () => {
    expect(observerRuntimeLife([{ ...shell, command: "/bin/claude --resume token", executableName: "claude" }], 10, "claude-code", "token")).toBe("running");
    expect(observerRuntimeLife([{ ...shell, command: "/bin/codex resume token", executableName: "codex" }], 10, "codex", "token")).toBe("running");
  });
});
