import { describe, expect, it } from "vitest";
import { observerGrid, readonlyAttachTarget, ManagedHerdrViews } from "../src/domain/terminal/managed-herdr-views.js";
import type { HerdrResult } from "../src/domain/terminal/herdr-transport.js";

const seat = (id = "node", life: "running" | "absent" | "unknown" = "running") => ({ nodeId: id, occupant: "occupant-1", target: `${id}@rig`, label: id, runtime: "jcode", life });
function fixture() {
  const calls: Array<{ method: string; params: any }> = [];
  const panes: any[] = [{ pane_id: "w:p1", terminal_id: "term1", tab_id: "w:t2", label: "node" }];
  let seats = [seat()];
  const saved: any = { version: 1, rigs: {} };
  const request = async (method: string, params: any): Promise<HerdrResult> => {
    calls.push({ method, params });
    switch (method) {
      case "workspace.list": return { type: "workspace_list", workspaces: [{ workspace_id: "w", label: "rig" }] };
      case "tab.list": return { type: "tab_list", tabs: [{ tab_id: "w:t2", label: "seats" }] };
      case "pane.list": return { type: "pane_list", panes: [...panes] };
      case "pane.process_info": return { type: "pane_process_info", process_info: { foreground_processes: [{ pid: 123, argv: ["tmux", "attach", "-r", "-t", "node@rig"] }] } };
      case "pane.close": panes.splice(panes.findIndex(p => p.pane_id === params.pane_id), 1); return { type: "ok" };
      default: return { type: "ok" };
    }
  };
  const views = new ManagedHerdrViews({ transport: { request }, listRigs: async () => [{ id: "rig-id", name: "rig", seats }], listClients: async () => [{ pid: 123, target: "node@rig", readOnly: true, ignoreSize: true }], load: () => saved, save: state => Object.assign(saved, structuredClone(state)), adoptionRigNames: new Set(["rig"]) });
  return { calls, panes, views, saved, setSeats: (value: typeof seats) => { seats = value; } };
}

