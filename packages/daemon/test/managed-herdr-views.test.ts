import { describe, expect, it } from "vitest";
import { ManagedHerdrViews, type ObserverSeat, readonlyAttachTarget } from "../src/domain/terminal/managed-herdr-views.js";

function fixture() {
  let seats: ObserverSeat[] = [{ nodeId: "lead", target: "lead@rig", label: "lead", life: "running" }];
  let workspace = false, next = 0, current = true;
  const tabs: any[] = [], panes: any[] = [], calls: any[] = [];
  const human = { pane_id: "human", terminal_id: "human-terminal", tab_id: "mission-control" };
  const request = async (method: string, params: any): Promise<any> => {
    calls.push({ method, params });
    if (method === "workspace.list") return { workspaces: workspace ? [{ workspace_id: "w", label: "rig" }] : [] };
    if (method === "workspace.create") { workspace = true; return { workspace: { workspace_id: "w", label: "rig" } }; }
    if (method === "tab.list") return { tabs: tabs.map(t => ({ ...t })) };
    if (method === "pane.list") return { panes: [human, ...panes].map(p => ({ ...p })) };
    if (method === "pane.process_info") {
      const p = panes.find(p => p.pane_id === params.pane_id);
      return { process_info: { shell_pid: p.pid, foreground_processes: p.argv ? [{ pid: p.pid, argv: p.argv }] : [] } };
    }
    if (method === "layout.apply") {
      if (params.tab_id) { tabs.splice(tabs.findIndex(t => t.tab_id === params.tab_id), 1); panes.splice(0); }
      const tab = "tab" + ++next; tabs.push({ tab_id: tab, label: params.tab_label });
      const visit = (node: any) => {
        if (node.type !== "pane") { visit(node.first); visit(node.second); return; }
        const id = ++next, argv = node.command[0] === "sh" ? ["sleep", "2147483647"] : node.command;
        panes.push({ pane_id: "pane" + id, terminal_id: "terminal" + id, tab_id: tab, argv, pid: id });
      };
      visit(params.root); return { layout: { tab_id: tab } };
    }
    throw new Error("Forbidden mutation: " + method);
  };
  const deps = { transport: { request }, listRigs: async () => [{ id: "rig", name: "rig", seats }],
    listClients: async () => panes.filter(p => p.argv?.[0] === "tmux").map(p => ({ pid: p.pid, target: p.argv[5], readOnly: true, ignoreSize: true })),
    isCurrent: () => current };
  return { views: new ManagedHerdrViews(deps), deps, panes, tabs, calls, human,
    setSeats: (value: ObserverSeat[]) => { seats = value; }, setCurrent: (value: boolean) => { current = value; } };
}

describe("automatic read-only rig views", () => {
  it("creates a rig workspace and exactly one seats tab with direct read-only panes", async () => {
    const f = fixture(); await f.views.reconcile();
    expect(f.tabs).toHaveLength(1); expect(f.tabs[0].label).toBe("seats");
    expect(f.panes[0].argv).toEqual(["tmux", "attach", "-r", "-E", "-t", "lead@rig"]);
    expect(f.calls.find(c => c.method === "workspace.create").params.focus).toBe(false);
  });
  it("adds and removes running seats by replacing only the disposable view tab", async () => {
    const f = fixture(); await f.views.reconcile();
    f.setSeats([{ nodeId: "lead", target: "lead@rig", label: "lead", life: "running" }, { nodeId: "helper", target: "helper@rig", label: "helper", life: "running" }]);
    await f.views.reconcile(); expect(f.panes).toHaveLength(2); expect(f.tabs).toHaveLength(1);
    f.setSeats([]); await f.views.reconcile(); expect(f.tabs).toHaveLength(1); expect(f.panes[0].argv).toEqual(["sleep", "2147483647"]);
    expect(f.human).toEqual({ pane_id: "human", terminal_id: "human-terminal", tab_id: "mission-control" });
    expect(f.calls.filter(c => !["workspace.create", "layout.apply", "pane.process_info"].includes(c.method) && !c.method.endsWith(".list"))).toEqual([]);
    expect(f.calls.filter(c => c.method === "layout.apply").every(c => c.params.focus === false)).toBe(true);
  });
  it("leaves matching views untouched across controller restart and unknown status", async () => {
    const f = fixture(); await f.views.reconcile(); const original = structuredClone(f.panes);
    await f.views.dispose(); const restarted = new ManagedHerdrViews(f.deps);
    f.setSeats([{ nodeId: "lead", target: "lead@rig", label: "lead", life: "unknown" }]);
    await restarted.reconcile(); expect(f.panes).toEqual(original);
    expect(f.calls.filter(c => c.method === "layout.apply")).toHaveLength(1);
  });
  it.each([null, ["tmux", "attach", "-t", "lead@rig"]])("never replaces unverified or interactive panes (%j)", async argv => {
    const f = fixture(); await f.views.reconcile(); f.panes[0].argv = argv; f.setSeats([]);
    await f.views.reconcile(); expect(f.calls.filter(c => c.method === "layout.apply")).toHaveLength(1);
    expect(readonlyAttachTarget(argv)).toBeNull();
  });
  it("never replaces a changed terminal or acts on a stale seat observation", async () => {
    const f = fixture(); await f.views.reconcile(); const request = f.deps.transport.request;
    f.deps.transport.request = async (method, params) => {
      const result = await request(method, params);
      if (method === "pane.process_info") f.panes[0].terminal_id = "human-replacement";
      return result;
    };
    f.setSeats([]); await f.views.reconcile(); expect(f.calls.filter(c => c.method === "layout.apply")).toHaveLength(1);
    f.setCurrent(false); f.setSeats([{ nodeId: "helper", target: "helper@rig", label: "helper", life: "running" }]);
    await f.views.reconcile(); expect(f.calls.filter(c => c.method === "layout.apply")).toHaveLength(1);
  });
});
