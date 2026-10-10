import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { startLeadCompletionNotice, RECHECK_MS } from "../src/domain/lead-completion-notice.js";

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

// Multi-stretch harness: controllable clock + scheduler, so deferral/recheck is observable.
function seq() {
  const SEAT = "main-lead@provineer";
  const db = new Database(":memory:");
  db.exec("CREATE TABLE queue_items (source_session TEXT, destination_session TEXT, ts_created TEXT, state TEXT, summary TEXT, tags TEXT); CREATE TABLE outbox_entries (sender_session TEXT, destination_session TEXT, ts_dispatched TEXT);");
  let cb: (e: unknown) => void = () => {};
  let t = new Date("2026-10-10T04:00:00Z");
  let activity = "idle-at-prompt";
  const created: any[] = [];
  const timers: Array<{ at: number; fn: () => void; dead: boolean }> = [];
  startLeadCompletionNotice({
    db, now: () => t,
    eventBus: { subscribe: (f: any) => { cb = f; return () => {}; } } as any,
    queueRepo: { create: async (i: any) => { created.push(i); return i; } } as any,
    seatActivity: { getSeatStateBySession: () => ({ activity, seq: 1 }) },
    schedule: (fn, ms) => { const h = { at: t.getTime() + ms, fn, dead: false }; timers.push(h); return h; },
    cancel: (h: any) => { h.dead = true; },
  });
  const ev = () => cb({ type: "seat.activity_changed", sessionName: SEAT });
  const advance = (ms: number) => {
    const target = t.getTime() + ms;
    for (const h of timers.filter((x) => !x.dead).sort((a, b) => a.at - b.at)) {
      if (h.at <= target) { t = new Date(h.at); h.dead = true; h.fn(); }
    }
    t = new Date(target);
  };
  return {
    created,
    work: () => { activity = "working"; ev(); },
    idle: () => { activity = "idle-at-prompt"; ev(); },
    advance,
    report: () => db.prepare("INSERT INTO queue_items VALUES (?,?,?,?,?,?)").run(SEAT, "advisor-lead@kernel", t.toISOString(), "done", "report", "[]"),
    openNoticeClose: () => db.prepare("UPDATE queue_items SET state='done' WHERE tags LIKE '%auto-completion-notice%'").run(),
    flush: () => Promise.resolve(),
  };
}
const MIN = 60_000;

describe("lead completion notice: continuation after a report", () => {
  it("report, then a delegation continuation that keeps working: no notice for the continuation", async () => {
    const s = seq();
    s.work(); s.advance(3 * MIN); s.report(); s.advance(1000); s.idle();          // reported stretch: quiet
    s.advance(60_000); s.work(); s.advance(3 * MIN); s.idle();                    // continuation, no new report: deferred
    s.advance(2 * MIN); s.work();                                                 // lead resumes before recheck
    await s.flush();
    expect(s.created).toHaveLength(0);
  });
  it("report, then silently FINISH in the follow-up stretch and stay idle forever: notice fires at the bounded recheck", async () => {
    const s = seq();
    s.work(); s.advance(3 * MIN); s.report(); s.advance(1000); s.idle();
    s.advance(60_000); s.work(); s.advance(3 * MIN); s.idle();                    // silent follow-up, no more stretches
    await s.flush(); expect(s.created).toHaveLength(0);                           // deferred, not yet
    s.advance(RECHECK_MS + 1000);                                                 // nothing ever happens again
    await s.flush();
    expect(s.created).toHaveLength(1);
    expect(s.created[0].summary).toContain("not a completion");
    expect(s.created[0].summary).not.toMatch(/\bDONE\b/);
  });
  it("silent blocked lead (never reported) still gets the notice immediately", async () => {
    const s = seq();
    s.work(); s.advance(3 * MIN); s.idle();
    await s.flush();
    expect(s.created).toHaveLength(1);
  });
  it("dedup: a deferred recheck does not stack on an open notice, and fires once only", async () => {
    const s = seq();
    s.work(); s.advance(3 * MIN); s.report(); s.advance(1000); s.idle();
    s.advance(60_000); s.work(); s.advance(3 * MIN); s.idle();
    s.advance(RECHECK_MS + 1000); await s.flush();
    expect(s.created).toHaveLength(1);
    s.advance(RECHECK_MS * 3); await s.flush();                                   // no re-fire without new activity
    expect(s.created).toHaveLength(1);
  });
  it("a report during the follow-up stretch cancels the need for a notice", async () => {
    const s = seq();
    s.work(); s.advance(3 * MIN); s.report(); s.advance(1000); s.idle();
    s.advance(60_000); s.work(); s.advance(MIN); s.report(); s.advance(2 * MIN); s.idle();
    s.advance(RECHECK_MS * 2); await s.flush();
    expect(s.created).toHaveLength(0);
  });
  it("a gap longer than the recheck window between stretches is not treated as a continuation", async () => {
    const s = seq();
    s.work(); s.advance(3 * MIN); s.report(); s.advance(1000); s.idle();
    s.advance(RECHECK_MS + 5 * MIN); s.work(); s.advance(3 * MIN); s.idle();
    await s.flush();
    expect(s.created).toHaveLength(1);                                            // immediate, no deferral
  });
});
