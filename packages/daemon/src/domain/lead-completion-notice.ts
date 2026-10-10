import type { Database } from "better-sqlite3";
import type { EventBus } from "./event-bus.js";
import type { QueueRepository } from "./queue-repository.js";

/**
 * A lead (`main-lead@<rig>`) that goes from working to idle after real work, without having sent
 * anything to the advisor in that stretch, gets an automatic "idle, status report missing" notice
 * queued to the advisor, with queue evidence. It never claims completion: only the lead's own
 * explicit DONE/BLOCKED/DECISION does. One open notice per seat; never for the advisor itself.
 */
export const LEAD_NOTICE_TAG = "auto-completion-notice";
const MIN_WORK_MS = 120_000;

interface SeatStateReader { getSeatStateBySession(name: string): { activity: string; seq: number } | null }

export function startLeadCompletionNotice(deps: {
  db: Database;
  eventBus: Pick<EventBus, "subscribe">;
  queueRepo: Pick<QueueRepository, "create">;
  seatActivity: SeatStateReader;
  advisor?: string;
  now?: () => Date;
}): () => void {
  const advisor = deps.advisor ?? "advisor-lead@kernel";
  const now = deps.now ?? (() => new Date());
  const workingSince = new Map<string, Date>();
  return deps.eventBus.subscribe((event) => {
    const e = event as unknown as { type?: string; sessionName?: string };
    const seat = e.sessionName;
    if (e.type !== "seat.activity_changed" || !seat || !seat.startsWith("main-lead@") || seat === advisor) return;
    const state = deps.seatActivity.getSeatStateBySession(seat);
    if (!state) return;
    if (state.activity === "working") { if (!workingSince.has(seat)) workingSince.set(seat, now()); return; }
    if (state.activity !== "idle-at-prompt") return;
    const since = workingSince.get(seat);
    workingSince.delete(seat);
    if (!since || now().getTime() - since.getTime() < MIN_WORK_MS) return;
    const sinceIso = since.toISOString();
    try {
      const sent = deps.db.prepare(
        "SELECT 1 FROM queue_items WHERE source_session = ? AND destination_session = ? AND ts_created >= ? LIMIT 1",
      ).get(seat, advisor, sinceIso) || deps.db.prepare(
        "SELECT 1 FROM outbox_entries WHERE sender_session = ? AND destination_session = ? AND ts_dispatched >= ? LIMIT 1",
      ).get(seat, advisor, sinceIso);
      if (sent) return;
      // Debounce: one open notice per seat at a time.
      const open = deps.db.prepare(
        "SELECT 1 FROM queue_items WHERE state IN ('pending','in-progress','blocked') AND tags LIKE ? LIMIT 1",
      ).get(`%"${LEAD_NOTICE_TAG}:${seat}"%`);
      if (open) return;
      // Evidence only. Idle is NOT completion: the lead may be blocked, waiting on a peer, or need a decision.
      const held = deps.db.prepare(
        "SELECT state, destination_session, substr(summary,1,80) AS s FROM queue_items WHERE (destination_session = ? AND state IN ('pending','in-progress','blocked')) OR (source_session = ? AND state IN ('pending','in-progress','blocked') AND destination_session <> ?) ORDER BY ts_created DESC LIMIT 5",
      ).all(seat, seat, advisor) as Array<{ state: string; destination_session: string; s: string | null }>;
      const evidence = held.length
        ? held.map((h) => `- ${h.state} -> ${h.destination_session}: ${h.s ?? ""}`).join("\n")
        : "- no open queue items found for this lead";
      // Source is the advisor (a self-notice, the recovery-item precedent), never the lead:
      // the lead did not author this and it must not read as a lead-authored completion.
      void deps.queueRepo.create({
        sourceSession: advisor,
        destinationSession: advisor,
        summary: `AUTO: ${seat} idle, status report missing (not a completion)`,
        body:
          `Automatic harness notice, NOT written by ${seat} and NOT a DONE.\n` +
          `${seat} worked from ${sinceIso} to ${now().toISOString()}, is now idle, and sent you no queue item or message in that time. ` +
          `Idle can mean done, blocked, waiting on a peer, or needing a decision.\n` +
          `Open items involving the lead:\n${evidence}\n` +
          `The outcome needs the lead's own explicit DONE, BLOCKED or DECISION: rig send ${seat} 'report DONE, BLOCKED or DECISION with evidence'`,
        tags: [LEAD_NOTICE_TAG, `${LEAD_NOTICE_TAG}:${seat}`],
      }).catch(() => { /* a notice failure never affects the seat */ });
    } catch { /* never crash the daemon */ }
  });
}
