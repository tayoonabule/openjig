import { describe, expect, it } from "vitest";
import { ManagedHerdrViews, observerAttach, type ObserverSeat } from "../src/domain/terminal/managed-herdr-views.js";

function fixture() {
  let seats: ObserverSeat[] = [{ nodeId: "lead", target: "lead@rig", label: "lead", writable: true, life: "running", lead: true }];
  let workspace = false, next = 0, current = true;
  const tabs: any[] = [], panes: any[] = [], calls: any[] = [];
  const human = { pane_id: "human", terminal_id: "human-terminal", tab_id: "mission-control" };
  const request = async (method: string, params: any): Promise<any> => {
    calls.push({ method, params });
    if (method === "workspace.list") return { workspaces: workspace ? [{ workspace_id: "w", label: "rig", focused: true }] : [] };
    if (method === "workspace.create") { workspace = true; return { workspace: { workspace_id: "w", label: "rig" } }; }
    if (method === "tab.list") return { tabs: tabs.map(t => ({ ...t })) };
    if (method === "pane.list") return { panes: [human, ...panes].map(p => ({ ...p })) };
    if (method === "pane.process_info") {
      const p = panes.find(p => p.pane_id === params.pane_id);
      return { process_info: { shell_pid: p.pid, foreground_processes: p.argv ? [{ pid: p.pid, argv: p.argv }] : [] } };
    }
    if (method === "tab.focus") return { ok: true };
    if (method === "tab.close") { tabs.splice(tabs.findIndex(t => t.tab_id === params.tab_id), 1); for (let i = panes.length - 1; i >= 0; i--) if (panes[i].tab_id === params.tab_id) panes.splice(i, 1); return { ok: true }; }
    if (method === "workspace.close") { workspace = false; return { ok: true }; }
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
    listClients: async () => panes.filter(p => p.argv?.[0] === "tmux").map(p => ({ pid: p.pid, target: p.argv[p.argv.indexOf("-t") + 1], readOnly: p.argv.includes("-r"), ignoreSize: true })),
    isCurrent: () => current };
  return { views: new ManagedHerdrViews(deps), deps, panes, tabs, calls, human,
    setSeats: (value: ObserverSeat[]) => { seats = value; }, setCurrent: (value: boolean) => { current = value; }, setWorkspace: () => { workspace = true; } };
}

