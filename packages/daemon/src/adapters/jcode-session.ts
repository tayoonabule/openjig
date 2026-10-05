import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import nodePath from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ActivityEvidence } from "../domain/activity-taxonomy.js";

export interface JcodeSessionFs {
  readFile(path: string): string;
  exists(path: string): boolean;
  listFiles(dir: string): string[];
}

export interface JcodeSession {
  id: string;
  workingDir: string;
  createdAt: number;
  status?: string;
}

export const defaultJcodeSessionFs: JcodeSessionFs = {
  readFile: (path) => fs.readFileSync(path, "utf-8"),
  exists: (path) => fs.existsSync(path),
  listFiles: (path) => fs.readdirSync(path),
};

export async function defaultJcodeDebugSessions(socket: string): Promise<string> {
  const { stdout } = await promisify(execFile)("jcode", ["debug", "sessions", "--socket", socket], {
    encoding: "utf-8", timeout: 1500,
  });
  return stdout;
}

export function jcodeRuntimeDir(stateRoot: string, sessionName: string): string {
  return nodePath.join(stateRoot, sessionName, "runtime");
}

/** How long one jcode self-report stays authoritative. The sweep polls at 1Hz, so a live
 *  socket refreshes it long before this; a dead socket's last answer expires and the seat
 *  falls back to sampling instead of freezing on a stale verdict. */
export const JCODE_SELF_REPORT_VALID_MS = 5_000;

/** One `debug_command: sessions` round trip on the seat's debug socket, in-process (no
 *  `jcode` child per poll). Resolves the raw JSON output string, or null on any failure. */
export function queryJcodeDebugSocket(socketPath: string, timeoutMs = 750): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    let buf = "";
    const sock = net.createConnection(socketPath);
    const done = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    if (typeof timer === "object" && "unref" in timer) timer.unref();
    sock.on("connect", () => {
      sock.write(JSON.stringify({ type: "debug_command", id: 1, command: "sessions" }) + "\n");
    });
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf-8");
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      try {
        const reply = JSON.parse(buf.slice(0, nl)) as { type?: unknown; ok?: unknown; output?: unknown };
        done(reply.type === "debug_response" && reply.ok === true && typeof reply.output === "string" ? reply.output : null);
      } catch {
        done(null);
      }
    });
    sock.on("error", () => done(null));
    sock.on("close", () => done(null));
  });
}

/** jcode member statuses that mean "at the prompt, no turn in flight" once not processing:
 *  `ready`, plus the terminal outcomes of the last turn (`stopped` after an interrupt,
 *  `completed`, `failed`). */
const JCODE_AT_PROMPT_STATUSES = new Set(["ready", "stopped", "completed", "failed"]);

/** Map the seat's `sessions` rows to working/idle. Any processing session ⇒ working; every
 *  session at the prompt and not processing ⇒ idle-at-prompt; anything else (unknown
 *  vocabulary, no rows) ⇒ null so the ladder falls through rather than guessing. */
export function jcodeActivityFromSessions(output: string): "working" | "idle-at-prompt" | null {
  let rows: unknown;
  try { rows = JSON.parse(output); } catch { return null; }
  if (!Array.isArray(rows) || rows.length === 0) return null;
  let allReady = true;
  for (const row of rows) {
    if (!row || typeof row !== "object") return null;
    const r = row as { status?: unknown; is_processing?: unknown };
    if (r.is_processing === true || r.status === "running") return "working";
    if (typeof r.status !== "string" || !JCODE_AT_PROMPT_STATUSES.has(r.status) || r.is_processing !== false) allReady = false;
  }
  return allReady ? "idle-at-prompt" : null;
}

/** The jcode self-report rung: the seat-scoped debug socket is jcode's own statement of
 *  whether a turn is in flight. Unreadable/absent socket ⇒ null (the rung stales). */
export async function readJcodeSelfReportEvidence(input: {
  stateRoot: string;
  sessionName: string;
  seatNodeId: string;
  now?: () => Date;
  query?: (socketPath: string) => Promise<string | null>;
  exists?: (path: string) => boolean;
}): Promise<ActivityEvidence | null> {
  const socket = nodePath.join(jcodeRuntimeDir(input.stateRoot, input.sessionName), "jcode-debug.sock");
  if (!(input.exists ?? fs.existsSync)(socket)) return null;
  const output = await (input.query ?? queryJcodeDebugSocket)(socket);
  if (output === null) return null;
  const activity = jcodeActivityFromSessions(output);
  if (!activity) return null;
  const at = (input.now ?? (() => new Date()))();
  return {
    seatNodeId: input.seatNodeId,
    sessionName: input.sessionName,
    rung: "self-report",
    sourceId: "jcode:debug-socket",
    seq: at.getTime(),
    observedAt: at.toISOString(),
    activity,
    validForMs: JCODE_SELF_REPORT_VALID_MS,
  };
}

export function readJcodeDebugSessions(socket: string, exec: (socket: string) => string | Promise<string>): Promise<JcodeSession[]> {
  return Promise.resolve().then(() => exec(socket)).then((output) => {
    const entries: unknown = JSON.parse(output);
    if (!Array.isArray(entries)) return [];
    return entries.flatMap((entry: unknown) => {
      if (!entry || typeof entry !== "object") return [];
      const row = entry as Record<string, unknown>;
      if (typeof row.session_id !== "string" || typeof row.working_dir !== "string") return [];
      return [{ id: row.session_id, workingDir: row.working_dir, createdAt: 0,
        status: typeof row.status === "string" ? row.status : undefined }];
    });
  }).catch(() => []);
}

