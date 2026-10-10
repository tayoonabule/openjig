import type { Database } from "better-sqlite3";
import type { EventBus } from "./event-bus.js";
import type { QueueRepository } from "./queue-repository.js";

/**
 * A lead (`main-lead@<rig>`) that goes from working to idle after real work, without having sent
 * anything to the advisor in that stretch, gets an automatic "idle, status report missing" notice
 * queued to the advisor, with queue evidence. It never claims completion: only the lead's own
 * explicit DONE/BLOCKED/DECISION does. One open notice per seat; never for the advisor itself.
 *
 * Continuation rule: if the lead reported to the advisor in (or just before) the PREVIOUS stretch and
 * this stretch follows within RECHECK_MS, the notice is DEFERRED, not dropped. After RECHECK_MS the seat
 * is rechecked once: still idle and nothing sent since this stretch began -> the notice fires. If the
 * lead starts working again the deferral is cancelled and the new stretch is judged on its own. So a lead
 * that reports and then silently finishes is still surfaced, at most RECHECK_MS late.
 */
export const LEAD_NOTICE_TAG = "auto-completion-notice";
const MIN_WORK_MS = 120_000;
export const RECHECK_MS = 600_000;
// Startup recovery pages back through each lead's persisted activity events in pages of this size; it is
// bounded by logical state runs (final two stretches), never by wall-clock or a fixed event count.
const RECOVERY_PAGE = 200;
// After a restart the seat-state oracle may not be hydrated when a recovered recheck is due: retry briefly, then fall back to the persisted idle evidence.
const RECOVERY_HYDRATION_RETRIES = 4;
const RECOVERY_HYDRATION_RETRY_MS = 30_000;

interface SeatStateReader { getSeatStateBySession(name: string): { activity: string; seq: number } | null }

