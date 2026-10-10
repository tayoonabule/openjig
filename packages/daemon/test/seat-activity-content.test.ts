// Content evidence is ADVISORY: the oracle's activity stays the raw window reading (watchdogs / quiet-window /
// restart safety see exactly what they always saw). getContentChangedAtMs() only feeds the lead-idle NOTICE.
import { describe, it, expect, vi } from "vitest";
import { SeatActivityService } from "../src/domain/seat-activity-service.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

const T0 = Date.parse("2026-10-10T10:00:00.000Z");
function rig(text: () => string | null | Error) {
  let nowMs = T0;
  const tmux = {
    readPaneLastActivity: vi.fn(async () => Math.floor(nowMs / 1000) - 1),
    capturePaneContent: vi.fn(async () => { const t = text(); if (t instanceof Error) throw t; return t; }),
  } as unknown as TmuxAdapter;
  const svc = new SeatActivityService({ tmux, defaultWindowSeconds: 3, now: () => new Date(nowMs) });
  return { svc, tmux, nowSec: () => Math.floor(nowMs / 1000), advance: (s: number) => { nowMs += s * 1000; },
    setLast: (fn: () => number | null) => { (tmux.readPaneLastActivity as any).mockImplementation(async () => fn()); } };
}
const tick = async (r: ReturnType<typeof rig>, n: number) => { let last = null; for (let i = 0; i < n; i++) { r.advance(1); last = await r.svc.pollSeat("s@r"); } return last; };

describe("content evidence (advisory)", () => {
  it("frozen ticking TUI: oracle activity STAYS active (a frozen pane never certifies idle); changed-time stays at first sight", async () => {
    const r = rig(() => "static\n> prompt\n");
    await tick(r, 1); const first = r.svc.getContentChangedAtMs("s@r");
    expect(first).not.toBeNull();
    expect((await tick(r, 120))!.isActiveWithinWindow).toBe(true);
    expect(r.svc.getContentChangedAtMs("s@r")).toBe(first);
  });
  it("footer countdown/clock (digits only) does not advance the changed-time", async () => {
    let n = 0;
    const r = rig(() => `body\nnext task in 13h ${59 - (n++ % 60)}m | 12:${10 + (n % 40)}\n`);
    await tick(r, 1); const first = r.svc.getContentChangedAtMs("s@r");
    expect((await tick(r, 90))!.isActiveWithinWindow).toBe(true);
    expect(r.svc.getContentChangedAtMs("s@r")).toBe(first);
  });
  it("real content change advances the changed-time; activity stays active", async () => {
    let n = 0;
    const r = rig(() => `line ${"abcdefghij"[n % 10]}${String.fromCharCode(97 + (n++ >> 3) % 26)}x`);
    await tick(r, 1); const first = r.svc.getContentChangedAtMs("s@r")!;
    expect((await tick(r, 60))!.isActiveWithinWindow).toBe(true);
    expect(r.svc.getContentChangedAtMs("s@r")!).toBeGreaterThan(first);
  });
  it("missing/failed capture: raw reading stands and NO evidence is exposed (notice never suppresses)", async () => {
    for (const t of [null, new Error("tmux gone")] as const) {
      const r = rig(() => t);
      expect((await tick(r, 60))!.isActiveWithinWindow).toBe(true);
      expect(r.svc.getContentChangedAtMs("s@r")).toBeNull();
    }
  });
  it("capture failure drops the baseline; later success starts fresh", async () => {
    let ok = true; const r = rig(() => (ok ? "same" : null));
    await tick(r, 10); ok = false; await tick(r, 5);
    expect(r.svc.getContentChangedAtMs("s@r")).toBeNull();
    ok = true; await tick(r, 1);
    expect(r.svc.getContentChangedAtMs("s@r")).toBe(T0 + 16_000);
  });
  it("genuine silence reads idle (raw) and resumed activity reads active", async () => {
    const r = rig(() => "same");
    await tick(r, 10);
    r.setLast(() => r.nowSec() - 60);
    expect((await tick(r, 2))!.isActiveWithinWindow).toBe(false);
    r.setLast(() => r.nowSec() - 1);
    expect((await tick(r, 2))!.isActiveWithinWindow).toBe(true);
  });
  it("timestamp outage clears the baseline", async () => {
    const r = rig(() => "same"); await tick(r, 5);
    r.setLast(() => null);
    expect(await tick(r, 10)).toBeNull();
    expect(r.svc.getContentChangedAtMs("s@r")).toBeNull();
  });
  it("adapters without capture support: raw reading, no evidence", async () => {
    const tmux = { readPaneLastActivity: vi.fn(async () => T0 / 1000 - 1) } as unknown as TmuxAdapter;
    const svc = new SeatActivityService({ tmux, defaultWindowSeconds: 3, now: () => new Date(T0) });
    expect((await svc.pollSeat("s@r"))!.isActiveWithinWindow).toBe(true);
    expect(svc.getContentChangedAtMs("s@r")).toBeNull();
  });
  const db: any = { prepare: () => ({ all: () => [{ session_name: "a@r", node_id: "n1", runtime: "jcode", attachment_type: "tmux" }] }) };
  it("sweep: failed batch falls back to per-target capture; partial omission also falls back", async () => {
    for (const batchFn of [async () => { throw new Error("boom"); }, async () => new Map()]) {
      const tmux = {
        readPaneLastActivity: vi.fn(async () => null),
        readAllSessionWindowActivity: vi.fn(async () => new Map([["a@r", T0 / 1000 - 1]])),
        capturePanesContent: vi.fn(batchFn),
        capturePaneContent: vi.fn(async () => "x"),
      } as unknown as TmuxAdapter;
      const svc = new SeatActivityService({ tmux, defaultWindowSeconds: 3, now: () => new Date(T0) });
      await svc.pollAllRunningTmuxSeats(db);
      expect((tmux.capturePaneContent as any).mock.calls.length).toBe(1);
      expect(svc.getSeatActivity("a@r")!.isActiveWithinWindow).toBe(true);
    }
  });
  it("hook precedence unchanged: fresh lifecycle-hooks working decides over window-sampling", async () => {
    const r = rig(() => "same");
    r.svc.declareRungInventory({ seatNodeId: "seat-1", sessionName: "s@r" }, { adapterId: "a", runtime: "claude-code", rungs: [
      { rung: "lifecycle-hooks", lifecycleCoverage: "full", initialTrust: "authoritative" },
      { rung: "window-sampling", lifecycleCoverage: "full", initialTrust: "authoritative" } ] } as any);
    await tick(r, 35);
    r.svc.reportEvidence({ seatNodeId: "seat-1", sessionName: "s@r", rung: "lifecycle-hooks", sourceId: "h", seq: 1, observedAt: new Date(T0 + 35_000).toISOString(), activity: "working" });
    await tick(r, 1);
    expect(r.svc.getSeatState("seat-1")!.activity).toBe("working");
    expect(r.svc.getSeatState("seat-1")!.decidedBy).toBe("lifecycle-hooks");
  });
});
