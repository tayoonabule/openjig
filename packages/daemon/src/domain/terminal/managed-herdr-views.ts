import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { EventBus } from "../event-bus.js";
import type { HerdrTransport } from "./herdr-transport.js";
import { equalStrip, type HerdrLayoutNode } from "./herdr-adapter.js";

export interface ObserverSeat {
  nodeId: string;
  occupant: string;
  target: string;
  label: string;
  runtime: string | null;
  life: "running" | "absent" | "unknown";
}
export interface ObserverRig { id: string; name: string; seats: ObserverSeat[] }
export interface ObserverClient { pid: number; target: string; readOnly: boolean; ignoreSize: boolean }
interface NativePane { pane_id: string; terminal_id: string; tab_id: string; label?: string }
interface OwnedPane { paneId: string; terminalId: string; tabId: string; nodeId: string; occupant: string; target: string; directAttachPid?: number; movingToTab?: string }
interface OwnedRig { workspaceId: string; tabs: string[]; panes: OwnedPane[]; empty?: NativePane }
export interface ManagedViewsState { version: 1; rigs: Record<string, OwnedRig> }
export interface ManagedHerdrViewsDeps {
  transport: Pick<HerdrTransport, "request">;
  listRigs(): Promise<ObserverRig[]>;
  listClients(): Promise<ObserverClient[]>;
  load(): ManagedViewsState;
  save(state: ManagedViewsState): void;
  /** Explicit first-adoption approval, not inferred from a matching label. */
  adoptionRigNames?: ReadonlySet<string>;
  isCurrent?(seat: ObserverSeat): boolean;
  bind?(seat: ObserverSeat, paneId: string): void;
  unbind?(paneId: string): void;
  processExited?(pid: number): boolean;
  eventBus?: Pick<EventBus, "subscribe">;
  log?(message: string): void;
}

const PAGE_SIZE = 6;
const EMPTY_COMMAND = ["sh", "-c", "printf 'No running seats. This view updates automatically.\\n'; exec sleep 2147483647"];
const LIFECYCLE = new Set(["rig.created", "rig.deleted", "node.launched", "node.startup_ready", "node.removed", "session.stopped", "session.cleaned", "session.detached", "session.status_changed", "restore.completed", "restore.subset_completed", "node.handover_completed"]);
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const list = <T>(value: unknown): T[] => {
  if (!Array.isArray(value)) throw new Error("native inventory missing or malformed, no mutation");
  return value as T[];
};
const processes = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value as Record<string, unknown>[] : [];

/** ESRCH is positive exit evidence. Permission/observation failure is unknown. */
export function observerProcessExited(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

/** Direct argv, never a shell-parsed attach command. -r also means ignore-size. */
export function observerGrid(seats: ObserverSeat[]): HerdrLayoutNode {
  const leaves: HerdrLayoutNode[] = seats.map(seat => ({ type: "pane", label: seat.label, command: ["tmux", "attach", "-r", "-E", "-t", seat.target] }));
  if (!leaves.length) return { type: "pane", label: "no running seats", command: EMPTY_COMMAND };
  if (leaves.length === 1) return leaves[0]!;
  if (leaves.length <= 4) {
    const columns = [leaves.slice(0, Math.ceil(leaves.length / 2)), leaves.slice(Math.ceil(leaves.length / 2))];
    return equalStrip(columns.map(column => equalStrip(column, "down")), "right");
  }
  // Reference: two-row lead column gets half the width, other columns a quarter.
  return { type: "split", direction: "right", ratio: 0.5, first: equalStrip(leaves.slice(0, 2), "down"), second: equalStrip([equalStrip(leaves.slice(2, 4), "down"), equalStrip(leaves.slice(4), "down")], "right") };
}

export function readonlyAttachTarget(argv: unknown): string | null {
  if (!Array.isArray(argv) || !argv.every(v => typeof v === "string")) return null;
  if (path.basename(argv[0] ?? "") !== "tmux" || !["attach", "attach-session"].includes(argv[1] ?? "")) return null;
  // Only the exact native attach grammar we emit/adopt. No shell, combined flags,
  // client control mode, target substring, or additional command is authority.
  let target: string | null = null;
  let readonly = false;
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-r") readonly = true;
    else if (arg === "-E") continue;
    else if (arg === "-t" && target === null && typeof argv[i + 1] === "string") target = argv[++i]!;
    else return null;
  }
  return readonly && target ? target : null;
}

