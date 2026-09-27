import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { catalogProjectRootFor, registerCatalogProject } from "../src/lib/jcode-project-catalog.js";
import { resolveMissionsRoot } from "../src/lib/scope/scope-fs.js";
import { runInitWorkspace } from "../src/commands/config-init-workspace.js";

function tmp(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "oj-catalog-")));
}

describe("openjig project catalog", () => {
  it("registers a repo once, keeps existing entries, and dedupes ids", () => {
    const home = tmp();
    const catalog = path.join(home, "workspace.yaml");
    fs.writeFileSync(catalog, "schema: openrig.workspace/v0alpha1\nprojects:\n  - id: default\n    root: .\n");
    const a = path.join(home, "My Repo");
    const b = path.join(home, "other", "my-repo");
    fs.mkdirSync(a); fs.mkdirSync(b, { recursive: true });

    expect(registerCatalogProject(catalog, a)).toEqual({ id: "my-repo", added: true });
    expect(registerCatalogProject(catalog, a)).toEqual({ id: "my-repo", added: false });
    expect(registerCatalogProject(catalog, b)).toEqual({ id: "my-repo-2", added: true });
    const doc = YAML.parse(fs.readFileSync(catalog, "utf8"));
    expect(doc.schema).toBe("openrig.workspace/v0alpha1");
    expect(doc.projects.map((p: { id: string }) => p.id)).toEqual(["default", "my-repo", "my-repo-2"]);
  });

  it("init-workspace --root . registers the repo, not the catalog's own '.' entry", () => {
    const home = tmp();
    const wsRoot = path.join(home, "workspace");
    const repo = path.join(home, "app");
    fs.mkdirSync(wsRoot); fs.mkdirSync(repo);
    const catalog = path.join(wsRoot, "workspace.yaml");
    fs.writeFileSync(catalog, "schema: openrig.workspace/v0alpha1\nprojects:\n  - id: default\n    root: .\n");
    const configPath = path.join(home, "config.json");
    fs.writeFileSync(configPath, JSON.stringify({ workspace: { root: wsRoot, catalogPath: catalog } }));
    const cwd = process.cwd();
    try {
      process.chdir(repo);
      expect(runInitWorkspace({ root: ".", configPath }).project).toEqual({ id: "app", added: true });
    } finally { process.chdir(cwd); }
  });

  it("rig scope finds the catalogued project containing cwd, with no --workspace", () => {
    const home = tmp();
    const repo = path.join(home, "repo");
    fs.mkdirSync(path.join(repo, "missions"), { recursive: true });
    fs.mkdirSync(path.join(repo, "src"));
    const catalog = path.join(home, "workspace.yaml");
    registerCatalogProject(catalog, repo);
    const fallback = path.join(home, "default-missions");
    fs.mkdirSync(fallback);
    const configPath = path.join(home, "config.json");
    fs.writeFileSync(configPath, JSON.stringify({ workspace: { catalogPath: catalog, slicesRoot: fallback } }));

    expect(catalogProjectRootFor(catalog, path.join(repo, "src"))).toBe(repo);
    expect(resolveMissionsRoot({ cwd: path.join(repo, "src"), configPath })).toBe(path.join(repo, "missions"));
    expect(resolveMissionsRoot({ cwd: home, configPath })).toBe(fallback);
  });
});
