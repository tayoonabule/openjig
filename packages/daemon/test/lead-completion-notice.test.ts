import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { startLeadCompletionNotice } from "../src/domain/lead-completion-notice.js";

function setup(opts: { reported?: boolean; workMs: number; blocked?: boolean; openNotice?: boolean }) {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE queue_items (source_session TEXT, destination_session TEXT, ts_created TEXT, state TEXT, summary TEXT, tags TEXT); CREATE TABLE outbox_entries (sender_session TEXT, destination_session TEXT, ts_dispatched TEXT);");
  let cb: (e: unknown) => void = () => {};
  let t = new Date("2026-10-10T00:00:00Z");
  let activity = "working";
  const created: any[] = [];
  startLeadCompletionNotice({
    db, now: () => t,
    eventBus: { subscribe: (f: any) => { cb = f; return () => {}; } } as any,
    queueRepo: { create: async (i: any) => { created.push(i); return i; } } as any,
    seatActivity: { getSeatStateBySession: () => ({ activity, seq: 1 }) },
  });
  const fire = (name: string) => cb({ type: "seat.activity_changed", sessionName: name });
  fire("main-lead@drewl-docs");
  if (opts.blocked) db.prepare("INSERT INTO queue_items VALUES (?,?,?,?,?,?)").run("main-lead@drewl-docs", "build-qa@drewl-docs", "2026-10-09T23:00:00Z", "blocked", "waiting on QA verdict", "[]");
  if (opts.openNotice) db.prepare("INSERT INTO queue_items VALUES (?,?,?,?,?,?)").run("advisor-lead@kernel", "advisor-lead@kernel", "2026-10-09T23:30:00Z", "pending", "AUTO", '["auto-completion-notice","auto-completion-notice:main-lead@drewl-docs"]');
  t = new Date(t.getTime() + 1);
  if (opts.reported) db.prepare("INSERT INTO outbox_entries VALUES (?,?,?)").run("main-lead@drewl-docs", "advisor-lead@kernel", "2026-10-10T00:00:30.000Z");
  t = new Date(t.getTime() + opts.workMs);
  activity = "idle-at-prompt";
  fire("main-lead@drewl-docs");
  return created;
}

describe("lead completion notice", () => {
  it("queues a notice to the advisor when a lead goes idle after real work with no report", async () => {
    const c = setup({ workMs: 300_000 });
    await Promise.resolve();
    expect(c).toHaveLength(1);
    expect(c[0].destinationSession).toBe("advisor-lead@kernel");
    expect(c[0].sourceSession).toBe("advisor-lead@kernel"); // never attributed to the lead
    expect(c[0].summary).toContain("not a completion");
    expect(c[0].summary).not.toMatch(/\bDONE\b/);
    expect(c[0].body).toContain("NOT a DONE");
  });
  it("cites a blocked / peer-wait item as evidence and still does not claim done", async () => {
    const c = setup({ workMs: 300_000, blocked: true });
    await Promise.resolve();
    expect(c).toHaveLength(1);
    expect(c[0].body).toContain("blocked -> build-qa@drewl-docs: waiting on QA verdict");
    expect(c[0].body).toContain("DONE, BLOCKED or DECISION");
  });
  it("does not stack a second notice while one is open for the seat", () => {
    expect(setup({ workMs: 300_000, openNotice: true })).toHaveLength(0);
  });
  it("stays quiet when the lead already reported to the advisor", () => {
    expect(setup({ workMs: 300_000, reported: true })).toHaveLength(0);
  });
  it("stays quiet for short work", () => {
    expect(setup({ workMs: 10_000 })).toHaveLength(0);
  });
});