/** Atomic ownership only. No seat/model/session state is written here. */
export function managedViewsFile(file: string): Pick<ManagedHerdrViewsDeps, "load" | "save"> {
  return {
    load() {
      try {
        const state = JSON.parse(readFileSync(file, "utf8")) as ManagedViewsState;
        if (state.version !== 1 || !state.rigs || typeof state.rigs !== "object" || Array.isArray(state.rigs)) throw new Error("invalid managed view ownership");
        for (const owned of Object.values(state.rigs)) {
          if (typeof owned.workspaceId !== "string" || !Array.isArray(owned.tabs) || !Array.isArray(owned.panes)) throw new Error("invalid managed view ownership");
          for (const pane of owned.panes) if (![pane.paneId, pane.terminalId, pane.tabId, pane.nodeId, pane.occupant, pane.target].every(v => typeof v === "string" && v.length > 0)) throw new Error("invalid managed pane ownership");
        }
        return state;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, rigs: {} };
        throw error; // Never overwrite corrupted ownership or guess what may be closed.
      }
    },
    save(state) {
      mkdirSync(path.dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
      renameSync(temp, file);
    },
  };
}

/** A serialized, passive observer controller, separate from interactive openView. */
export class ManagedHerdrViews {
  private readonly state: ManagedViewsState;
  private readonly findings: Record<string, string> = {};
  private stopped = false;
  private pending = false;
  private sweep: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly deps: ManagedHerdrViewsDeps) { this.state = structuredClone(deps.load()); }
  status(): Record<string, string> { return { ...this.findings }; }
  start(): void {
    if (this.stopped || this.timer) return;
    this.unsubscribe = this.deps.eventBus?.subscribe(event => {
      if (!LIFECYCLE.has(event.type) || this.stopped || this.debounce) return;
      this.debounce = setTimeout(() => { this.debounce = null; void this.reconcile(); }, 100);
      this.debounce.unref();
    }) ?? null;
    // One bounded observation backstop covers missed events and natural runtime exits.
    this.timer = setInterval(() => { void this.reconcile(); }, 10_000);
    this.timer.unref();
    void this.reconcile();
  }
  async dispose(): Promise<void> {
    this.stopped = true;
    this.unsubscribe?.(); this.unsubscribe = null;
    if (this.timer) clearInterval(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    this.timer = null; this.debounce = null;
    await this.sweep;
  }
  async reconcile(): Promise<void> {
    if (this.stopped) return;
    if (this.sweep) { this.pending = true; return this.sweep; }
    this.sweep = (async () => {
      // Coalesce a burst to at most one additional pass, not an unbounded loop.
      for (let pass = 0; pass < 2 && !this.stopped; pass++) {
        this.pending = false;
        try { await this.reconcileOnce(); }
        catch (error) { this.note("transport", `views pending: ${error instanceof Error ? error.message : String(error)}`); }
        if (!this.pending) break;
      }
    })();
    try { await this.sweep; } finally { this.sweep = null; }
  }
  private note(id: string, text: string): void {
    if (this.findings[id] !== text) this.deps.log?.(`[herdr-views] ${id}: ${text}`);
    this.findings[id] = text;
  }
  private async rpc(method: string, params: unknown) {
    if (this.stopped) throw new Error("reconciler disposed");
    return this.deps.transport.request(method, params);
  }
  private persist(): void { this.deps.save(this.state); }
  private current(seat: ObserverSeat): boolean { return !this.stopped && (this.deps.isCurrent?.(seat) ?? true); }

  private async verifiedTarget(pane: NativePane, clients: ObserverClient[]): Promise<string | null> {
    const info = record((await this.rpc("pane.process_info", { pane_id: pane.pane_id })).process_info);
    for (const process of processes(info.foreground_processes)) {
      const target = readonlyAttachTarget(process.argv);
      const client = clients.find(client => client.pid === process.pid && client.target === target);
      if (target && client?.readOnly && client.ignoreSize) {
        const owned = Object.values(this.state.rigs).flatMap(rig => rig.panes).find(owned => owned.paneId === pane.pane_id && owned.terminalId === pane.terminal_id);
        if (owned && process.pid === info.shell_pid && typeof process.pid === "number" && owned.directAttachPid !== process.pid) { owned.directAttachPid = process.pid; this.persist(); }
        return target;
      }
    }
    return null;
  }

  private async freshPane(workspaceId: string, expected: { paneId: string; terminalId: string; tabId: string }): Promise<NativePane> {
    const native = list<NativePane>((await this.rpc("pane.list", { workspace_id: workspaceId })).panes);
    const pane = native.find(p => p.pane_id === expected.paneId && p.terminal_id === expected.terminalId && p.tab_id === expected.tabId);
    if (!pane) throw new Error("pane moved or replaced during reconcile, no mutation");
    return pane;
  }

  private async closeObserver(owned: OwnedRig, pane: OwnedPane, seat?: ObserverSeat): Promise<void> {
    let live = await this.freshPane(owned.workspaceId, pane);
    const target = await this.verifiedTarget(live, await this.deps.listClients());
    if (target !== pane.target) {
      // Empty process_info alone is UNKNOWN on Herdr. Only an observed direct
      // tmux exec whose OS PID is positively gone proves our terminal exited.
      if (!pane.directAttachPid || !this.deps.processExited?.(pane.directAttachPid)) throw new Error("observer exit not positively verified, retained");
      const info = record((await this.rpc("pane.process_info", { pane_id: live.pane_id })).process_info);
      if (info.shell_pid !== pane.directAttachPid || processes(info.foreground_processes).length) throw new Error("observer process replaced or unknown, retained");
    }
    live = await this.freshPane(owned.workspaceId, pane);
    if (seat && !this.current(seat)) throw new Error("seat changed before close, retained");
    await this.rpc("pane.close", { pane_id: live.pane_id });
  }

  private async reconcileOnce(): Promise<void> {
    const rigs = await this.deps.listRigs();
    const clients = await this.deps.listClients(); // Failure aborts: never deletion authority.
    const workspaces = list<{ workspace_id: string; label: string }>((await this.rpc("workspace.list", {})).workspaces);
    delete this.findings.transport;
    for (const rig of rigs) {
      if (this.stopped) return;
      try { await this.reconcileRig(rig, workspaces, clients); }
      catch (error) { this.note(rig.id, `views pending: ${error instanceof Error ? error.message : String(error)}`); }
    }
    // Removed rigs lose only their previously owned observers, never user workspaces.
    for (const id of Object.keys(this.state.rigs)) {
      if (!rigs.some(rig => rig.id === id)) {
        try { await this.reconcileRig({ id, name: "", seats: [] }, workspaces, clients, true); }
        catch (error) { this.note(id, `removed rig view pending: ${String(error)}`); }
      }
    }
  }

  private async reconcileRig(rig: ObserverRig, workspaces: Array<{ workspace_id: string; label: string }>, clients: ObserverClient[], removed = false): Promise<void> {
    let owned = this.state.rigs[rig.id];
    let workspace = owned ? workspaces.find(w => w.workspace_id === owned!.workspaceId) : undefined;
    if (owned && !workspace) { delete this.state.rigs[rig.id]; this.persist(); owned = undefined; }
    if (removed && !owned) return;
    if (!owned) {
      const matches = workspaces.filter(w => w.label === rig.name);
      if (matches.length > 1) throw new Error("ambiguous rig workspace, no views changed");
      workspace = matches[0];
      if (!workspace) {
        const created = await this.rpc("workspace.create", { label: rig.name, focus: false });
        const id = record(created.workspace).workspace_id;
        if (typeof id !== "string") throw new Error("workspace create returned no identity");
        workspace = { workspace_id: id, label: rig.name }; workspaces.push(workspace);
      }
      const tabs = list<{ tab_id: string; label: string }>((await this.rpc("tab.list", { workspace_id: workspace.workspace_id })).tabs);
      const seatsTabs = tabs.filter(tab => tab.label === "seats" || /^seats \d+$/.test(tab.label));
      if (seatsTabs.length) {
        if (!this.deps.adoptionRigNames?.has(rig.name)) throw new Error("unowned seats tab, adoption approval required");
        const native = list<NativePane>((await this.rpc("pane.list", { workspace_id: workspace.workspace_id })).panes);
        const adopted: OwnedPane[] = [];
        for (const pane of native.filter(pane => seatsTabs.some(tab => tab.tab_id === pane.tab_id))) {
          const target = await this.verifiedTarget(pane, clients);
          const seat = rig.seats.find(seat => seat.target === target && seat.life !== "absent");
          if (!seat || adopted.some(pane => pane.nodeId === seat.nodeId)) throw new Error("unowned or duplicate pane in seats tab, no adoption");
          adopted.push({ paneId: pane.pane_id, terminalId: pane.terminal_id, tabId: pane.tab_id, nodeId: seat.nodeId, occupant: seat.occupant, target: seat.target });
        }
        if (!adopted.length) throw new Error("unowned empty seats tab, no adoption");
        owned = { workspaceId: workspace.workspace_id, tabs: seatsTabs.map(tab => tab.tab_id), panes: adopted };
      } else owned = { workspaceId: workspace.workspace_id, tabs: [], panes: [] };
      this.state.rigs[rig.id] = owned; this.persist();
    }
    const native = list<NativePane>((await this.rpc("pane.list", { workspace_id: owned.workspaceId })).panes);
    const liveTabs = list<{ tab_id: string; label: string }>((await this.rpc("tab.list", { workspace_id: owned.workspaceId })).tabs);
    if (liveTabs.some(tab => (tab.label === "seats" || /^seats \d+$/.test(tab.label)) && !owned!.tabs.includes(tab.tab_id))) throw new Error("unowned seats tab found after interrupted creation, retained");
    owned.tabs = owned.tabs.filter(tab => liveTabs.some(live => live.tab_id === tab));
    // Identity drift is not permission to repurpose a pane or remove human work.
    for (const pane of owned.panes) {
      if (pane.movingToTab) {
        const candidates = native.filter(p => p.terminal_id === pane.terminalId);
        const live = candidates.length === 1 ? candidates[0] : undefined;
        if (!live || ![pane.tabId, pane.movingToTab].includes(live.tab_id) || await this.verifiedTarget(live, await this.deps.listClients()) !== pane.target) throw new Error("pending move location unknown, retained");
        this.deps.unbind?.(pane.paneId);
        pane.paneId = live.pane_id; pane.tabId = live.tab_id;
        delete pane.movingToTab; this.persist();
      }
      const live = native.find(p => p.pane_id === pane.paneId);
      if (live && (live.terminal_id !== pane.terminalId || live.tab_id !== pane.tabId)) throw new Error("owned pane identity changed, human view retained");
    }
    if (native.some(p => owned!.tabs.includes(p.tab_id) && !owned!.panes.some(own => own.paneId === p.pane_id) && p.pane_id !== owned!.empty?.pane_id)) throw new Error("unowned pane in managed tab, retained");
    owned.panes = owned.panes.filter(pane => native.some(p => p.pane_id === pane.paneId));
    if (owned.empty) {
      const empty = native.find(p => p.pane_id === owned!.empty!.pane_id);
      if (empty && empty.terminal_id !== owned.empty.terminal_id) throw new Error("empty pane identity changed, human view retained");
      if (!empty) delete owned.empty;
    }
    const desired = rig.seats.filter(seat => seat.life === "running" && this.current(seat));
    for (const pane of [...owned.panes]) {
      const seat = rig.seats.find(seat => seat.nodeId === pane.nodeId);
      if (seat?.life === "unknown") continue;
      if (seat?.target === pane.target && seat.life === "running") {
        // Same readonly target naturally follows a new occupant without reattaching.
        const live = native.find(p => p.pane_id === pane.paneId)!;
        if (await this.verifiedTarget(live, clients) !== pane.target) throw new Error("owned observer no longer read-only, retained");
        await this.freshPane(owned.workspaceId, pane);
        if (!this.current(seat)) throw new Error("seat changed before binding");
        if (pane.occupant !== seat.occupant) { pane.occupant = seat.occupant; this.persist(); }
        this.deps.bind?.(seat, pane.paneId);
        continue;
      }
      if (seat && !this.current(seat)) continue;
      // Keep an owned, clearly labeled empty view before closing the last observer.
      if (!removed && owned.panes.length === 1 && !desired.length && !owned.empty) await this.createPage(owned, []);
      await this.closeObserver(owned, pane, seat);
      this.deps.unbind?.(pane.paneId);
      owned.panes = owned.panes.filter(p => p !== pane); this.persist();
    }
    const missing = desired.filter(seat => !owned!.panes.some(p => p.nodeId === seat.nodeId && p.target === seat.target));
    for (const seat of missing) {
      if (owned.panes.some(p => p.nodeId === seat.nodeId && p.target === seat.target) || !this.current(seat)) continue;
      const tab = owned.tabs.find(tab => owned!.panes.filter(p => p.tabId === tab).length > 0 && owned!.panes.filter(p => p.tabId === tab).length < PAGE_SIZE);
      if (!tab) {
        const batch = missing.filter(s => !owned!.panes.some(p => p.nodeId === s.nodeId) && this.current(s)).slice(0, PAGE_SIZE);
        await this.createPage(owned, batch);
      } else {
        const peers = owned.panes.filter(p => p.tabId === tab);
        const anchor = peers[peers.length - 1]!;
        // Spawn direct argv first, then move only this new observer. Native
        // split starts a login shell, whose readiness cannot authorize input.
        // This path never sends shell commands or keystrokes to any pane.
        await this.createPage(owned, [seat]);
        const created = owned.panes.find(p => p.nodeId === seat.nodeId && p.target === seat.target)!;
        let verified = false;
        for (let attempt = 0; attempt < 8; attempt++) {
          const live = await this.freshPane(owned.workspaceId, created);
          if (!this.current(seat)) throw new Error("seat changed before observer move");
          if (await this.verifiedTarget(live, await this.deps.listClients()) === seat.target) { verified = true; break; }
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        if (!verified) throw new Error("new observer not yet verified, separate readonly tab retained");
        await this.freshPane(owned.workspaceId, anchor);
        await this.freshPane(owned.workspaceId, created);
        if (!this.current(seat)) throw new Error("seat changed before observer move");
        const windows = list<{ workspace_id: string; active_tab_id?: string; focused?: boolean }>((await this.rpc("workspace.list", {})).workspaces);
        if (!windows.some(w => w.focused) || windows.find(w => w.workspace_id === owned.workspaceId)?.active_tab_id === created.tabId) throw new Error("new observer tab selected by user, retained without moving");
        const latest = list<NativePane>((await this.rpc("pane.list", { workspace_id: owned.workspaceId })).panes);
        if ([anchor, created].some(expected => !latest.some(p => p.pane_id === expected.paneId && p.terminal_id === expected.terminalId && p.tab_id === expected.tabId))) throw new Error("move source or destination changed after focus observation");
        if (!this.current(seat)) throw new Error("seat changed after focus observation");
        created.movingToTab = tab; this.persist();
        const moved = await this.rpc("pane.move", { pane_id: created.paneId, destination: { type: "tab", tab_id: tab, target_pane_id: anchor.paneId, split: peers.length % 2 ? "down" : "right", ratio: 0.5 }, focus: false });
        const outcome = record(moved.move_result);
        if (outcome.changed !== true) throw new Error(`observer move deferred: ${String(outcome.reason ?? "unknown native outcome")}`);
        const pane = record(outcome.pane) as unknown as NativePane;
        if (!pane.pane_id || pane.terminal_id !== created.terminalId || pane.tab_id !== tab) throw new Error("move returned changed terminal identity, no further mutation");
        this.deps.unbind?.(created.paneId);
        created.paneId = pane.pane_id; created.tabId = pane.tab_id; delete created.movingToTab; this.persist();
        const live = await this.freshPane(owned.workspaceId, created);
        const readonly = await this.verifiedTarget(live, await this.deps.listClients()) === seat.target;
        await this.freshPane(owned.workspaceId, created);
        if (readonly && this.current(seat)) this.deps.bind?.(seat, created.paneId);
      }
    }
    if (owned.panes.length && owned.empty) {
      const empty = owned.empty;
      const info = record((await this.rpc("pane.process_info", { pane_id: empty.pane_id })).process_info);
      if (!processes(info.foreground_processes).some(p => Array.isArray(p.argv) && path.basename(String(p.argv[0])) === "sleep" && p.argv[1] === "2147483647" && p.pid === info.shell_pid)) throw new Error("empty view process changed, retained");
      await this.freshPane(owned.workspaceId, { paneId: empty.pane_id, terminalId: empty.terminal_id, tabId: empty.tab_id });
      await this.rpc("pane.close", { pane_id: owned.empty.pane_id }); delete owned.empty; this.persist();
    }
    if (!removed && !owned.panes.length && !owned.empty) await this.createPage(owned, []);
    if (removed) { delete this.state.rigs[rig.id]; this.persist(); }
    else this.note(rig.id, `${owned.panes.length} readonly observers${rig.seats.some(s => s.life === "unknown") ? ", some liveness unknown (retained)" : ""}`);
  }

  private async createPage(owned: OwnedRig, seats: ObserverSeat[]): Promise<void> {
    const label = owned.tabs.length ? `seats ${owned.tabs.length + 1}` : "seats";
    const result = await this.rpc("layout.apply", { workspace_id: owned.workspaceId, tab_label: label, focus: false, root: observerGrid(seats) });
    const layout = record(result.layout);
    const tabId = layout.tab_id;
    if (typeof tabId !== "string") throw new Error("layout returned no tab identity");
    owned.tabs.push(tabId); this.persist();
    const ids: string[] = [];
    const visit = (node: unknown) => { const n = record(node); if (n.type === "pane" && typeof n.pane_id === "string") ids.push(n.pane_id); else if (n.type === "split") { visit(n.first); visit(n.second); } };
    visit(layout.root);
    const native = list<NativePane>((await this.rpc("pane.list", { workspace_id: owned.workspaceId })).panes);
    if (ids.length !== Math.max(1, seats.length)) throw new Error("layout returned incomplete pane identities");
    for (let i = 0; i < ids.length; i++) {
      const pane = native.find(p => p.pane_id === ids[i] && p.tab_id === tabId);
      if (!pane?.terminal_id) throw new Error("created pane could not be verified");
      const seat = seats[i];
      if (!seat) owned.empty = pane;
      else {
        const created = { paneId: pane.pane_id, terminalId: pane.terminal_id, tabId, nodeId: seat.nodeId, occupant: seat.occupant, target: seat.target };
        owned.panes.push(created); this.persist();
        const live = await this.freshPane(owned.workspaceId, created);
        const readonly = await this.verifiedTarget(live, await this.deps.listClients()) === seat.target;
        await this.freshPane(owned.workspaceId, created);
        if (readonly && this.current(seat)) this.deps.bind?.(seat, pane.pane_id);
      }
    }
    this.persist();
  }
}
