import type Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import type { TmuxAdapter } from "../../adapters/tmux.js";
import { listNativeProcesses } from "../native-process-lineage.js";
import type { EventBus } from "../event-bus.js";
import type { HerdrTransport } from "./herdr-transport.js";
import { equalStrip, type HerdrLayoutNode } from "./herdr-adapter.js";

export interface ObserverSeat { nodeId: string; target: string; label: string; writable: boolean; life: "running" | "absent" | "unknown"; pod?: string | null; lead?: boolean }
export interface ObserverRig { id: string; name: string; seats: ObserverSeat[] }
interface Pane { pane_id: string; terminal_id: string; tab_id: string }
export interface ObserverClient { pid: number; target: string; readOnly: boolean; ignoreSize: boolean }
interface Deps {
  transport: Pick<HerdrTransport, "request">;
  listRigs(): Promise<ObserverRig[]>;
  listClients(): Promise<ObserverClient[]>;
  isCurrent(seat: ObserverSeat): boolean;
  bind?(seat: ObserverSeat, paneId: string): void;
  unbind?(paneId: string): void;
  eventBus?: Pick<EventBus, "subscribe">;
  log?(message: string): void;
}
const EMPTY = ["sh", "-c", "printf 'No running seats. This view updates automatically.\\n'; exec sleep 2147483647"];
const EVENTS = new Set(["rig.created", "node.launched", "node.startup_ready", "node.removed", "session.stopped", "session.cleaned", "session.detached", "restore.completed", "restore.subset_completed"]);
const array = <T>(value: unknown): T[] => {
  if (!Array.isArray(value)) throw new Error("native inventory unavailable, views retained");
  return value;
};
const object = (value: unknown): Record<string, any> => value && typeof value === "object" ? value as Record<string, any> : {};

const LEAD_TAB = "lead";
const LEGACY_TAB = "seats";
const podTabLabel = (seat: ObserverSeat) => seat.lead ? LEAD_TAB : seat.pod || "other";

/** One `lead` tab (all lead seats, else the first seat) and one tab per pod holding its other seats. */
export function observerTabs(seats: ObserverSeat[]): Map<string, ObserverSeat[]> {
  const groups = new Map<string, ObserverSeat[]>();
  const add = (label: string, seat: ObserverSeat) => groups.set(label, [...(groups.get(label) ?? []), seat]);
  const leads = seats.filter(s => s.lead);
  const fallback = !leads.length && seats[0] ? seats[0] : null;
  if (fallback) add(LEAD_TAB, fallback);
  for (const seat of seats) { if (seat !== fallback) add(podTabLabel(seat), seat); }
  const ordered = new Map<string, ObserverSeat[]>();
  if (groups.has(LEAD_TAB)) ordered.set(LEAD_TAB, groups.get(LEAD_TAB)!);
  for (const [label, members] of groups) if (label !== LEAD_TAB) ordered.set(label, members);
  return ordered;
}

export function observerGrid(seats: ObserverSeat[]): HerdrLayoutNode {
  const panes: HerdrLayoutNode[] = seats.map(seat => ({ type: "pane", label: seat.label, command: ["tmux", "attach", ...(seat.writable ? ["-f", "ignore-size"] : ["-r"]), "-E", "-t", seat.target] }));
  if (!panes.length) return { type: "pane", label: "no running seats", command: EMPTY };
  const columns: HerdrLayoutNode[] = [];
  for (let i = 0; i < panes.length; i += 2) columns.push(equalStrip(panes.slice(i, i + 2), "down"));
  return equalStrip(columns, "right");
}

/** Only a direct observer attach is replaceable. Labels are not authority. */
export function observerAttach(argv: unknown): { target: string; writable: boolean } | null {
  if (!Array.isArray(argv) || !argv.every(v => typeof v === "string") || path.basename(argv[0] ?? "") !== "tmux" || !["attach", "attach-session"].includes(argv[1] ?? "")) return null;
  let target: string | null = null, readonly = false, noEnvUpdate = false, ignoreSize = false;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "-r") readonly = true;
    else if (argv[i] === "-E") noEnvUpdate = true;
    else if (argv[i] === "-f" && argv[i + 1] === "ignore-size") { ignoreSize = true; i++; }
    else if (argv[i] === "-t" && target === null) target = argv[++i] ?? null;
    else return null;
  }
  return target && noEnvUpdate && (readonly || ignoreSize) ? { target, writable: !readonly } : null;
}

