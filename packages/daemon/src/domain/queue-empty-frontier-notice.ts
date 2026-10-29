import type Database from "better-sqlite3";
import type { EventBus } from "./event-bus.js";
import { defaultResolveOrchestrator } from "./queue-owner.js";
import type { QueueRepository } from "./queue-repository.js";

/**
 * Opt-in, event-driven cue for a seat that explicitly closed its work with no successor,
 * is now idle, and has no pending/in-progress assignment. It only asks the topology-resolved
 * lead to review the frontier; it never invents or assigns work. Candidate closures are held
 * in memory until idle is observed, covering either event ordering without polling.
 */
export const EMPTY_FRONTIER_NOTICE_TAG = "auto-empty-frontier-notice";
export const EMPTY_FRONTIER_NOTICE_ENV = "OPENRIG_QUEUE_EMPTY_FRONTIER_NOTICE";

export function queueEmptyFrontierNoticeEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[EMPTY_FRONTIER_NOTICE_ENV] === "1";
}

interface SeatStateReader {
  getSeatStateBySession(name: string): { activity: string } | null;
}

interface QueueNoticeEvent {
  type?: string;
  qitemId?: string;
  fromState?: string;
  toState?: string;
  closureReason?: string | null;
}

export function startQueueEmptyFrontierNotice(deps: {
  db: Database.Database;
  eventBus: Pick<EventBus, "subscribe">;
  queueRepo: Pick<QueueRepository, "create">;
  seatActivity: SeatStateReader;
  resolveLead?: (db: Database.Database, session: string) => string | null;
  sourceSession?: string;
}): () => void {
  const resolveLead = deps.resolveLead ?? defaultResolveOrchestrator;
  const sourceSession = deps.sourceSession ?? "daemon@kernel";
  const candidates = new Map<string, Set<string>>();
  const notifying = new Set<string>();
  const scheduled = new Set<string>();
  let disposed = false;

  const evaluate = (seat: string): void => {
    if (disposed || notifying.has(seat)) return;
    const completions = candidates.get(seat);
    if (!completions?.size) return;
    try {
      if (deps.seatActivity.getSeatStateBySession(seat)?.activity !== "idle-at-prompt") return;
      const lead = resolveLead(deps.db, seat);
      if (!lead) return;

      const actionable = deps.db.prepare(
        "SELECT 1 FROM queue_items WHERE destination_session = ? AND state IN ('pending','in-progress') LIMIT 1",
      ).get(seat);
      if (actionable) return;

      const noticeTag = `${EMPTY_FRONTIER_NOTICE_TAG}:${seat}`;
      const existingNotice = deps.db.prepare(
        "SELECT 1 FROM queue_items WHERE state IN ('pending','in-progress','blocked') AND tags LIKE ? LIMIT 1",
      ).get(`%\"${noticeTag}\"%`);
      if (existingNotice) {
        candidates.delete(seat);
        return;
      }

      const blocked = deps.db.prepare(
        "SELECT qitem_id AS id, substr(summary,1,100) AS summary FROM queue_items WHERE destination_session = ? AND state = 'blocked' ORDER BY ts_created DESC LIMIT 10",
      ).all(seat) as Array<{ id: string; summary: string | null }>;
      const completionIds = [...completions];
      const body = [
        `Automated empty-frontier cue for ${seat}; this is not a completion claim and does not create work.`,
        `The seat is idle after explicit no-follow-on closure(s): ${completionIds.join(", ")}.`,
        "There are no pending or in-progress queue items assigned to the seat.",
        blocked.length
          ? `Blocked obligations remain (not actionable):\n${blocked.map((item) => `- ${item.id}: ${item.summary ?? "(no summary)"}`).join("\n")}`
          : "No blocked obligations are currently recorded for the seat.",
        `Please review whether a concrete, non-overlapping next assignment exists; do not create filler.`,
      ].join("\n\n");

      notifying.add(seat);
      void Promise.resolve().then(() => deps.queueRepo.create({
        sourceSession,
        destinationSession: lead,
        priority: "routine",
        summary: `AUTO: empty work frontier for ${seat} (lead review, not completion)`,
        body,
        tags: [EMPTY_FRONTIER_NOTICE_TAG, noticeTag],
      })).then(() => {
        candidates.delete(seat);
      }).catch(() => {
        // Keep the candidate for a later queue/activity event. No timer or retry loop.
      }).finally(() => {
        notifying.delete(seat);
      });
    } catch {
      // Advisory monitoring must never affect queue or seat activity.
    }
  };

  // Queue closures and activity changes can arrive in the same committed event burst.
  // Defer one microtask so the current burst coalesces before the frontier is evaluated.
  const scheduleEvaluate = (seat: string): void => {
    if (scheduled.has(seat) || disposed) return;
    scheduled.add(seat);
    queueMicrotask(() => {
      scheduled.delete(seat);
      evaluate(seat);
    });
  };

  const unsubscribe = deps.eventBus.subscribe((rawEvent) => {
    const event = rawEvent as unknown as QueueNoticeEvent & { sessionName?: string };
    if (event.type === "seat.activity_changed") {
      if (event.sessionName) scheduleEvaluate(event.sessionName);
      return;
    }
    if (event.type !== "queue.updated" || !event.qitemId) return;

    try {
      const row = deps.db.prepare(
        "SELECT destination_session AS destination, tags FROM queue_items WHERE qitem_id = ?",
      ).get(event.qitemId) as { destination: string; tags: string | null } | undefined;
      if (!row?.destination) return;
      let tags: string[] = [];
      try { tags = JSON.parse(row.tags ?? "[]") as string[]; } catch { /* malformed legacy tags do not opt in */ }
      if (tags.includes(EMPTY_FRONTIER_NOTICE_TAG)) return;

      if (event.fromState === "in-progress" && event.toState === "done" && event.closureReason === "no-follow-on") {
        const ids = candidates.get(row.destination) ?? new Set<string>();
        ids.add(event.qitemId);
        candidates.set(row.destination, ids);
      }
      // A non-qualifying transition can still remove the last actionable blocker for
      // a previously recorded candidate, so re-evaluate only when one already exists.
      if (candidates.has(row.destination)) scheduleEvaluate(row.destination);
    } catch {
      // Best-effort observer; never affect the underlying queue transition.
    }
  });

  return () => {
    disposed = true;
    candidates.clear();
    scheduled.clear();
    unsubscribe();
  };
}