describe("passive managed Herdr views", () => {
  it("uses direct readonly, environment-safe attaches and no filler agent panes", () => {
    const root = observerGrid(Array.from({ length: 5 }, (_, i) => seat(String(i))));
    const leaves: any[] = [];
    const visit = (n: any) => { if (n.type === "pane") leaves.push(n); else { visit(n.first); visit(n.second); } };
    visit(root);
    expect(leaves).toHaveLength(5);
    expect(root).toMatchObject({ type: "split", direction: "right", ratio: 0.5 });
    expect(leaves[0].command).toEqual(["tmux", "attach", "-r", "-E", "-t", "0@rig"]);
  });
  it("never treats an interactive attach or a substring target as read-only authority", () => {
    expect(readonlyAttachTarget(["tmux", "attach", "-t", "node@rig"])).toBeNull();
    expect(readonlyAttachTarget(["sh", "-c", "tmux attach -r -t node@rig"])).toBeNull();
    expect(readonlyAttachTarget(["tmux", "attach", "-r", "-E", "-t", "node@rig"])).toBe("node@rig");
  });
  it("adopts verified readonly panes and keeps unchanged layouts completely untouched", async () => {
    const f = fixture();
    await f.views.reconcile();
    await f.views.reconcile();
    expect(f.saved.rigs["rig-id"].panes[0]).toMatchObject({ paneId: "w:p1", terminalId: "term1", target: "node@rig" });
    expect(f.calls.filter(c => !c.method.endsWith(".list") && c.method !== "pane.process_info")).toEqual([]);
  });
  it("unknown liveness never authorizes observer deletion", async () => {
    const f = fixture(); await f.views.reconcile(); f.setSeats([seat("node", "unknown")]); await f.views.reconcile();
    expect(f.calls.some(c => c.method === "pane.close")).toBe(false);
  });
  it("terminal identity drift prevents closing a human-replaced pane", async () => {
    const f = fixture(); await f.views.reconcile(); f.panes[0].terminal_id = "human-new-terminal";
    f.setSeats([seat("node", "absent")]); await f.views.reconcile();
    expect(f.calls.some(c => c.method === "pane.close")).toBe(false);
  });
  it("does not adopt matching labels without the actual client read-only flags", async () => {
    const f = fixture(); (f.views as any).deps.listClients = async () => [{ pid: 123, target: "node@rig", readOnly: false, ignoreSize: true }];
    await f.views.reconcile(); expect(f.saved.rigs["rig-id"]).toBeUndefined();
    expect(f.views.status()["rig-id"]).toContain("unowned");
  });
  it("serializes/coalesces overlapping sweeps and stops future work on dispose", async () => {
    const f = fixture(); await Promise.all([f.views.reconcile(), f.views.reconcile()]);
    await f.views.dispose(); const count = f.calls.length; await f.views.reconcile(); expect(f.calls).toHaveLength(count);
  });
  it.each([undefined, []])("never treats missing/empty foreground evidence as exit (%j)", async foreground => {
    const f = fixture(); await f.views.reconcile();
    const deps = (f.views as any).deps;
    const request = deps.transport.request;
    deps.transport.request = async (method: string, params: any) => method === "pane.process_info"
      ? { type: "pane_process_info", process_info: { foreground_processes: foreground } }
      : request(method, params);
    f.setSeats([]); await f.views.reconcile();
    expect(f.calls.some(c => c.method === "pane.close")).toBe(false);
    expect(f.saved.rigs["rig-id"].panes).toHaveLength(1);
  });
  it("rechecks terminal identity after process observation before close", async () => {
    const f = fixture(); await f.views.reconcile();
    const deps = (f.views as any).deps, request = deps.transport.request;
    deps.transport.request = async (method: string, params: any) => {
      const result = await request(method, params);
      if (method === "pane.process_info") f.panes[0].terminal_id = "replacement-after-await";
      return result;
    };
    f.setSeats([]); await f.views.reconcile();
    expect(f.calls.some(c => c.method === "pane.close")).toBe(false);
  });
  it("rechecks occupant after process observation before metadata binding", async () => {
    const f = fixture(); await f.views.reconcile();
    const deps = (f.views as any).deps, request = deps.transport.request;
    let current = true, bound = 0;
    deps.isCurrent = () => current; deps.bind = () => bound++;
    deps.transport.request = async (method: string, params: any) => {
      const result = await request(method, params);
      if (method === "pane.process_info") current = false;
      return result;
    };
    await f.views.reconcile(); expect(bound).toBe(0);
    expect(f.views.status()["rig-id"]).toContain("seat changed");
  });
  it("malformed native workspace inventory is not absence authority", async () => {
    const f = fixture(); await f.views.reconcile();
    const deps = (f.views as any).deps, request = deps.transport.request;
    deps.transport.request = async (method: string, params: any) => method === "workspace.list" ? { type: "workspace_list" } : request(method, params);
    await f.views.reconcile();
    expect(f.saved.rigs["rig-id"].panes).toHaveLength(1);
    expect(f.views.status().transport).toContain("malformed");
    expect(f.calls.some(c => c.method === "pane.close")).toBe(false);
  });
  it("positive direct exec exit is required and shell PID replacement is retained", async () => {
    const f = fixture();
    const deps = (f.views as any).deps, request = deps.transport.request;
    let exited = false;
    deps.processExited = () => exited;
    deps.transport.request = async (method: string, params: any) => {
      const result = await request(method, params);
      if (method === "pane.process_info") result.process_info.shell_pid = exited ? 999 : 123;
      return result;
    };
    await f.views.reconcile(); await f.views.reconcile();
    expect(f.saved.rigs["rig-id"].panes[0].directAttachPid).toBe(123);
    exited = true;
    deps.listClients = async () => [];
    f.setSeats([]); await f.views.reconcile();
    expect(f.calls.some(c => c.method === "pane.close")).toBe(false);
  });
});
