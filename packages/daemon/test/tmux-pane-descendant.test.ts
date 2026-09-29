import { describe, it, expect } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { isShellForeground } from "../src/domain/shell-classifier.js";

// Fork: seats launched via `/bin/sh <script>` show `sh` as pane_current_command
// while the agent runtime runs as the script's child.
function adapter(table: string, panePid = "100") {
  const exec = async (cmd: string) => {
    if (cmd.includes("#{pane_pid}")) return `${panePid}\n`;
    if (cmd.startsWith("ps ")) return table;
    throw new Error(`unexpected ${cmd}`);
  };
  return new TmuxAdapter(exec as never);
}
const isShell = (c: string) => isShellForeground(c);

describe("TmuxAdapter.paneHasNonShellDescendant", () => {
  it("finds a runtime under a /bin/sh wrapper", async () => {
    const t = adapter(["  100     1 -zsh", "  200   100 /bin/sh", "  300   200 /Users/x/.jcode/builds/current/jcode", "  999     1 other"].join("\n"));
    expect(await t.paneHasNonShellDescendant("%1", isShell)).toBe(true);
  });

  it("a bare shell with only shell children is not a runtime", async () => {
    const t = adapter(["  100     1 -zsh", "  200   100 /bin/sh", "  999     1 jcode"].join("\n"));
    expect(await t.paneHasNonShellDescendant("%1", isShell)).toBe(false);
  });

  it("an unreadable pane pid is unknown", async () => {
    const t = adapter("", "");
    expect(await t.paneHasNonShellDescendant("%1", isShell)).toBeNull();
  });
});
