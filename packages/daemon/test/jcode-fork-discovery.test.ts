import { describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { discoverResumeToken } from "../src/domain/agent-images/resume-token-discovery.js";

const JCODE_ID = "session_pawprint_1790452241627_af58a2777b9bb0e4";

function fakeDb(runtime: string | null, resumeToken: string | null): Database.Database {
  return {
    prepare: (sql: string) => ({
      get: () => sql.includes("FROM sessions")
        ? { id: "s1", node_id: "n1", resume_token: resumeToken }
        : sql.includes("FROM nodes") ? { runtime, cwd: "/repo" } : undefined,
    }),
  } as unknown as Database.Database;
}

describe("discoverResumeToken for jcode seats", () => {
  it("returns the captured jcode session id as the fork source", () => {
    expect(discoverResumeToken(fakeDb("jcode", JCODE_ID), "dev-impl@rig")).toEqual({
      ok: true, result: { runtime: "jcode", nativeId: JCODE_ID, nodeCwd: "/repo" },
    });
  });

  it("reports a null id before jcode has captured one, so callers refuse honestly", () => {
    const outcome = discoverResumeToken(fakeDb("jcode", null), "dev-impl@rig");
    expect(outcome).toMatchObject({ ok: true, result: { runtime: "jcode", nativeId: null } });
  });

  it("still refuses runtimes without a fork primitive and names jcode as supported", () => {
    const outcome = discoverResumeToken(fakeDb("terminal", null), "human@rig");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failure.message).toContain("claude-code, codex and jcode");
  });
});