export function startLeadCompletionNotice(deps: {
  db: Database;
  eventBus: Pick<EventBus, "subscribe">;
  queueRepo: Pick<QueueRepository, "create">;
  seatActivity: SeatStateReader;
  /** Advisory content evidence (SeatActivityService.getContentChangedAtMs). Absent/null = no evidence = never suppress. */
  contentChangedAtMs?: (session: string) => number | null;
  advisor?: string;
  now?: () => Date;
  /** Test seams; default to an unref'd setTimeout. */
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}): () => void {
  const advisor = deps.advisor ?? "advisor-lead@kernel";
  const now = deps.now ?? (() => new Date());
  const schedule = deps.schedule ?? ((fn: () => void, ms: number) => {
    const h = setTimeout(fn, ms);
    (h as { unref?: () => void }).unref?.();
    return h;
  });
  const cancel = deps.cancel ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const workingSince = new Map<string, Date>();
  const prevStretch = new Map<string, { start: Date; end: Date }>();
  const deferred = new Map<string, unknown>();
  let disposed = false;

  const reportedSince = (seat: string, iso: string): boolean => !!(
    deps.db.prepare(
      "SELECT 1 FROM queue_items WHERE source_session = ? AND destination_session = ? AND ts_created >= ? LIMIT 1",
    ).get(seat, advisor, iso) ||
    deps.db.prepare(
      "SELECT 1 FROM outbox_entries WHERE sender_session = ? AND destination_session = ? AND ts_dispatched >= ? LIMIT 1",
    ).get(seat, advisor, iso)
  );

  // A stretch whose pane CONTENT last changed BEFORE the stretch began was repaint/timer chrome on a sampled seat,
  // not work (real work changes the pane at/after its start). Only the notice is suppressed; seat state is untouched.
  // No evidence (null), a first-ever observation, or a hook/self-report-decided seat never suppresses.
  const CHROME_MARGIN_MS = 2_000;
  const chromeOnly = (seat: string, sinceIso: string): boolean => {
    try {
      const at = deps.contentChangedAtMs?.(seat);
      if (at === null || at === undefined) return false;
      const st = deps.seatActivity.getSeatStateBySession(seat) as { decidedBy?: string | null } | null;
      if (st?.decidedBy !== "window-sampling") return false; // only an EXPLICIT window-sampling decision may suppress; null/unknown/hook fail open
      return at < Date.parse(sinceIso) - CHROME_MARGIN_MS;
    } catch { return false; }
  };

  const emit = (seat: string, sinceIso: string): void => {
    if (disposed) return;
    if (chromeOnly(seat, sinceIso)) return;
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
  };

  /**
   * Restart recovery (no second timer store). The pending recheck is derivable from persisted facts:
   * `agent.activity` running/idle events, and reports in queue_items/outbox_entries. On startup, for each
   * lead whose LAST persisted activity is idle, rebuild its final two stretches; if the final one was a
   * >=2 min unreported continuation of a reported stretch (gap < RECHECK_MS), re-arm the recheck for the
   * ORIGINAL deadline (idle_at + RECHECK_MS), or fire immediately if that deadline already passed.
   * Dedup (one open notice per seat) and the "still idle / nothing sent since" check are the same code path.
   */
  const recover = (): void => {
    try {
      const nowMs = now().getTime();
      // No time cutoff: take each lead's LAST few persisted activity events, however long the daemon was down.
      const seats = deps.db.prepare(
        "SELECT DISTINCT json_extract(payload,'$.sessionName') AS seat FROM events WHERE type = 'agent.activity' AND json_extract(payload,'$.sessionName') LIKE 'main-lead@%'",
      ).all() as Array<{ seat: string }>;
      // Per lead, page backwards through persisted events, COLLAPSING consecutive duplicate observations
      // (and ignoring 'unknown'), until the final two logical stretches (4 state runs) are in hand or history
      // is exhausted. No time cutoff and no fixed event count: duplicates cannot hide a boundary.
      const page = deps.db.prepare(
        "SELECT seq, created_at AS at, json_extract(payload,'$.activity.state') AS st FROM events WHERE type = 'agent.activity' AND json_extract(payload,'$.sessionName') = ? AND seq < ? ORDER BY seq DESC LIMIT ?",
      );
      const rows: Array<{ at: string; seat: string; st: string }> = [];
      for (const { seat } of seats) {
        const runs: Array<{ at: string; st: string }> = []; // newest first; at = EARLIEST event of the run
        let before = Number.MAX_SAFE_INTEGER;
        for (;;) {
          const batch = page.all(seat, before, RECOVERY_PAGE) as Array<{ seq: number; at: string; st: string }>;
          if (batch.length === 0) break;
          for (const r of batch) {
            if (r.st !== "running" && r.st !== "idle") continue;
            const top = runs[runs.length - 1];
            if (top && top.st === r.st) top.at = r.at;
            else runs.push({ at: r.at, st: r.st });
          }
          const oldest = batch[batch.length - 1];
          if (!oldest) break;
          before = oldest.seq;
          if (runs.length > 4 || batch.length < RECOVERY_PAGE) break; // >4: the 4th run is then certainly complete
        }
        for (const r of runs.slice(0, 4).reverse()) rows.push({ at: r.at, seat, st: r.st });
      }
      const bySeat = new Map<string, Array<{ start: Date; end: Date | null }>>();
      for (const r of rows) {
        if (r.seat === advisor) continue;
        const t = new Date(r.at.replace(" ", "T") + "Z");
        const list = bySeat.get(r.seat) ?? [];
        const last = list[list.length - 1];
        if (r.st === "running") { if (!last || last.end) list.push({ start: t, end: null }); }
        else if (r.st === "idle" && last && !last.end) last.end = t;
        bySeat.set(r.seat, list);
      }
      for (const [seat, list] of bySeat) {
        const cur = list[list.length - 1];
        if (!cur) continue;
        if (!cur.end) { if (!workingSince.has(seat)) workingSince.set(seat, cur.start); const p0 = list[list.length - 2]; if (p0 && p0.end) prevStretch.set(seat, { start: p0.start, end: p0.end }); continue; } // in flight: the live idle event decides, with the true start
        const prev = list[list.length - 2];
        prevStretch.set(seat, prev && prev.end ? { start: prev.start, end: prev.end } : { start: cur.start, end: cur.end });
        if (cur.end.getTime() - cur.start.getTime() < MIN_WORK_MS) continue;
        const sinceIso = cur.start.toISOString();
        if (reportedSince(seat, sinceIso)) continue;
        if (!(prev && prev.end && cur.start.getTime() - prev.end.getTime() < RECHECK_MS && reportedSince(seat, prev.start.toISOString()))) continue; // non-continuations already notified live
        const dueIn = Math.max(0, cur.end.getTime() + RECHECK_MS - nowMs);   // original deadline, never extended
        const arm = (attempt: number, ms: number): void => {
        deferred.set(seat, schedule(() => {
          deferred.delete(seat);
          try {
            if (disposed) return;
            const st = deps.seatActivity.getSeatStateBySession(seat);
            if (!st && attempt < RECOVERY_HYDRATION_RETRIES) { arm(attempt + 1, RECOVERY_HYDRATION_RETRY_MS); return; } // oracle not hydrated yet
            if (st && st.activity !== "idle-at-prompt") return;           // working again
            if (reportedSince(seat, sinceIso)) return;
            emit(seat, sinceIso);                                         // still no state after retries: persisted idle evidence stands
          } catch { /* never crash the daemon */ }
        }, ms));
        };
        arm(0, dueIn);
      }
    } catch { /* never crash the daemon */ }
  };
  recover();

  const unsubscribe = deps.eventBus.subscribe((event) => {
    const e = event as unknown as { type?: string; sessionName?: string };
    const seat = e.sessionName;
    if (e.type !== "seat.activity_changed" || !seat || !seat.startsWith("main-lead@") || seat === advisor) return;
    const state = deps.seatActivity.getSeatStateBySession(seat);
    if (!state) return;
    if (state.activity === "working") {
      const h = deferred.get(seat);
      if (h !== undefined) { cancel(h); deferred.delete(seat); } // it continued: that stretch is judged on its own
      if (!workingSince.has(seat)) workingSince.set(seat, now());
      return;
    }
    if (state.activity !== "idle-at-prompt") return;
    const since = workingSince.get(seat);
    workingSince.delete(seat);
    if (!since) return;
    const end = now();
    const prev = prevStretch.get(seat);
    prevStretch.set(seat, { start: since, end });
    if (end.getTime() - since.getTime() < MIN_WORK_MS) return;
    const sinceIso = since.toISOString();
    try {
      if (reportedSince(seat, sinceIso)) return; // reported inside this stretch
      // Continuation of a reported stretch: defer with a bounded recheck instead of dropping.
      if (prev && since.getTime() - prev.end.getTime() < RECHECK_MS && reportedSince(seat, prev.start.toISOString())) {
        const old = deferred.get(seat);
        if (old !== undefined) cancel(old);
        deferred.set(seat, schedule(() => {
          deferred.delete(seat);
          try {
            const st = deps.seatActivity.getSeatStateBySession(seat);
            if (!st || st.activity !== "idle-at-prompt") return; // working again: its own stretch decides
            if (reportedSince(seat, sinceIso)) return;
            emit(seat, sinceIso);
          } catch { /* never crash the daemon */ }
        }, RECHECK_MS));
        return;
      }
      emit(seat, sinceIso);
    } catch { /* never crash the daemon */ }
  });

  // Dispose: unsubscribe AND cancel every pending deferred/recovery timer; a disposed notice never queries or creates.
  return () => {
    disposed = true;
    for (const h of deferred.values()) { try { cancel(h); } catch { /* ignore */ } }
    deferred.clear();
    unsubscribe();
  };
}
