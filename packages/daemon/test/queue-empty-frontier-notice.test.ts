import { describe, expect, it, vi } from "vitest";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import {
  EMPTY_FRONTIER_NOTICE_ENV,
  EMPTY_FRONTIER_NOTICE_TAG,
  queueEmptyFrontierNoticeEnabled,
  startQueueEmptyFrontierNotice,
} from "../src/domain/queue-empty-frontier-notice.js";

type Row = { qitem_id: string; destination_session: string; state: string; closure_reason?: string | null; tags: string[]; summary?: string | null };

function harness(opts: { activity?: string; lead?: string | null } = {}) {
  const rows = new Map<string, Row>();
  const created: Array<Record<string, unknown>> = [];
  let listener: ((event: unknown) => void) | undefined;
  let activity = opts.activity ?? "working";
  const db = {
    prepare(sql: string) {
      return {
        get(...args: unknown[]) {
          if (sql.includes("SELECT destination_session AS destination, tags")) {
            const row = rows.get(String(args[0]));
            return row ? { destination: row.destination_session, tags: JSON.stringify(row.tags) } : undefined;
          }
          if (sql.includes("SELECT 1 FROM queue_items WHERE destination_session = ? AND state IN")) {
            return [...rows.values()].find((row) => row.destination_session === args[0] && ["pending", "in-progress"].includes(row.state));
          }
          if (sql.includes("tags LIKE")) {
            return [...rows.values()].find((row) => ["pending", "in-progress", "blocked"].includes(row.state) && row.tags.some((tag) => String(args[0]).includes(tag)));
          }
          return undefined;
        },
        all(...args: unknown[]) {
          if (sql.includes("state = 'blocked'")) {
            return [...rows.values()].filter((row) => row.destination_session === args[0] && row.state === "blocked").map((row) => ({ id: row.qitem_id, summary: row.summary ?? null }));
          }
          return [];
        },
      };
    },
  };
  const eventBus = { subscribe: vi.fn((fn: (event: unknown) => void) => { listener = fn; return () => { listener = undefined; }; }) };
  const queueRepo = {
    create: vi.fn(async (input: Record<string, unknown>) => {
      created.push(input);
      rows.set(`notice-${created.length}`, {
        qitem_id: `notice-${created.length}`,
        destination_session: String(input.destinationSession),
        state: "pending",
        tags: input.tags as string[],
      });
    }),
  };
  const seatActivity = { getSeatStateBySession: vi.fn(() => ({ activity })) };
  const stop = startQueueEmptyFrontierNotice({
    db: db as never,
    eventBus: eventBus as never,
    queueRepo: queueRepo as never,
    seatActivity,
    resolveLead: () => opts.lead === undefined ? "main-lead@test" : opts.lead,
  });
  const emit = (event: Record<string, unknown>) => listener?.(event);
  const completion = (id: string, destination = "worker@test", closureReason: string | null = "no-follow-on") => {
    rows.set(id, { qitem_id: id, destination_session: destination, state: "done", closure_reason: closureReason, tags: [] });
    emit({ type: "queue.updated", qitemId: id, fromState: "in-progress", toState: "done", closureReason });
  };
  const setActivity = (value: string) => { activity = value; emit({ type: "seat.activity_changed", sessionName: "worker@test" }); };
  return { rows, created, stop, completion, emit, setActivity, queueRepo };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("queue empty-frontier notice", () => {
  it("is disabled unless explicitly opted in", () => {
    expect(queueEmptyFrontierNoticeEnabled({})).toBe(false);
    expect(queueEmptyFrontierNoticeEnabled({ [EMPTY_FRONTIER_NOTICE_ENV]: "true" })).toBe(false);
    expect(queueEmptyFrontierNoticeEnabled({ [EMPTY_FRONTIER_NOTICE_ENV]: "1" })).toBe(true);
  });

  it("cues the resolved lead after a no-follow-on close when already idle", async () => {
    const h = harness({ activity: "idle-at-prompt" });
    h.completion("q1");
    await flush();
    expect(h.created).toHaveLength(1);
    expect(h.created[0]?.destinationSession).toBe("main-lead@test");
    expect(h.created[0]?.sourceSession).toBe("daemon@kernel");
    expect(h.created[0]?.tags).toContain(EMPTY_FRONTIER_NOTICE_TAG);
    expect(h.created[0]?.body).toContain("not a completion claim");
    h.stop();
  });

  it("holds the closure until the seat becomes idle", async () => {
    const h = harness();
    h.completion("q1");
    await flush();
    expect(h.created).toHaveLength(0);
    h.setActivity("idle-at-prompt");
    await flush();
    expect(h.created).toHaveLength(1);
    h.stop();
  });

  it("does not cue while actionable work exists, then reevaluates after it closes", async () => {
    const h = harness({ activity: "idle-at-prompt" });
    h.rows.set("next", { qitem_id: "next", destination_session: "worker@test", state: "pending", tags: [] });
    h.completion("q1");
    await flush();
    expect(h.created).toHaveLength(0);
    h.rows.set("next", { qitem_id: "next", destination_session: "worker@test", state: "blocked", tags: [] });
    h.emit({ type: "queue.updated", qitemId: "next", fromState: "pending", toState: "blocked", closureReason: null });
    await flush();
    expect(h.created).toHaveLength(1);
    expect(h.created[0]?.body).toContain("Blocked obligations remain");
    h.stop();
  });

  it("ignores other closure reasons and does not guess a missing lead", async () => {
    const h = harness({ activity: "idle-at-prompt", lead: null });
    h.completion("q1", "worker@test", "completed");
    h.completion("q2");
    await flush();
    expect(h.created).toHaveLength(0);
    h.stop();
  });

  it("coalesces repeated completions behind one open cue and ignores its own events", async () => {
    const h = harness({ activity: "idle-at-prompt" });
    h.completion("q1");
    h.completion("q2");
    await flush();
    expect(h.created).toHaveLength(1);
    expect(h.created[0]?.body).toContain("q1 (no-follow-on)");
    expect(h.created[0]?.body).toContain("q2 (no-follow-on)");
    const noticeId = "notice-1";
    h.emit({ type: "queue.updated", qitemId: noticeId, fromState: "in-progress", toState: "done", closureReason: "no-follow-on" });
    await flush();
    expect(h.created).toHaveLength(1);
    h.stop();
  });

  it("unsubscribes cleanly", () => {
    const h = harness();
    h.stop();
    expect(h.queueRepo.create).not.toHaveBeenCalled();
  });

  it("cues the original sender after a real handoff and idle event, not the recipient successor", async () => {
    const db = createDb();
    migrate(db, ALL_MIGRATIONS);
    const eventBus = new EventBus(db);
    const repo = new QueueRepository(db, eventBus, { validateRig: () => true });
    let activity = "working";
    const stop = startQueueEmptyFrontierNotice({
      db,
      eventBus,
      queueRepo: repo,
      seatActivity: { getSeatStateBySession: () => ({ activity }) },
      resolveLead: (_db, seat) => seat === "researcher@test" ? "lead@test" : null,
    });

    try {
      const source = await repo.create({
        sourceSession: "lead@test",
        destinationSession: "researcher@test",
        body: "research the existing bug",
        nudge: false,
      });
      repo.claim({ qitemId: source.qitemId, destinationSession: "researcher@test" });
      const handoff = await repo.handoff({
        qitemId: source.qitemId,
        fromSession: "researcher@test",
        toSession: "architect@test",
        body: "review the research",
        nudge: false,
      });
      expect(handoff.closed.state).toBe("handed-off");
      expect(handoff.created.destinationSession).toBe("architect@test");

      activity = "idle-at-prompt";
      eventBus.emit({
        type: "seat.activity_changed",
        sessionName: "researcher@test",
        seatNodeId: "researcher-node",
        seq: 1,
        at: new Date().toISOString(),
      } as never);
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));

      const cues = db.prepare(
        "SELECT source_session, destination_session, body, tags FROM queue_items WHERE source_session = 'daemon@kernel' AND tags LIKE ?",
      ).all(`%${EMPTY_FRONTIER_NOTICE_TAG}%`) as Array<{ source_session: string; destination_session: string; body: string; tags: string }>;
      expect(cues).toHaveLength(1);
      expect(cues[0]?.destination_session).toBe("lead@test");
      expect(cues[0]?.body).toContain(`${source.qitemId} (handed off to architect@test)`);
      expect(cues[0]?.body).toContain("successor belongs to its recipient");
      expect(repo.getById(handoff.created.qitemId)?.destinationSession).toBe("architect@test");
      expect(repo.list({ destinationSession: "researcher@test", state: ["pending", "in-progress"] })).toHaveLength(0);
    } finally {
      stop();
      db.close();
    }
  });

  it("cues the original sender after handoff-and-complete when that sender becomes idle", async () => {
    const db = createDb();
    migrate(db, ALL_MIGRATIONS);
    const eventBus = new EventBus(db);
    const repo = new QueueRepository(db, eventBus, { validateRig: () => true });
    let activity = "working";
    const stop = startQueueEmptyFrontierNotice({
      db,
      eventBus,
      queueRepo: repo,
      seatActivity: { getSeatStateBySession: () => ({ activity }) },
      resolveLead: (_db, seat) => seat === "researcher@test" ? "lead@test" : null,
    });

    try {
      const source = await repo.create({
        sourceSession: "lead@test",
        destinationSession: "researcher@test",
        body: "complete the research and hand off review",
        nudge: false,
      });
      repo.claim({ qitemId: source.qitemId, destinationSession: "researcher@test" });
      const handoff = await repo.handoffAndComplete({
        qitemId: source.qitemId,
        fromSession: "researcher@test",
        toSession: "architect@test",
        body: "review the research",
        nudge: false,
      });
      expect(handoff.closed.state).toBe("done");
      expect(handoff.created.destinationSession).toBe("architect@test");

      activity = "idle-at-prompt";
      eventBus.emit({
        type: "seat.activity_changed",
        sessionName: "researcher@test",
        seatNodeId: "researcher-node",
        seq: 1,
        at: new Date().toISOString(),
      } as never);
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));

      const cues = db.prepare(
        "SELECT destination_session, body, tags FROM queue_items WHERE source_session = 'daemon@kernel' AND tags LIKE ?",
      ).all(`%${EMPTY_FRONTIER_NOTICE_TAG}%`) as Array<{ destination_session: string; body: string; tags: string }>;
      expect(cues).toHaveLength(1);
      expect(cues[0]?.destination_session).toBe("lead@test");
      expect(cues[0]?.body).toContain(`${source.qitemId} (handed off to architect@test)`);
      expect(cues[0]?.body).toContain("successor belongs to its recipient");
      expect(repo.getById(handoff.created.qitemId)?.destinationSession).toBe("architect@test");
      expect(repo.list({ destinationSession: "researcher@test", state: ["pending", "in-progress"] })).toHaveLength(0);
    } finally {
      stop();
      db.close();
    }
  });

  it("cues the original sender for the persisted queue.updated done/handed_off_to path", async () => {
    const db = createDb();
    migrate(db, ALL_MIGRATIONS);
    const eventBus = new EventBus(db);
    const repo = new QueueRepository(db, eventBus, { validateRig: () => true });
    let activity = "working";
    const stop = startQueueEmptyFrontierNotice({
      db,
      eventBus,
      queueRepo: repo,
      seatActivity: { getSeatStateBySession: () => ({ activity }) },
      resolveLead: (_db, seat) => seat === "researcher@test" ? "lead@test" : null,
    });

    try {
      const source = await repo.create({
        sourceSession: "lead@test",
        destinationSession: "researcher@test",
        body: "complete a concrete production-path inventory",
        nudge: false,
      });
      repo.claim({ qitemId: source.qitemId, destinationSession: "researcher@test" });
      const successor = await repo.create({
        sourceSession: "researcher@test",
        destinationSession: "architect@test",
        body: "review the completed production-path inventory",
        nudge: false,
      });
      repo.update({
        qitemId: source.qitemId,
        actorSession: "researcher@test",
        state: "done",
        closureReason: "handed_off_to",
        closureTarget: successor.qitemId,
      });

      activity = "idle-at-prompt";
      eventBus.emit({
        type: "seat.activity_changed",
        sessionName: "researcher@test",
        seatNodeId: "researcher-node",
        seq: 1,
        at: new Date().toISOString(),
      } as never);
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));

      const cues = db.prepare(
        "SELECT destination_session, body, tags FROM queue_items WHERE source_session = 'daemon@kernel' AND tags LIKE ?",
      ).all(`%${EMPTY_FRONTIER_NOTICE_TAG}%`) as Array<{ destination_session: string; body: string; tags: string }>;
      expect(cues).toHaveLength(1);
      expect(cues[0]?.destination_session).toBe("lead@test");
      expect(cues[0]?.body).toContain(`${source.qitemId} (handed off to architect@test)`);
      expect(cues[0]?.body).toContain("successor belongs to its recipient");
      expect(repo.getById(successor.qitemId)?.destinationSession).toBe("architect@test");
      expect(repo.list({ destinationSession: "researcher@test", state: ["pending", "in-progress"] })).toHaveLength(0);
    } finally {
      stop();
      db.close();
    }
  });
});
