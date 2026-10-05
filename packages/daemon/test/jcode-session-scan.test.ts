import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanJcodeSessions, readSavedJcodeModel, type JcodeSessionFs } from "../src/adapters/jcode-session.js";

const HOME = "/home/u";
const dir = `${HOME}/.jcode/sessions`;
function fsOf(files: Record<string, string>) {
  const readFile = vi.fn((p: string) => { if (!(p in files)) throw new Error("ENOENT"); return files[p]!; });
  const ops: JcodeSessionFs = { readFile, exists: () => true, listFiles: () => Object.keys(files).map(p => p.slice(dir.length + 1)) };
  return { ops, readFile };
}
const OLD = "session_old_1780000000000_aaaa";
const NEW = "session_new_1790000000000_bbbb";

describe("scanJcodeSessions never reads transcripts it does not need", () => {
  it("idsOnly returns ids and creation times from file names without opening any file", () => {
    const { ops, readFile } = fsOf({ [`${dir}/${OLD}.json`]: "x".repeat(10), [`${dir}/${NEW}.json`]: "x" });
    const rows = scanJcodeSessions(ops, HOME, { idsOnly: true });
    expect(rows.map(r => r.id).sort()).toEqual([NEW, OLD]);
    expect(readFile).not.toHaveBeenCalled();
  });
  it("since skips older sessions without opening them but still opens newer ones", () => {
    const { ops, readFile } = fsOf({
      [`${dir}/${OLD}.json`]: JSON.stringify({ id: OLD, working_dir: "/a", created_at: 1780000000000 }),
      [`${dir}/${NEW}.json`]: JSON.stringify({ id: NEW, working_dir: "/p", created_at: 1790000000000 }),
    });
    const rows = scanJcodeSessions(ops, HOME, { since: 1785000000000 });
    expect(rows).toEqual([{ id: NEW, workingDir: "/p", createdAt: 1790000000000 }]);
    expect(readFile).toHaveBeenCalledTimes(1);
  });
  it("still parses files whose names do not follow the convention", () => {
    const { ops } = fsOf({ [`${dir}/odd.json`]: JSON.stringify({ id: "odd", working_dir: "/x", created_at: 1790000000000 }) });
    expect(scanJcodeSessions(ops, HOME, { since: 1 })).toHaveLength(1);
  });
});

describe("readSavedJcodeModel", () => {
  const home = mkdtempSync(join(tmpdir(), "saved-model-"));
  const dir = join(home, ".jcode", "sessions"); mkdirSync(dir, { recursive: true });
  const write = (id: string, body: string) => writeFileSync(join(dir, `${id}.json`), body);
  it("reads the saved model from the tail of a session without loading the transcript", () => {
    const huge = JSON.stringify({ messages: Array.from({ length: 30000 }, (_, i) => ({ role: "user", content: "x".repeat(60), i })) });
    write("session_big_1790000000000_aa", `{"id":"session_big_1790000000000_aa","messages":${huge.slice(12, -1)},"provider_key":"openai","model":"claude-sonnet-5-5","is_canary":false}`);
    expect(readSavedJcodeModel(home, "session_big_1790000000000_aa")).toBe("claude-sonnet-5-5");
  });
  it("returns null for a missing session, a bad token or no model, keeping the safe hold", () => {
    write("session_nomodel_1790000000000_bb", '{"messages":[],"provider_key":null}');
    expect(readSavedJcodeModel(home, "session_nomodel_1790000000000_bb")).toBeNull();
    expect(readSavedJcodeModel(home, "session_missing_1790000000000_cc")).toBeNull();
    expect(readSavedJcodeModel(home, "../../etc/passwd")).toBeNull();
    rmSync(home, { recursive: true, force: true });
  });
});
