// Public adapter for the S01 project-workspace owner used by S05 instance
// initialization. The bytes and behavior live in @openrig/daemon.

import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import {
  ensureDefaultWorkspace,
  workspaceScaffoldDirs,
  workspaceScaffoldFiles,
  type InitWorkspaceResult,
} from "@openrig/daemon/instance-initialization";
import { ConfigStore } from "../config-store.js";
import { registerCatalogProject } from "../lib/jcode-project-catalog.js";

export { workspaceScaffoldDirs, workspaceScaffoldFiles };
export type { InitWorkspaceResult };

export interface InitWorkspaceOpts {
  root?: string;
  /** Deprecated compatibility input. Existing files are always preserved. */
  force?: boolean;
  dryRun?: boolean;
  json?: boolean;
}

export function initWorkspaceCommand(configPath?: string): Command {
  const cmd = new Command("init-workspace")
    .description("Scaffold a repo-ready project workspace")
    .option("--root <path>", "Override workspace root (default: workspace.root setting)")
    .option("--force", "Deprecated compatibility flag; existing files are still preserved")
    .option("--dry-run", "Show what would be created without writing")
    .option("--json", "JSON output")
    .action((opts: InitWorkspaceOpts) => {
      try {
        const effectiveJson = opts.json ?? Boolean(cmd.optsWithGlobals().json);
        const result = runInitWorkspace({ ...opts, json: effectiveJson, configPath });
        if (effectiveJson) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          if (result.dryRun) console.log(`(dry-run) workspace root: ${result.root}`);
          else console.log(`workspace root: ${result.root}`);
          for (const sub of result.subdirs) {
            console.log(`  ${sub.created ? "+" : " "} ${sub.name}/`);
          }
          for (const file of result.files) {
            console.log(`  ${file.created ? "+" : " "} ${file.relPath}${file.skipped ? `  (skipped: ${file.skipped})` : ""}`);
          }
          if (result.project) console.log(`project: ${result.project.id}${result.project.added ? " (added to your project list)" : ""}`);
          if (result.dryRun) console.log("(dry-run; no files written.)");
        }
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });
  return cmd;
}

export function runInitWorkspace(opts: InitWorkspaceOpts & { configPath?: string }): InitWorkspaceResult & { project?: { id: string; added: boolean } } {
  const store = new ConfigStore(opts.configPath);
  const defaultRoot = store.get("workspace.root") as string;
  const root = opts.root ?? defaultRoot;
  const result = ensureDefaultWorkspace({ root, dryRun: !!opts.dryRun });
  if (!result.ok) {
    const detail = result.conflicts
      .map((conflict) => `${conflict.path}: expected ${conflict.expected}, found ${conflict.actual}`)
      .join("; ");
    throw new Error(`Workspace initialization blocked: ${detail}`);
  }
  // A repo given with --root becomes a project, so the TUI and rig scope find it.
  const catalog = store.get("workspace.catalog_path") as string;
  if (opts.dryRun || !opts.root || path.resolve(opts.root) === path.resolve(defaultRoot)
    || !fs.existsSync(path.dirname(catalog))) return result;
  return { ...result, project: registerCatalogProject(catalog, path.resolve(opts.root)) };
}
