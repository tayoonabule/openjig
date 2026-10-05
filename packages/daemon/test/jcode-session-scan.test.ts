import { describe, expect, it, vi } from "vitest";
import { scanJcodeSessions, type JcodeSessionFs } from "../src/adapters/jcode-session.js";

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