describe("automatic rig seats views", () => {
  it("creates a rig workspace and exactly one seats tab with a writable lead pane", async () => {
    const f = fixture(); await f.views.reconcile();
    expect(f.tabs).toHaveLength(1); expect(f.tabs[0].label).toBe("lead");
    expect(f.panes[0].argv).toEqual(["tmux", "attach", "-f", "ignore-size", "-E", "-t", "lead@rig"]);
    expect(f.calls.some(c => c.method === "tab.focus")).toBe(false);
  });
  it("recreates an existing read-only non-lead observer as writable without changing other tabs", async () => {
    const f = fixture(); await f.views.reconcile();
    f.setSeats([{ nodeId: "helper", target: "martech-email@bavarian-nordic", label: "martech-email", writable: true, life: "running" }]);
    await f.views.reconcile();
    f.panes[0].argv = ["tmux", "attach", "-r", "-E", "-t", "martech-email@bavarian-nordic"];
    await f.views.reconcile();
    expect(f.calls.filter(c => c.method === "layout.apply")).toHaveLength(3);
    expect(f.panes[0].argv).toEqual(["tmux", "attach", "-f", "ignore-size", "-E", "-t", "martech-email@bavarian-nordic"]);
    expect(f.human).toEqual({ pane_id: "human", terminal_id: "human-terminal", tab_id: "mission-control" });
  });
  it("selects the seats tab once when it is in the currently focused workspace", async () => {
    const f = fixture(); f.setWorkspace(); await f.views.reconcile();
    expect(f.calls.find(c => c.method === "tab.focus").params).toEqual({ tab_id: f.tabs[0].tab_id });
    await f.views.reconcile(); expect(f.calls.filter(c => c.method === "tab.focus")).toHaveLength(1);
  });
  it("adds and removes running seats by replacing only the disposable view tab", async () => {
    const f = fixture(); await f.views.reconcile();
    f.setSeats([{ nodeId: "lead", target: "lead@rig", label: "lead", writable: true, life: "running", lead: true }, { nodeId: "helper", target: "helper@rig", label: "helper", writable: true, life: "running" }]);
    await f.views.reconcile(); expect(f.panes).toHaveLength(2); expect(f.tabs.map(t => t.label)).toEqual(["lead", "other"]);
    expect(f.panes.map(p => p.argv)).toContainEqual(["tmux", "attach", "-f", "ignore-size", "-E", "-t", "lead@rig"]);
    expect(f.panes.map(p => p.argv)).toContainEqual(["tmux", "attach", "-f", "ignore-size", "-E", "-t", "helper@rig"]);
    f.setSeats([{ nodeId: "lead", target: "lead@rig", label: "lead", writable: true, life: "running", lead: true }]); await f.views.reconcile();
    expect(f.tabs.map(t => t.label)).toEqual(["lead"]); expect(f.panes).toHaveLength(1);
    expect(f.human).toEqual({ pane_id: "human", terminal_id: "human-terminal", tab_id: "mission-control" });
    expect(f.calls.filter(c => !["workspace.create", "layout.apply", "pane.process_info", "tab.focus", "tab.close"].includes(c.method) && !c.method.endsWith(".list"))).toEqual([]);
    expect(f.calls.filter(c => c.method === "tab.focus")).toHaveLength(1);
  });
  it("gives each pod with live seats its own tab after the lead tab", async () => {
    const f = fixture();
    f.setSeats([
      { nodeId: "lead", target: "lead@rig", label: "lead", writable: true, life: "running", lead: true },
      { nodeId: "a", target: "a@rig", label: "a", writable: true, life: "running", pod: "build" },
      { nodeId: "b", target: "b@rig", label: "b", writable: true, life: "running", pod: "review" },
      { nodeId: "c", target: "c@rig", label: "c", writable: true, life: "absent", pod: "idle" }]);
    await f.views.reconcile();
    expect(f.tabs.map(t => t.label)).toEqual(["lead", "build", "review"]);
  });
  it("closes the space when the rig goes down and reopens it when it comes back", async () => {
    const f = fixture(); await f.views.reconcile(); expect(f.calls.some(c => c.method === "workspace.create")).toBe(true);
    const lead = { nodeId: "lead", target: "lead@rig", label: "lead", writable: true, life: "running" as const, lead: true };
    f.setSeats([{ ...lead, life: "absent" }]); await f.views.reconcile();
    expect(f.calls.some(c => c.method === "workspace.close")).toBe(true); expect(f.tabs).toHaveLength(0);
    const creates = f.calls.filter(c => c.method === "workspace.create").length;
    f.setSeats([lead]); await f.views.reconcile();
    expect(f.calls.filter(c => c.method === "workspace.create")).toHaveLength(creates + 1); expect(f.tabs.map(t => t.label)).toEqual(["lead"]);
  });
  it("closes herdr's default idle-shell tab, but never a numbered tab running something", async () => {
    const f = fixture(); await f.views.reconcile();
    f.tabs.push({ tab_id: "t1", label: "1" }); f.panes.push({ pane_id: "p1", terminal_id: "tt1", tab_id: "t1", argv: ["-zsh"], pid: 900 });
    await f.views.reconcile(); expect(f.tabs.map(t => t.label)).toEqual(["lead"]);
    f.tabs.push({ tab_id: "t2", label: "2" }); f.panes.push({ pane_id: "p2", terminal_id: "tt2", tab_id: "t2", argv: ["vim"], pid: 901 });
    await f.views.reconcile(); expect(f.tabs.map(t => t.label)).toContain("2");
  });
  it("never creates a space for a rig that is down", async () => {
    const f = fixture(); f.setSeats([{ nodeId: "lead", target: "lead@rig", label: "lead", writable: true, life: "absent", lead: true }]);
    await f.views.reconcile(); expect(f.calls.some(c => c.method === "workspace.create")).toBe(false);
  });
  it("keeps a down rig's space when a human tab still lives in it", async () => {
    const f = fixture(); await f.views.reconcile();
    f.tabs.push({ tab_id: "mission-control", label: "mission" });
    f.setSeats([{ nodeId: "lead", target: "lead@rig", label: "lead", writable: true, life: "absent", lead: true }]); await f.views.reconcile();
    expect(f.calls.some(c => c.method === "workspace.close")).toBe(false);
  });
  it("rejects writable observer attaches without ignore-size", () => {
    expect(observerAttach(["tmux", "attach", "-E", "-t", "lead@rig"])).toBeNull();
    expect(observerAttach(["tmux", "attach", "-f", "ignore-size", "-E", "-t", "lead@rig"])).toEqual({ target: "lead@rig", writable: true });
  });
  it("leaves matching views untouched across controller restart and unknown status", async () => {
    const f = fixture(); await f.views.reconcile(); const original = structuredClone(f.panes);
    await f.views.dispose(); const restarted = new ManagedHerdrViews(f.deps);
    f.setSeats([{ nodeId: "lead", target: "lead@rig", label: "lead", writable: true, life: "unknown", lead: true }]);
    await restarted.reconcile(); expect(f.panes).toEqual(original);
    expect(f.calls.filter(c => c.method === "layout.apply")).toHaveLength(1);
  });
  it.each([null, ["tmux", "attach", "-t", "lead@rig"]])("never replaces unverified or interactive panes (%j)", async argv => {
    const f = fixture(); await f.views.reconcile(); f.panes[0].argv = argv; f.setSeats([]);
    await f.views.reconcile(); expect(f.calls.filter(c => c.method === "layout.apply")).toHaveLength(1);
    expect(observerAttach(argv)).toBeNull();
  });
  it("never replaces a changed terminal or acts on a stale seat observation", async () => {
    const f = fixture(); await f.views.reconcile(); const request = f.deps.transport.request;
    f.deps.transport.request = async (method, params) => {
      const result = await request(method, params);
      if (method === "pane.process_info") f.panes[0].terminal_id = "human-replacement";
      return result;
    };
    f.setSeats([]); await f.views.reconcile(); expect(f.calls.filter(c => c.method === "layout.apply")).toHaveLength(1);
    f.setCurrent(false); f.setSeats([{ nodeId: "helper", target: "helper@rig", label: "helper", writable: true, life: "running" }]);
    await f.views.reconcile(); expect(f.calls.filter(c => c.method === "layout.apply")).toHaveLength(1);
  });
  it("treats a dead observer's bare idle login shell as disposable and rebuilds the view", async () => {
    const f = fixture(); await f.views.reconcile(); const request = f.deps.transport.request;
    f.deps.transport.request = async (method: string, params: any) => {
      const result = await request(method, params);
      if (method === "pane.process_info") return { process_info: { shell_pid: 7, foreground_processes: [{ pid: 7, argv: ["-zsh"] }] } };
      return result;
    };
    const before = f.calls.filter(c => c.method === "layout.apply").length;
    f.setSeats([{ nodeId: "other", target: "other@rig", label: "other", writable: true, life: "running" }]);
    await f.views.reconcile();
    expect(f.views.status()[Object.keys(f.views.status())[0]!]).not.toMatch(/unverified or human/);
    expect(f.calls.filter(c => c.method === "layout.apply").length).toBeGreaterThan(before);
  });
});
