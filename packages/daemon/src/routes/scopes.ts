import { listProjects, selectedProject, projectReadResponse, projectMission, workSource, insideProject } from "../domain/workspace/project-read.js";
// SCOPES VIEW (sealed plan d64d2f5c) — the store-direct read routes behind the scopes TUI.
// GET /api/scopes?mission=X          -> mission slice summaries (cards/counts/locks)
// GET /api/scopes/slice?mission=&slice= -> the full detail (intent/mini-reqs/contract+drops)
// GET /api/scopes/narrative?mission=&slice= -> PROGRESS.md RAW for the `n` DISPLAY only
// Data path: README frontmatter locks + proof/ C1 drops — never PROGRESS.md for counts.
import { Hono } from "hono";
import { proofSourceObservation } from "../domain/proof/source-watch.js";
import { createProofPolicyRead, readMissionReadiness } from "../domain/proof/judgments.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse } from "yaml";
import type { SliceIndexer } from "../domain/slices/slice-indexer.js";
import { projectSliceScope, type ScopeFsDeps, type SliceScopeDetail } from "../domain/scope/scope-view-projection.js";

const realFs: ScopeFsDeps = {
  readBytes: p => { try { return fs.readFileSync(p); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; } },
  exists: (p) => fs.existsSync(p),
  readFile: (p) => { try { return fs.readFileSync(p, "utf-8"); } catch { return null; } },
  listDir: (p) => { try { return fs.readdirSync(p); } catch { return []; } },
  isDirectory: (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } },
};

function rootOf(c: Parameters<typeof selectedProject>[0]): { root: string } | { error: Response } {
  const selected = selectedProject(c);
  if (selected) return { root: selected.missionsRoot };
  const indexer = c.get("sliceIndexer" as never) as SliceIndexer | undefined;
  if (!indexer) return { error: Response.json({ error: "slices_indexer_unavailable" }, { status: 503 }) };
  if (!indexer.isReady()) return { error: Response.json({ error: "slices_root_not_configured" }, { status: 503 }) };
  return { root: indexer.slicesRoot };
}

