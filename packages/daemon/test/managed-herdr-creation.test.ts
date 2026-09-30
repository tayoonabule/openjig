import { describe, expect, it } from "vitest";
import { ManagedHerdrViews, type ObserverSeat, type ManagedHerdrViewsDeps } from "../src/domain/terminal/managed-herdr-views.js";

function nativeFixture() {
  const seat = (id: string): ObserverSeat => ({ nodeId: id, occupant: id + "-generation", target: id + "@proof", label: id, runtime: "terminal", life: "running" });
  let seats = [seat("lead")];
  let next = 0;
  const panes: any[] = [], tabs: any[] = [];
  const calls: any[] = [], bindings: string[] = [];
  let state: any = { version: 1, rigs: {} };
  let current = true, observed = true, moveOutcome = "move", fault: ((method: string, params: any) => void) | undefined;
  const request = async (method: string, params: any): Promise<any> => {
    calls.push({ method, params }); fault?.(method, params);
    if (method === "workspace.list") return { workspaces: [{ workspace_id: "w", label: "proof", active_tab_id: "human-tab", focused: true }] };
    if (method === "tab.list") return { tabs: [...tabs] };
    if (method === "pane.list") return { panes: panes.map(p => ({ ...p })) };
    if (method === "layout.apply") {
      const tabId = "tab" + ++next; tabs.push({ tab_id: tabId, label: params.tab_label });
      const leaves: any[] = [];
      const visit = (n: any) => { if (n.type === "pane") leaves.push(n); else { visit(n.first); visit(n.second); } };
      visit(params.root);
      const root: any = { ...params.root };
      const assign = (n: any) => {
        if (n.type === "pane") {
          const id = ++next, pane_id = "pane" + id;
          panes.push({ pane_id, terminal_id: "term" + id, tab_id: tabId, argv: n.command, pid: id }); n.pane_id = pane_id;
        } else { n.first = { ...n.first }; n.second = { ...n.second }; assign(n.first); assign(n.second); }
      };
      assign(root); return { layout: { tab_id: tabId, root } };
    }
    if (method === "pane.process_info") {
      const p = panes.find(p => p.pane_id === params.pane_id);
      return { process_info: { shell_pid: p?.pid, foreground_processes: observed && p ? [{ pid: p.pid, argv: p.argv }] : [] } };
    }
    if (method === "pane.move") {
      const p = panes.find(p => p.pane_id === params.pane_id);
      if (moveOutcome === "no-op") return { move_result: { changed: false, reason: "zoomed", pane: { ...p } } };
      const oldTab = p.tab_id; p.tab_id = params.destination.tab_id;
      tabs.splice(tabs.findIndex(t => t.tab_id === oldTab), 1);
      if (moveOutcome === "lost-response") throw new Error("response lost after real move");
      return { move_result: { changed: true, pane: { ...p } } };
    }
    throw new Error("Unexpected mutation: " + method);
  };
  const deps: ManagedHerdrViewsDeps = {
    transport: { request }, listRigs: async () => [{ id: "rig", name: "proof", seats }],
    listClients: async () => panes.filter(p => p.argv?.[0] === "tmux").map(p => ({ pid: p.pid, target: p.argv[5], readOnly: true, ignoreSize: true })),
    load: () => state, save: s => { state = structuredClone(s); }, isCurrent: () => current,
    bind: (_, id) => bindings.push(id),
  };
  return { deps, views: new ManagedHerdrViews(deps), panes, tabs, calls, bindings, state: () => state,
    add: () => { seats.push(seat("helper")); }, current: (v: boolean) => { current = v; }, observed: (v: boolean) => { observed = v; },
    move: (v: string) => { moveOutcome = v; }, fault: (f: typeof fault) => { fault = f; } };
}

describe("direct-argv additive observer creation", () => {
  it("creates direct readonly commands, moves only the new pane and never sends input", async () => {
    const f = nativeFixture(); await f.views.reconcile(); const original = f.panes[0].pane_id;
    f.add(); await f.views.reconcile();
    expect(f.panes).toHaveLength(2); expect(f.panes[0].pane_id).toBe(original);
    expect(f.panes[1].tab_id).toBe(f.panes[0].tab_id);
    expect(f.calls.find(c => c.method === "pane.move")?.params).toMatchObject({ pane_id: f.panes[1].pane_id, focus: false });
    expect(f.calls.some(c => ["pane.split", "pane.rename", "pane.send_input"].includes(c.method))).toBe(false);
  });
  it("does not bind an unverified first-page attach", async () => {
    const f = nativeFixture(); f.observed(false); await f.views.reconcile();
    expect(f.bindings).toEqual([]); expect(f.panes).toHaveLength(1);
  });
  it("native changed:false retains separate verified view rather than claiming a move", async () => {
    const f = nativeFixture(); await f.views.reconcile(); f.add(); f.move("no-op"); await f.views.reconcile();
    expect(f.panes[1].tab_id).not.toBe(f.panes[0].tab_id);
    expect(f.views.status().rig).toContain("zoomed");
  });
  it("recovers a completed move with a lost response without duplicates or human-drift permission", async () => {
    const f = nativeFixture(); await f.views.reconcile(); f.add(); f.move("lost-response"); await f.views.reconcile();
    expect(f.state().rigs.rig.panes[1].movingToTab).toBe(f.panes[0].tab_id);
    await f.views.dispose(); const recovered = new ManagedHerdrViews(f.deps); await recovered.reconcile();
    expect(f.panes).toHaveLength(2); expect(f.state().rigs.rig.panes[1].movingToTab).toBeUndefined();
    expect(f.calls.filter(c => c.method === "pane.move")).toHaveLength(1);
  });
  it("seat changed during staging cannot authorize move or bridge binding", async () => {
    const f = nativeFixture(); await f.views.reconcile(); f.add(); f.bindings.length = 0;
    f.fault((method) => { if (method === "layout.apply") f.current(false); }); await f.views.reconcile();
    expect(f.calls.some(c => c.method === "pane.move")).toBe(false);
    expect(f.bindings.filter(id => id === f.panes[1].pane_id)).toEqual([]);
  });
  it("terminal replacement after attach observation prevents move", async () => {
    const f = nativeFixture(); await f.views.reconcile(); f.add();
    let observedNew = false;
    f.fault((method, params) => {
      if (method === "pane.process_info" && f.panes[1]?.pane_id === params.pane_id) observedNew = true;
      if (method === "pane.list" && observedNew) f.panes[1].terminal_id = "human-terminal";
    });
    await f.views.reconcile(); expect(f.calls.some(c => c.method === "pane.move")).toBe(false);
  });
});