/** Observer reconciliation mutates its disposable pane layout only; lead panes remain interactively attachable. */
export class ManagedHerdrViews {
  private findings: Record<string, string> = {};
  private sweep: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | undefined;
  private stopped = false;
  private readonly landedWorkspaces = new Set<string>();
  constructor(private readonly deps: Deps) {}
  status(): Record<string, string> { return { ...this.findings }; }
  start(): void {
    if (this.timer || this.stopped) return;
    this.unsubscribe = this.deps.eventBus?.subscribe(event => { if (EVENTS.has(event.type)) void this.reconcile(); });
    this.timer = setInterval(() => { void this.reconcile(); }, 10_000);
    this.timer.unref();
    void this.reconcile();
  }
  async dispose(): Promise<void> {
    this.stopped = true;
    this.unsubscribe?.();
    if (this.timer) clearInterval(this.timer);
    await this.sweep;
  }
  async reconcile(): Promise<void> {
    if (this.stopped) return;
    if (this.sweep) return this.sweep;
    this.sweep = this.refresh();
    try { await this.sweep; } finally { this.sweep = null; }
  }
  private async rpc(method: string, params: unknown) {
    if (this.stopped) throw new Error("observer stopped");
    return this.deps.transport.request(method, params);
  }
  private note(id: string, text: string) {
    if (this.findings[id] !== text) this.deps.log?.(`[herdr-views] ${id}: ${text}`);
    this.findings[id] = text;
  }
  private async inspect(panes: Pane[], clients: ObserverClient[]): Promise<Array<{ target: string; writable: boolean } | null>> {
    return Promise.all(panes.map(async pane => {
      const info = object((await this.rpc("pane.process_info", { pane_id: pane.pane_id })).process_info);
      for (const process of array<Record<string, any>>(info.foreground_processes)) {
        const attach = observerAttach(process.argv);
        if (attach && clients.some(client => client.pid === process.pid && client.target === attach.target && client.readOnly !== attach.writable && client.ignoreSize)) return attach;
        if (process.pid === info.shell_pid && Array.isArray(process.argv) && path.basename(process.argv[0] ?? "") === "sleep" && process.argv[1] === "2147483647") return null;
      }
      // A dead observer (its tmux session ended, so `tmux attach` exited) leaves a bare idle login shell
      // as the sole foreground process. Nothing human is running there, so it is as disposable as the
      // placeholder pane; without this the view is retained as stale forever.
      const fg = array<Record<string, any>>(info.foreground_processes);
      if (fg.length === 1 && fg[0]!.pid === info.shell_pid && /^(?:-)?(?:zsh|bash|sh|fish)$/.test(path.basename(String(fg[0]!.argv?.[0] ?? "")))) return null;
      throw new Error("seats tab contains an unverified or human pane, retained");
    }));
  }
  private async refresh(): Promise<void> {
    try {
      const rigs = await this.deps.listRigs();
      const clients = await this.deps.listClients();
      const workspaces = array<{ workspace_id: string; label: string; focused?: boolean }>((await this.rpc("workspace.list", {})).workspaces);
      delete this.findings.transport;
      for (const rig of rigs) {
        if (this.stopped) break;
        try { await this.syncRig(rig, workspaces, clients); } catch (error) { this.note(rig.id, String(error)); }
      }
    } catch (error) { this.note("transport", String(error)); }
  }
  /** A space exists only while its rig is up: a `lead` tab plus one tab per pod with live seats. */
  private async syncRig(rig: ObserverRig, workspaces: Array<{ workspace_id: string; label: string; focused?: boolean }>, clients: ObserverClient[]): Promise<void> {
    const matches = workspaces.filter(w => w.label === rig.name);
    if (matches.length > 1) throw new Error("duplicate workspace name, retained");
    const up = rig.seats.some(s => s.life !== "absent");
    if (!up && !matches[0]) { this.note(rig.id, "rig down, no space"); return; }
    const workspace = matches[0] ?? object((await this.rpc("workspace.create", { label: rig.name, focus: false })).workspace);
    if (!workspace.workspace_id) throw new Error("workspace identity unavailable");
    const tabs = array<{ tab_id: string; label: string }>((await this.rpc("tab.list", { workspace_id: workspace.workspace_id })).tabs);
    const groups = observerTabs(rig.seats.filter(s => s.life !== "absent"));
    let running = 0;
    const kept = new Set<string>();
    let leadTabId: string | undefined;
    if (up) {
      for (const [label, members] of groups) {
        const tabId = await this.syncTab(workspace.workspace_id, tabs, label, members, clients);
        if (tabId !== undefined) { running += 1; kept.add(label); }
        if (label === LEAD_TAB) leadTabId = tabId;
      }
    }
    // Close stale view tabs, but only tabs whose every pane is positively one of our observer attaches.
    for (const tab of tabs.filter(t => !kept.has(t.label))) {
      const panes = array<Pane>((await this.rpc("pane.list", { workspace_id: workspace.workspace_id })).panes).filter(p => p.tab_id === tab.tab_id);
      if (!panes.length || !(await this.allObservers(panes, clients))) continue;
      for (const pane of panes) this.deps.unbind?.(pane.pane_id);
      await this.rpc("tab.close", { tab_id: tab.tab_id });
    }
    if (!up) {
      // Rig is down: close the space unless a human tab still lives in it.
      const left = array<{ tab_id: string; label: string }>((await this.rpc("tab.list", { workspace_id: workspace.workspace_id })).tabs);
      if (left.length) { this.note(rig.id, "rig down, space retained (other tabs present)"); return; }
      await this.rpc("workspace.close", { workspace_id: workspace.workspace_id });
      this.landedWorkspaces.delete(workspace.workspace_id);
      this.note(rig.id, "rig down, space closed");
      return;
    }
    if (workspace.focused && !this.landedWorkspaces.has(workspace.workspace_id) && leadTabId) {
      await this.rpc("tab.focus", { tab_id: leadTabId });
      this.landedWorkspaces.add(workspace.workspace_id);
    }
    this.note(rig.id, `${running} tabs, ${rig.seats.filter(s => s.life === "running").length} seats${rig.seats.some(s => s.life === "unknown") ? ", some runtime status unknown" : ""}`);
  }
  private async allObservers(panes: Pane[], clients: ObserverClient[]): Promise<boolean> {
    try {
      const results = await Promise.all(panes.map(async pane => {
        const info = object((await this.rpc("pane.process_info", { pane_id: pane.pane_id })).process_info);
        return array<Record<string, any>>(info.foreground_processes).some(p => {
          const attach = observerAttach(p.argv);
          if (attach) return clients.some(c => c.pid === p.pid && c.target === attach.target);
          return p.pid === info.shell_pid && Array.isArray(p.argv) && path.basename(p.argv[0] ?? "") === "sleep" && p.argv[1] === "2147483647";
        });
      }));
      return results.every(Boolean);
    } catch { return false; }
  }
  /** Reconcile one labelled tab; returns its tab id, or undefined when it has nothing running. */
  private async syncTab(workspaceId: string, tabs: Array<{ tab_id: string; label: string }>, label: string, members: ObserverSeat[], clients: ObserverClient[]): Promise<string | undefined> {
    const same = tabs.filter(t => t.label === label);
    if (same.length > 1) throw new Error("duplicate seats tabs, retained");
    const tab = same[0];
    const panes = tab ? array<Pane>((await this.rpc("pane.list", { workspace_id: workspaceId })).panes).filter(p => p.tab_id === tab.tab_id) : [];
    const targets = await this.inspect(panes, clients);
    const desired = members.filter(s => s.life === "running" || (s.life === "unknown" && targets.some(t => t?.target === s.target)));
    if (!desired.length) return undefined;
    const existing = targets.filter((target): target is { target: string; writable: boolean } => target !== null);
    if (tab && existing.length === desired.length && desired.every(s => existing.some(e => e.target === s.target && e.writable === s.writable))) {
      for (const seat of desired) if (this.deps.isCurrent(seat)) this.deps.bind?.(seat, panes[targets.findIndex(t => t?.target === seat.target)]!.pane_id);
      return tab.tab_id;
    }
    // Re-check the complete view after awaits. Replacement affects only
    // these positively verified observer terminals, never a seat pane.
    const latest = tab ? array<Pane>((await this.rpc("pane.list", { workspace_id: workspaceId })).panes).filter(p => p.tab_id === tab.tab_id) : [];
    if (JSON.stringify(latest.map(p => [p.pane_id, p.terminal_id])) !== JSON.stringify(panes.map(p => [p.pane_id, p.terminal_id]))) throw new Error("view changed during observation, retained");
    if (desired.some(s => !this.deps.isCurrent(s))) throw new Error("seat changed during observation, retry later");
    const result = await this.rpc("layout.apply", { ...(tab ? { tab_id: tab.tab_id } : { workspace_id: workspaceId }), tab_label: label, focus: false, root: observerGrid(desired) });
    for (const pane of panes) this.deps.unbind?.(pane.pane_id);
    const newTab = object(result.layout).tab_id;
    const created = array<Pane>((await this.rpc("pane.list", { workspace_id: workspaceId })).panes).filter(p => p.tab_id === newTab);
    const attached = await this.inspect(created, await this.deps.listClients());
    for (const seat of desired) if (this.deps.isCurrent(seat) && attached.some(a => a?.target === seat.target && a.writable === seat.writable)) this.deps.bind?.(seat, created[attached.findIndex(a => a?.target === seat.target)]!.pane_id);
    if (tab) tab.tab_id = newTab;
    return newTab;
  }
}

