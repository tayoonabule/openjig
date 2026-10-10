// Sampled seats: tmux window_activity ticks on repaint/timer chrome with no transcript change.
import { describe, it, expect, vi } from "vitest";
import { SeatActivityService, CONTENT_FROZEN_IDLE_SECONDS } from "../src/domain/seat-activity-service.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

function rig(opts: { text: () => string | null | Error }) {
  let nowMs = Date.parse("2026-10-10T10:00:00.000Z");
  const tmux = {
    readPaneLastActivity: vi.fn(async () => Math.floor(nowMs / 1000) - 1), // ticks every second: always "active"
    capturePaneContent: vi.fn(async () => { const t = opts.text(); if (t instanceof Error) throw t; return t; }),
  } as unknown as TmuxAdapter;
  const svc = new SeatActivityService({ tmux, defaultWindowSeconds: 3, now: () => new Date(nowMs) });
  return { svc, tmux, advance: (s: number) => { nowMs += s * 1000; }, setLast: (fn: () => number) => { (tmux.readPaneLastActivity as any).mockImplementation(async () => fn()); }, nowSec: () => Math.floor(nowMs / 1000) };
}
const tick = async (r: ReturnType<typeof rig>, seconds: number) => { let last = null; for (let i = 0; i < seconds; i++) { r.advance(1); last = await r.svc.pollSeat("s@r"); } return last; };

describe("content-aware sampling", () => {
  it("unchanged ticking TUI: active at first, idle once content is frozen for the threshold, stays idle", async () => {
    const r = rig({ text: () => "static transcript\n> prompt\n" });
    const early = await tick(r, 5);
    expect(early!.isActiveWithinWindow).toBe(true); // not yet judged: short frozen time is still treated as active
    const late = await tick(r, CONTENT_FROZEN_IDLE_SECONDS);
    expect(late!.isActiveWithinWindow).toBe(false);
    expect((await tick(r, 20))!.isActiveWithinWindow).toBe(false);
  });
  it("a footer countdown/clock (digits only changing) is chrome: still goes idle", async () => {
    let n = 0;
    const r = rig({ text: () => `body\nnext scheduled task in 13h ${59 - (n++ % 60)}m | 12:${10 + (n % 40)}\n` });
    expect((await tick(r, CONTENT_FROZEN_IDLE_SECONDS + 5))!.isActiveWithinWindow).toBe(false);
  });
  it("real changed content keeps it active indefinitely and a change after idle flips back to active", async () => {
    let n = 0; let frozen = false;
    const r = rig({ text: () => (frozen ? "same" : `line ${"abcdefghij"[n % 10]}${String.fromCharCode(97 + (n++ >> 3) % 26)}x`) });
    expect((await tick(r, 120))!.isActiveWithinWindow).toBe(true);
    frozen = true;
    expect((await tick(r, 31 + 1))!.isActiveWithinWindow).toBe(false);
    frozen = false;
    expect((await tick(r, 1))!.isActiveWithinWindow).toBe(true);
  });
  it("missing or failed capture never invents idle: raw window reading stands", async () => {
    for (const t of [null, new Error("tmux gone")] as const) {
      const r = rig({ text: () => t });
      expect((await tick(r, 120))!.isActiveWithinWindow).toBe(true);
    }
  });
  it("a capture failure resets the baseline so a later success cannot compare against a stale one", async () => {
    let mode: "ok" | "fail" = "ok";
    const r = rig({ text: () => (mode === "ok" ? "same" : null) });
    await tick(r, 25); mode = "fail"; await tick(r, 20); mode = "ok";
    expect((await tick(r, 10))!.isActiveWithinWindow).toBe(true); // baseline restarted, 10s < threshold
  });
  it("genuine idle: window silent reads idle and resets the baseline (new activity judged fresh)", async () => {
    const r = rig({ text: () => "same" });
    await tick(r, 40);
    r.setLast(() => r.nowSec() - 60); // silent
    expect((await tick(r, 2))!.isActiveWithinWindow).toBe(false);
    r.setLast(() => r.nowSec() - 1); // activity resumes with same bytes: fresh baseline => active again
    expect((await tick(r, 2))!.isActiveWithinWindow).toBe(true);
  });
  it("adapters without capture support keep the raw reading (no regression for old seats)", async () => {
    let nowMs = Date.parse("2026-10-10T10:00:00.000Z");
    const tmux = { readPaneLastActivity: vi.fn(async () => Math.floor(nowMs / 1000) - 1) } as unknown as TmuxAdapter;
    const svc = new SeatActivityService({ tmux, defaultWindowSeconds: 3, now: () => new Date(nowMs) });
    for (let i = 0; i < 90; i++) { nowMs += 1000; }
    expect((await svc.pollSeat("s@r"))!.isActiveWithinWindow).toBe(true);
  });
  it("sweep: batched capture is read only for window-active seats, failed batch falls back to raw", async () => {
    const nowMs = Date.parse("2026-10-10T10:00:00.000Z");
    const tmux = {
      readPaneLastActivity: vi.fn(async () => null),
      readAllSessionWindowActivity: vi.fn(async () => new Map([["a@r", nowMs / 1000 - 1], ["b@r", nowMs / 1000 - 99]])),
      capturePanesContent: vi.fn(async () => { throw new Error("boom"); }),
    } as unknown as TmuxAdapter;
    const svc = new SeatActivityService({ tmux, defaultWindowSeconds: 3, now: () => new Date(nowMs) });
    const db: any = { prepare: () => ({ all: () => [
      { session_name: "a@r", node_id: "n1", runtime: "jcode", attachment_type: "tmux" },
      { session_name: "b@r", node_id: "n2", runtime: "jcode", attachment_type: "tmux" } ] }) };
    await svc.pollAllRunningTmuxSeats(db);
    expect((tmux.capturePanesContent as any).mock.calls[0][0]).toEqual(["a@r"]);
    expect(svc.getSeatActivity("a@r")!.isActiveWithinWindow).toBe(true);
    expect(svc.getSeatActivity("b@r")!.isActiveWithinWindow).toBe(false);
  });
  it("hook precedence: a fresh lifecycle-hooks 'working' still decides while the sampler reads frozen-idle; hook idle is not overridden by ticking chrome", async () => {
    const r = rig({ text: () => "same" });
    const SEAT = "seat-1";
    r.svc.declareRungInventory({ seatNodeId: SEAT, sessionName: "s@r" }, { adapterId: "a", runtime: "claude-code", rungs: [
      { rung: "lifecycle-hooks", lifecycleCoverage: "full", initialTrust: "authoritative" },
      { rung: "window-sampling", lifecycleCoverage: "full", initialTrust: "authoritative" } ] } as any);
    const at = () => new Date(Date.parse("2026-10-10T10:00:00.000Z") + 0).toISOString();
    await tick(r, CONTENT_FROZEN_IDLE_SECONDS + 5); // sampler now says idle
    const nowIso = () => new Date(Date.parse("2026-10-10T10:00:00.000Z") + (CONTENT_FROZEN_IDLE_SECONDS + 5) * 1000).toISOString();
    r.svc.reportEvidence({ seatNodeId: SEAT, sessionName: "s@r", rung: "lifecycle-hooks", sourceId: "h", seq: 1, observedAt: nowIso(), activity: "working" });
    await tick(r, 1);
    expect(r.svc.getSeatState(SEAT)!.activity).toBe("working");
    expect(r.svc.getSeatState(SEAT)!.decidedBy).toBe("lifecycle-hooks");
    void at;
  });
});
