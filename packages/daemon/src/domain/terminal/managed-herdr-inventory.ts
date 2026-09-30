import type Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import type { TmuxAdapter } from "../../adapters/tmux.js";
import { listNativeProcesses, type NativeProcessRow } from "../native-process-lineage.js";
import type { ObserverClient, ObserverRig, ObserverSeat } from "./managed-herdr-views.js";

const exec = promisify(execFile);
interface SeatRow {
  rig_id: string; node_id: string; logical_id: string; runtime: string | null;
  occupant: string | null; session_name: string | null; status: string | null;
  running_count: number; startup_status: string | null;
  binding_id: string | null; tmux_session: string | null; tmux_pane: string | null;
  attachment_type: string | null; updated_at: string | null;
}
const SEATS_SQL = `SELECT n.rig_id, n.id AS node_id, n.logical_id, n.runtime,
  s.id AS occupant, s.session_name, s.status, s.startup_status,
  (SELECT COUNT(*) FROM sessions active WHERE active.node_id=n.id AND active.status='running') AS running_count,
  b.id AS binding_id, b.tmux_session, b.tmux_pane, b.attachment_type, b.updated_at
  FROM nodes n LEFT JOIN sessions s ON s.id = COALESCE(
    (SELECT active.id FROM sessions active WHERE active.node_id=n.id AND active.status='running' ORDER BY active.id DESC LIMIT 1),
    (SELECT prior.id FROM sessions prior WHERE prior.node_id=n.id ORDER BY prior.id DESC LIMIT 1))
  LEFT JOIN bindings b ON b.node_id=n.id`;
const key = (row: SeatRow) => JSON.stringify([row.occupant, row.binding_id, row.tmux_pane, row.updated_at]);
const SHELL = new Set(["sh", "bash", "zsh", "fish", "dash", "tcsh", "csh"]);

/** Positive runtime evidence, and a narrowly proven shell return for natural exit.
 * An empty/ambiguous process observation is NEVER absence. Wrapper descendants
 * are inspected, so /bin/sh hosting a real Jcode TUI is not mistaken for exit. */
export function observerRuntimeLife(rows: NativeProcessRow[], panePid: number | null, runtime: string | null, token?: string | null): ObserverSeat["life"] {
  const root = rows.find(row => row.pid === panePid);
  if (!root) return "unknown";
  if (runtime === "terminal") return "running";
  const descendants: NativeProcessRow[] = [];
  const visit = (pid: number, seen: Set<number>) => {
    if (seen.has(pid)) return;
    seen.add(pid);
    const row = rows.find(row => row.pid === pid);
    if (row) descendants.push(row);
    for (const child of rows.filter(row => row.ppid === pid)) visit(child.pid, seen);
  };
  visit(root.pid, new Set());
  const executable = runtime === "claude-code" ? "claude" : runtime === "jcode" ? "jcode" : runtime === "codex" ? "codex" : null;
  if (!executable) return "unknown";
  for (const row of descendants) {
    const argv = row.command.match(/"[^"]*"|'[^']*'|\S+/g)?.map(v => v.replace(/^['"]|['"]$/g, "")) ?? [];
    if (path.basename(argv[0] ?? "") !== executable) continue;
    if (runtime === "jcode" && argv.includes("serve")) continue;
    const hasResumeSelector = argv.some(arg => ["--resume", "--session-id", "resume"].includes(arg) || arg.startsWith("--resume=") || arg.startsWith("--session-id="));
    const matchesToken = argv.some((arg, i) => ["--resume", "--session-id", "resume"].includes(arg) && argv[i + 1] === token) || argv.includes(`--resume=${token}`) || argv.includes(`--session-id=${token}`);
    // Fresh Jcode TUI launches acquire their saved token after the process starts.
    // Exact pane binding remains the authority; an explicit conflicting resume
    // selector is still unknown, never absence or permission to switch sessions.
    if (token && !matchesToken && !(runtime === "jcode" && !hasResumeSelector && argv[1]?.startsWith("-"))) continue;
    return "running";
  }
  const rootExecutable = path.basename(root.executableName ?? root.command.split(/\s+/)[0] ?? "").replace(/^-/, "");
  // A bare surviving shell with no child processes is positive exit evidence.
  return descendants.length === 1 && SHELL.has(rootExecutable) ? "absent" : "unknown";
}

export function managedViewInventory(db: Database.Database, tmux: Pick<TmuxAdapter, "listSessions" | "getPanePid">) {
  return {
    async listRigs(): Promise<ObserverRig[]> {
      const rigs = db.prepare("SELECT id,name FROM rigs WHERE archived_at IS NULL ORDER BY created_at,id").all() as Array<{ id: string; name: string }>;
      const rows = db.prepare(`${SEATS_SQL} ORDER BY n.rig_id, CASE WHEN n.logical_id LIKE '%.lead' THEN 0 ELSE 1 END, n.logical_id,n.id`).all() as SeatRow[];
      const live = new Set((await tmux.listSessions()).map(session => session.name));
      // Existing shared native process reader performs one bounded snapshot per sweep.
      const processes = await listNativeProcesses();
      const seats = await Promise.all(rows.map(async row => {
        const target = row.tmux_session ?? row.session_name ?? "";
        const seat: ObserverSeat = { nodeId: row.node_id, occupant: key(row), target, label: target.split("@")[0] || row.logical_id, runtime: row.runtime, life: "unknown" };
        if (row.running_count > 1 || row.attachment_type === "external_cli") return seat;
        if (row.status !== "running") { seat.life = "absent"; return seat; }
        if (!target || target !== row.session_name || !row.tmux_pane) return seat;
        if (!live.has(target)) {
          // A successfully populated tmux inventory proves this exact target absent.
          // An empty inventory is also the adapter's transient failure fallback.
          seat.life = live.size ? "absent" : "unknown";
          return seat;
        }
        if (row.startup_status === "pending") return seat;
        const session = db.prepare("SELECT resume_token FROM sessions WHERE id=?").get(row.occupant) as { resume_token: string | null } | undefined;
        seat.life = observerRuntimeLife(processes, await tmux.getPanePid(row.tmux_pane), row.runtime, session?.resume_token);
        return seat;
      }));
      return rigs.map(rig => ({ ...rig, seats: seats.filter((_, index) => rows[index]!.rig_id === rig.id) }));
    },
    isCurrent(seat: ObserverSeat): boolean {
      const row = db.prepare(`${SEATS_SQL} WHERE n.id=?`).get(seat.nodeId) as SeatRow | undefined;
      return !!row && row.running_count <= 1 && key(row) === seat.occupant && (row.tmux_session ?? row.session_name ?? "") === seat.target && (seat.life !== "running" || (row.status === "running" && row.startup_status !== "pending"));
    },
  };
}

/** Exact flags are measured from tmux, not inferred from pane labels or argv. */
export async function listObserverClients(): Promise<ObserverClient[]> {
  const { stdout } = await exec("tmux", ["list-clients", "-F", "#{client_pid}|#{client_session}|#{client_readonly}|#{client_flags}"], { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024 });
  return stdout.split("\n").filter(Boolean).map(line => {
    const [pid, target, readOnly, flags] = line.split("|");
    if (!pid || !target || !/^\d+$/.test(pid) || !["0", "1"].includes(readOnly ?? "") || !flags) throw new Error("unparseable observer client inventory");
    return { pid: Number(pid), target, readOnly: readOnly === "1", ignoreSize: flags.split(",").includes("ignore-size") };
  });
}