export function scopesRoutes(): Hono {
  const app = new Hono();
  app.get("/projects", c => { try { return c.json(listProjects(c)); } catch (err) { return projectReadResponse(err); } });
  app.onError(err => projectReadResponse(err));

  app.get("/", (c) => {
    const r = rootOf(c);
    if ("error" in r) return r.error;
    const selected = selectedProject(c);
    const mission = c.req.query("mission");
    if (selected && mission) projectMission(selected, mission);
    const wantDetail = c.req.query("detail") === "1";
    const readPolicy = createProofPolicyRead();
    const detailFor = (missionName: string, dirName: string): (SliceScopeDetail & { narrative: string | null; error?: string }) | null => {
      let sourcePath: string | undefined;
      try {
        if (selected) sourcePath = workSource(selected.root, path.join(r.root, missionName, "slices", dirName), false);
        if (selected) workSource(selected.root, path.join(r.root, missionName, "slices", dirName));
        const report = path.join(r.root, missionName, "slices", dirName, "PROOF.md");
        if (selected && realFs.exists(report)) insideProject(selected.root, report);
        const d = projectSliceScope(realFs, path.join(r.root, missionName, "slices", dirName), readPolicy);
        if (!d) return null;
        // The TUI one-read hydrate: narrative CONTENT rides inline for the `n` DISPLAY —
        // still never a data source (the projection never reads it for counts).
        const narrative = d.progressPath ? realFs.readFile(d.progressPath) : null;
        return { ...d, narrative, ...(selected ? { sourcePath: workSource(selected.root, path.join(r.root, missionName, "slices", dirName)) } : {}) };
      } catch (err) {
        return { dirName, id: null, displayName: dirName, error: (err as Error).message, ...(sourcePath ? { sourcePath } : {}),
          status: null, stage: null, locks: { spec: null, delivery: null }, proof: { paired: 0, total: 0 },
          intent: "", miniRequirements: [], proofContract: [], progressPath: null, specShaShort: null, prdExists: false, narrative: null };
      }
    };
    const missionFor = (name: string) => {
      if (selected) projectMission(selected, name);
      const dir = path.join(r.root, name);
      const manifestPath = path.join(dir, "mission.yaml");
      if (realFs.exists(manifestPath)) insideProject(selected?.root ?? r.root, manifestPath);
      const manifest = realFs.readFile(manifestPath);
      const authored = manifest ? parse(manifest)?.composition?.mission_markdown?.spec : null;
      const source = typeof authored === "string" ? path.resolve(dir, authored)
        : ["SPEC.md", "README.md"].map(file => path.join(dir, file)).find(file => realFs.exists(file));
      let declaration = null;
      if (source) {
        insideProject(selected?.root ?? r.root, source);
        const content = realFs.readFile(source);
        const match = content && /^---\s*\n([\s\S]*?)\n---/.exec(content);
        const metadata = match ? parse(match[1]!) : null;
        declaration = { sourcePath: source, stage: typeof metadata?.stage === "string" ? metadata.stage : null,
          status: typeof metadata?.status === "string" ? metadata.status : null };
      }
      const slices = realFs.listDir(path.join(dir, "slices"))
        .filter(s => realFs.isDirectory(path.join(dir, "slices", s)))
        .map(s => detailFor(name, s)).filter((s): s is NonNullable<typeof s> => s !== null);
      return { mission: name, declaration, slices: wantDetail ? slices : slices.map(({ intent, miniRequirements, proofContract, progressPath, specShaShort, prdExists, narrative, ...summary }) => summary), readiness: readMissionReadiness(dir, readPolicy) };
    };
    if (mission) {
      if (!realFs.isDirectory(path.join(r.root, mission))) return c.json({ error: "mission_not_found", mission }, 404);
      return c.json(missionFor(mission));
    }
    // No mission param: list every mission (the explorer tree); ?detail=1 upgrades rows to details.
    const missionNames = realFs.listDir(r.root).filter((e) => realFs.isDirectory(path.join(r.root, e)));
    const readErrors: string[] = [];
    const sources: Record<string, string> = {};
    const missions = missionNames.map(name => {
      try {
        if (selected) sources[name] = workSource(selected.root, path.join(r.root, name), false);
        return missionFor(name);
      } catch (err) { return { mission: name, slices: [], error: (err as Error).message }; }
    });
    return c.json({ missions, sources, readErrors, project: selected, sourceObservation: proofSourceObservation(c) });
  });

  app.get("/slice", (c) => {
    const r = rootOf(c);
    if ("error" in r) return r.error;
    const selected = selectedProject(c);
    const mission = c.req.query("mission");
    if (selected && mission) projectMission(selected, mission);
    const slice = c.req.query("slice");
    if (selected && slice && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(slice)) return c.json({ error: "invalid_slice" }, 400);
    if (!mission || !slice) return c.json({ error: "missing_params", hint: "?mission=&slice=" }, 400);
    if (selected && slice) workSource(selected.root, path.join(r.root, mission!, "slices", slice));
    const report = path.join(r.root, mission, "slices", slice, "PROOF.md");
    if (selected && realFs.exists(report)) insideProject(selected.root, report);
    const detail = projectSliceScope(realFs, path.join(r.root, mission, "slices", slice));
    return detail ? c.json(detail) : c.json({ error: "slice_not_found", mission, slice }, 404);
  });

  app.get("/narrative", (c) => {
    const r = rootOf(c);
    if ("error" in r) return r.error;
    const selected = selectedProject(c);
    const mission = c.req.query("mission");
    if (selected && mission) projectMission(selected, mission);
    const slice = c.req.query("slice");
    if (selected && slice && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(slice)) return c.json({ error: "invalid_slice" }, 400);
    if (!mission || !slice) return c.json({ error: "missing_params", hint: "?mission=&slice=" }, 400);
    const p = path.join(r.root, mission, "slices", slice, "PROGRESS.md");
    if (selected) insideProject(selected.root, p);
    const content = realFs.readFile(p);
    // The narrative DISPLAY (plan atom 3): raw artifact bytes; explicitly not a data source.
    return content !== null ? c.json({ path: p, content }) : c.json({ error: "narrative_not_found" }, 404);
  });

  return app;
}
