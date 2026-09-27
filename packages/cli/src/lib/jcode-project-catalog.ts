// openjig: the workspace.yaml project catalog, so a repo can be added as a
// project and found again from inside it without hand-editing YAML.

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

type CatalogEntry = { id: string; root: string };

function readEntries(catalogPath: string): { doc: Record<string, unknown>; entries: CatalogEntry[] } {
  if (!fs.existsSync(catalogPath)) return { doc: { schema: "openrig.workspace/v0alpha1", projects: [] }, entries: [] };
  const doc = (YAML.parse(fs.readFileSync(catalogPath, "utf8")) ?? {}) as Record<string, unknown>;
  const entries = Array.isArray(doc.projects) ? doc.projects as CatalogEntry[] : [];
  return { doc, entries };
}

function resolveRoot(catalogPath: string, root: string): string {
  const nominal = path.resolve(path.dirname(catalogPath), root);
  try { return fs.realpathSync(nominal); } catch { return nominal; }
}

/** Add `root` to the catalog under a unique id derived from its folder name. Idempotent. */
export function registerCatalogProject(catalogPath: string, root: string): { id: string; added: boolean } {
  const { doc, entries } = readEntries(catalogPath);
  const target = resolveRoot(catalogPath, root);
  const existing = entries.find((e) => resolveRoot(catalogPath, e.root) === target);
  if (existing) return { id: existing.id, added: false };
  const base = path.basename(target).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
  let id = base;
  for (let n = 2; entries.some((e) => e.id === id); n++) id = `${base}-${n}`;
  doc.projects = [...entries, { id, root: target }];
  fs.writeFileSync(catalogPath, YAML.stringify(doc));
  return { id, added: true };
}

/** The catalogued project root containing `cwd` (deepest match), if any. */
export function catalogProjectRootFor(catalogPath: string, cwd: string): string | null {
  let entries: CatalogEntry[];
  try { entries = readEntries(catalogPath).entries; } catch { return null; }
  const here = resolveRoot(catalogPath, cwd);
  const roots = entries.map((e) => resolveRoot(catalogPath, e.root))
    .filter((root) => here === root || here.startsWith(root + path.sep))
    .sort((a, b) => b.length - a.length);
  return roots[0] ?? null;
}