/** Use existing DB bindings plus one host process census, without a second state store. */
export function managedViewInventory(db: Database.Database, tmux: Pick<TmuxAdapter, "listSessions" | "getPanePid">) {
  const sql = `SELECT n.rig_id,n.id node_id,n.logical_id,n.runtime,s.status,s.session_name,b.tmux_session,b.tmux_pane,COALESCE(NULLIF(p.namespace,''),p.label) pod
    FROM nodes n LEFT JOIN pods p ON p.id=n.pod_id LEFT JOIN sessions s ON s.id=(SELECT id FROM sessions WHERE node_id=n.id ORDER BY (status='running') DESC,id DESC LIMIT 1)
    LEFT JOIN bindings b ON b.node_id=n.id`;
  const target = (row: any) => row.tmux_session ?? row.session_name ?? "";
  return {
    async listRigs(): Promise<ObserverRig[]> {
      const rigs = db.prepare("SELECT id,name FROM rigs WHERE archived_at IS NULL ORDER BY created_at").all() as Array<{ id: string; name: string }>;
      const rows = db.prepare(sql + " ORDER BY n.rig_id,CASE WHEN n.logical_id LIKE '%.lead' THEN 0 ELSE 1 END,n.logical_id").all() as any[];
      const live = new Set((await tmux.listSessions()).map(s => s.name));
      const processes = await listNativeProcesses();
      const seats = await Promise.all(rows.map(async row => {
        let life: ObserverSeat["life"] = "unknown";
        if (row.status !== "running" || (live.size && !live.has(target(row)))) life = "absent";
        else if (live.has(target(row)) && row.tmux_pane && target(row) === row.session_name) {
          const pid = await tmux.getPanePid(row.tmux_pane);
          const tree = processes.filter(p => p.pid === pid);
          for (let i = 0; i < tree.length; i++) tree.push(...processes.filter(p => p.ppid === tree[i]!.pid && !tree.some(t => t.pid === p.pid)));
          const executable = row.runtime === "claude-code" ? "claude" : row.runtime;
          if (row.runtime === "terminal" && tree.length || tree.some(p => path.basename(p.executableName ?? p.command.split(/\s+/)[0] ?? "") === executable && !p.command.includes(" serve"))) life = "running";
          else if (tree.length === 1 && /(?:^|\/)(?:sh|bash|zsh|fish)(?:\s|$)/.test(tree[0]!.command)) life = "absent";
        }
        return { nodeId: row.node_id, target: target(row), label: target(row).split("@")[0] || row.logical_id, writable: true, life, pod: row.pod ?? null, lead: /(?:^|[.-])lead$/.test(row.logical_id ?? "") };
      }));
      return rigs.map(rig => ({ ...rig, seats: seats.filter((_, i) => rows[i].rig_id === rig.id) }));
    },
    isCurrent(seat: ObserverSeat): boolean {
      const row = db.prepare(sql + " WHERE n.id=?").get(seat.nodeId) as any;
      return !!row && target(row) === seat.target && (seat.life !== "running" || row.status === "running");
    },
  };
}

export async function listObserverClients(): Promise<ObserverClient[]> {
  const { stdout } = await promisify(execFile)("tmux", ["list-clients", "-F", "#{client_pid}|#{client_session}|#{client_readonly}|#{client_flags}"], { timeout: 5000, maxBuffer: 1024 * 1024 });
  return stdout.split("\n").filter(Boolean).map(line => {
    const [pid, target, readonly, flags] = line.split("|");
    if (!pid || !target || !flags || !/^\d+$/.test(pid)) throw new Error("invalid tmux client inventory");
    return { pid: Number(pid), target, readOnly: readonly === "1", ignoreSize: flags.split(",").includes("ignore-size") };
  });
}