function timestamp(value: unknown): number {
  if (typeof value === "number") return value < 1e11 ? value * 1000 : value;
  if (typeof value === "string") {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? timestamp(number) : Date.parse(value);
  }
  return NaN;
}

/** jcode names a session file `<id>.json` and embeds the creation time (ms) in the id: session_<name>_<ms>_<hex>. */
const SESSION_FILE = /^(session_.+_(\d{13})_[0-9a-f]+)\.json$/;

export interface ScanJcodeSessionsOptions {
  /** Skip sessions created before this time (ms) without opening them. */
  since?: number;
  /** Return only ids (taken from file names where possible) and never open session files. */
  idsOnly?: boolean;
}

/**
 * Session files can be hundreds of MB (they hold the whole transcript). Reading and parsing all of them on
 * the daemon's single thread starved the event loop for seconds to minutes, so every health/CLI/TUI request
 * timed out. Use the id/timestamp in the file name and only open files that could still match.
 */
export function scanJcodeSessions(fsOps: JcodeSessionFs, home: string, options: ScanJcodeSessionsOptions = {}): JcodeSession[] {
  const dir = nodePath.join(home, ".jcode", "sessions");
  try {
    return fsOps.listFiles(dir).filter((name) => name.endsWith(".json")).flatMap((name) => {
      const named = SESSION_FILE.exec(name);
      if (named) {
        const createdAt = Number(named[2]);
        if (options.idsOnly) return [{ id: named[1]!, workingDir: "", createdAt }];
        if (options.since !== undefined && createdAt < options.since) return [];
      }
      try {
        const row: unknown = JSON.parse(fsOps.readFile(nodePath.join(dir, name)));
        if (!row || typeof row !== "object") return [];
        const entry = row as Record<string, unknown>;
        const createdAt = timestamp(entry.created_at);
        if (typeof entry.id !== "string" || typeof entry.working_dir !== "string" || !Number.isFinite(createdAt)) return [];
        return [{ id: entry.id, workingDir: entry.working_dir, createdAt }];
      } catch { return []; }
    });
  } catch { return []; }
}

export interface JcodeSessionReaderOptions {
  stateRoot: string;
  fsOps?: JcodeSessionFs;
  execDebug?: (socket: string) => string | Promise<string>;
  home?: string;
}

/** The debug socket belongs to one seat; persisted session files are shared across seats. */
export class JcodeSessionReader {
  private fs: JcodeSessionFs;
  private execDebug: (socket: string) => string | Promise<string>;
  private home: string;
  constructor(private options: JcodeSessionReaderOptions) {
    this.fs = options.fsOps ?? defaultJcodeSessionFs;
    this.execDebug = options.execDebug ?? defaultJcodeDebugSessions;
    this.home = options.home ?? os.homedir();
  }

  async debug(sessionName: string): Promise<JcodeSession[]> {
    const socket = nodePath.join(jcodeRuntimeDir(this.options.stateRoot, sessionName), "jcode.sock");
    if (!this.fs.exists(socket)) return [];
    return readJcodeDebugSessions(socket, this.execDebug);
  }

  async capture(sessionName: string, cwd?: string, since = 0, priorIds: ReadonlySet<string> = new Set()): Promise<string | undefined> {
    const debug = await this.debug(sessionName);
    const live = debug.filter((row) => !cwd || nodePath.resolve(row.workingDir) === nodePath.resolve(cwd));
    // The seat-scoped socket is authoritative even before the session JSON is flushed.
    if (debug.length) return live.length === 1 && !priorIds.has(live[0]!.id) ? live[0]!.id : undefined;
    const files = scanJcodeSessions(this.fs, this.home, { since })
      .filter((row) => !priorIds.has(row.id) && (!cwd || nodePath.resolve(row.workingDir) === nodePath.resolve(cwd)) && row.createdAt >= since)
      .sort((a, b) => b.createdAt - a.createdAt);
    // Shared session files do not identify an owning seat when two seats start in one cwd.
    if (files.length === 1 && cwd && since > 0) return files[0]!.id;
    return undefined;
  }
}

/**
 * The model jcode will restore on `--resume`: the session file's top-level `model`, which jcode writes
 * right after `provider_key` and after the (possibly huge) messages array. Read only the tail so a
 * 150MB transcript is never loaded. Returns null when unknown, so callers keep their safe hold.
 */
export function readSavedJcodeModel(home: string, resumeToken: string): string | null {
  if (!/^session_[A-Za-z0-9_]+$/.test(resumeToken)) return null;
  const file = nodePath.join(home, ".jcode", "sessions", `${resumeToken}.json`);
  let fd: number | undefined;
  try {
    const size = fs.statSync(file).size;
    const length = Math.min(size, 256 * 1024);
    const buffer = Buffer.alloc(length);
    fd = fs.openSync(file, "r");
    fs.readSync(fd, buffer, 0, length, size - length);
    const match = /"provider_key":(?:"[^"]*"|null),"model":"([^"]+)"/.exec(buffer.toString("utf-8"));
    return match?.[1] ?? null;
  } catch { return null; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ } }
}
