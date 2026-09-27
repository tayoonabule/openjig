import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseJsonlExchanges, readJcodeSessionExchanges } from "../src/domain/session-jsonl.js";

// Seat-handover boot recap: read the PROVIDER session JSONL (claude sidecar
// transcript_path / codex rollout_path) into the last-N {role, content} exchanges for the boot recap.
// Defensive / honest-degraded: metadata + thinking/tool_use-only lines carry no user text and are
// skipped; unparseable lines are skipped (a corrupt tail never throws). Grounded on the real
// claude-projects line shape ({type,message:{role,content}}; content string OR [{type,text}] blocks).

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function fixture(lines: unknown[]): string {
  const d = mkdtempSync(join(tmpdir(), "sj-"));
  dirs.push(d);
  const p = join(d, "transcript.jsonl");
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return p;
}

describe("parseJsonlExchanges — claude-projects role/content shape", () => {
  it("extracts {role, content} from user-string + assistant-text lines, newest-last", () => {
    const p = fixture([
      { type: "custom-title", customTitle: "x" }, // metadata — skipped
      { type: "user", message: { role: "user", content: "do the thing" } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "thinking", text: "hmm" }] } }, // thinking-only — skipped
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "done the thing" }] } },
    ]);
    expect(parseJsonlExchanges(p, 10)).toEqual([
      { role: "user", content: "do the thing" },
      { role: "assistant", content: "done the thing" },
    ]);
  });

  it("joins multiple text blocks and skips tool_use blocks in an assistant array", () => {
    const p = fixture([
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "part A" }, { type: "tool_use", name: "x" }, { type: "text", text: "part B" }] } },
    ]);
    expect(parseJsonlExchanges(p, 10)).toEqual([{ role: "assistant", content: "part A\npart B" }]);
  });

  it("bounds to the last N exchanges", () => {
    const p = fixture([
      { type: "user", message: { role: "user", content: "1" } },
      { type: "user", message: { role: "user", content: "2" } },
      { type: "user", message: { role: "user", content: "3" } },
    ]);
    expect(parseJsonlExchanges(p, 2)).toEqual([
      { role: "user", content: "2" },
      { role: "user", content: "3" },
    ]);
  });

  it("skips unparseable lines (corrupt tail never throws) and empty-text messages", () => {
    const d = mkdtempSync(join(tmpdir(), "sj-"));
    dirs.push(d);
    const p = join(d, "t.jsonl");
    writeFileSync(p, [
      JSON.stringify({ type: "user", message: { role: "user", content: "good" } }),
      "{ this is not json",
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "x" }] } }), // no text → skipped
    ].join("\n") + "\n");
    expect(parseJsonlExchanges(p, 10)).toEqual([{ role: "user", content: "good" }]);
  });

  it("a missing file yields [] (honest-degraded, never throws)", () => {
    expect(parseJsonlExchanges(join(tmpdir(), "does-not-exist-xyz.jsonl"), 5)).toEqual([]);
  });

  it("also reads the codex rollout shape (payload.type=message with role/content)", () => {
    const p = fixture([
      { payload: { type: "message", role: "user", content: "codex hello" } },
      { payload: { type: "token_count", info: {} } }, // non-message — skipped
    ]);
    expect(parseJsonlExchanges(p, 10)).toEqual([{ role: "user", content: "codex hello" }]);
  });
});

// readJcodeSessionExchanges reads ~/.jcode/sessions/<resumeToken>.json (a single JSON
// document, not a JSONL transcript) into {role, content} exchanges, reusing extractText.
describe("readJcodeSessionExchanges — jcode session-JSON shape (structured document, not JSONL)", () => {
  function jcodeHome(sessionId: string, body: Record<string, unknown>): string {
    const home = mkdtempSync(join(tmpdir(), "jcode-recap-"));
    dirs.push(home);
    mkdirSync(join(home, ".jcode", "sessions"), { recursive: true });
    writeFileSync(join(home, ".jcode", "sessions", `${sessionId}.json`), JSON.stringify(body));
    return home;
  }

  it("extracts {role, content} from messages[] with string content", () => {
    const home = jcodeHome("sess-1", {
      id: "sess-1",
      messages: [
        { role: "user", content: "do the thing" },
        { role: "assistant", content: "done the thing" },
      ],
    });
    const result = readJcodeSessionExchanges(home, "sess-1");
    expect(result?.exchanges).toEqual([
      { role: "user", content: "do the thing" },
      { role: "assistant", content: "done the thing" },
    ]);
    expect(result?.path).toBe(join(home, ".jcode", "sessions", "sess-1.json"));
  });

  it("joins text blocks and skips tool_use/reasoning-only blocks in an array content field", () => {
    const home = jcodeHome("sess-2", {
      messages: [
        { role: "assistant", content: [{ type: "text", text: "part A" }, { type: "tool_use", name: "x" }, { type: "text", text: "part B" }] },
        { role: "assistant", content: [{ type: "reasoning_trace", text: "hmm" }] }, // no text block — skipped
      ],
    });
    expect(readJcodeSessionExchanges(home, "sess-2")?.exchanges).toEqual([
      { role: "assistant", content: "part A\npart B" },
    ]);
  });

  it("a missing session file returns null (honest 'no record', distinct from an empty one)", () => {
    const home = mkdtempSync(join(tmpdir(), "jcode-recap-"));
    dirs.push(home);
    mkdirSync(join(home, ".jcode", "sessions"), { recursive: true });
    expect(readJcodeSessionExchanges(home, "does-not-exist")).toBeNull();
  });

  it("a malformed (corrupt JSON) session file returns null, never throws", () => {
    const home = mkdtempSync(join(tmpdir(), "jcode-recap-"));
    dirs.push(home);
    mkdirSync(join(home, ".jcode", "sessions"), { recursive: true });
    writeFileSync(join(home, ".jcode", "sessions", "sess-bad.json"), "{ not json");
    expect(readJcodeSessionExchanges(home, "sess-bad")).toBeNull();
  });

  it("a session file with no messages[] array returns null (malformed shape)", () => {
    const home = jcodeHome("sess-noarr", { id: "sess-noarr" });
    expect(readJcodeSessionExchanges(home, "sess-noarr")).toBeNull();
  });

  it("an empty messages[] array (or all text-less messages) returns a present result with zero exchanges — distinct from null", () => {
    const home = jcodeHome("sess-empty", { messages: [] });
    const result = readJcodeSessionExchanges(home, "sess-empty");
    expect(result).not.toBeNull();
    expect(result?.exchanges).toEqual([]);
  });
});
