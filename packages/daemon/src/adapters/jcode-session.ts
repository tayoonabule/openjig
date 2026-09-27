import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

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

export function scanJcodeSessions(fsOps: JcodeSessionFs, home: string): JcodeSession[] {
  const dir = nodePath.join(home, ".jcode", "sessions");
  try {
    return fsOps.listFiles(dir).filter((name) => name.endsWith(".json")).flatMap((name) => {
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
    const files = scanJcodeSessions(this.fs, this.home)
      .filter((row) => !priorIds.has(row.id) && (!cwd || nodePath.resolve(row.workingDir) === nodePath.resolve(cwd)) && row.createdAt >= since)
      .sort((a, b) => b.createdAt - a.createdAt);
    // Shared session files do not identify an owning seat when two seats start in one cwd.
    if (files.length === 1 && cwd && since > 0) return files[0]!.id;
    return undefined;
  }
}
