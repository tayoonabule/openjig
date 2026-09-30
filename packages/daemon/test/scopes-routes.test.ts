// SCOPES VIEW routes — wired through a Hono app with a fixture slices root.
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { scopesRoutes } from "../src/routes/scopes.js";

function scaffold(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scopes-rt-"));
  const sliceDir = path.join(root, "release-x", "slices", "01-thing");
  fs.mkdirSync(path.join(sliceDir, "proof"), { recursive: true });
  fs.writeFileSync(path.join(sliceDir, "README.md"), `---
id: OPR.X.1
status: spec
stage: building
approved-spec-by: pm@x
approved-spec-at: 2026-08-06T10:00:00.000Z
---

# Slice 01 — thing

## Intent

Do the thing.

## Mini-requirements

1. It works.

## Proof contract

- [ ] Works — captured.
- [ ] Survives restart — captured.
`);
  fs.writeFileSync(path.join(sliceDir, "proof", "qa.md"), `---
artifact_type: qa
verdict: PASS
evidences:
  - "1"
---
x`);
  fs.writeFileSync(path.join(sliceDir, "PROGRESS.md"), "narrative only");
  return root;
}

function appWith(root: string): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("sliceIndexer" as never, { isReady: () => true, slicesRoot: root } as never);
    await next();
  });
  app.route("/api/scopes", scopesRoutes());
  return app;
}

describe("scopes routes", () => {
  it("serves the labeled authored proof report separately from item judgments", async () => {
    const root = scaffold(), slice = path.join(root, "release-x/slices/01-thing");
    try {
      fs.writeFileSync(path.join(slice, "PROOF.md"), "# Proof\n\nClosed by: qa@rig   Verdict: **pass-with-residue** (owner accepted the caveat)\n");
      const response = await (await appWith(root).request("/api/scopes/slice?mission=release-x&slice=01-thing")).json() as any;
      expect(response.proofReport).toEqual({ file: "PROOF.md", verdict: "pass-with-residue", detail: "pass-with-residue (owner accepted the caveat)" });
      expect(response.readiness.configured).toBe(false);
      expect(response.readiness.state).toBe("legacy");
      fs.writeFileSync(path.join(slice, "PROOF.md"), "# Example\nPASS is only a test fixture here, not a verdict.\n");
      const unlabeled = await (await appWith(root).request("/api/scopes/slice?mission=release-x&slice=01-thing")).json() as any;
      expect(unlabeled.proofReport).toEqual({ file: "PROOF.md", verdict: null, detail: null });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it.each([
    ["Closed by: <seat>   Date: <date>   Verdict: <pass | pass-with-residue | ...>", null, null],
    ["```text\nVerdict: PASS\n```\n> Verdict: FAIL\n", null, null],
    ["  ```text\n  Verdict: PASS\n  ```\n", null, null],
    ["   > Verdict: FAIL\n", null, null],
    ["```text\nVerdict: PASS\n", null, null],
    ["~~~text\nVerdict: FAIL\n", null, null],
    ["    Verdict: PASS\n", null, null],
    ["**Verdict:** Content checks pass. Client approval remains open.", "content", "Content checks pass. Client approval remains open."],
    ["Verdict: **PASS with residue**", "pass", "PASS with residue"],
    ["Closed by: qa   Verdict: BLOCKING / NOT-CLEAR product acceptance", "blocking", "BLOCKING / NOT-CLEAR product acceptance"],
    ["---\nverdict: PASS\n---\n# Proof", "pass", "PASS"],
  ])("preserves the explicitly authored report without inventing template authority: %s", async (content, verdict, detail) => {
    const root = scaffold();
    try {
      fs.writeFileSync(path.join(root, "release-x/slices/01-thing/PROOF.md"), content!);
      const body = await (await appWith(root).request("/api/scopes/slice?mission=release-x&slice=01-thing")).json() as any;
      expect(body.proofReport).toEqual({ file: "PROOF.md", verdict, detail });
      expect(body.readiness.configured).toBe(false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it("reads the manifest-selected mission source stage without upgrading acceptance", async () => {
    const root = scaffold(), mission = path.join(root, "release-x");
    try {
      fs.writeFileSync(path.join(mission, "SPEC.md"), "---\nstage: done\n---\n# Stale source\n");
      fs.writeFileSync(path.join(mission, "INTAKE.md"), "---\nstage: wip\n---\n# Selected source\n");
      fs.writeFileSync(path.join(mission, "mission.yaml"), "composition:\n  mission_markdown:\n    spec: INTAKE.md\n  slices: []\n");
      const body = await (await appWith(root).request("/api/scopes?mission=release-x")).json() as any;
      expect(body.declaration).toEqual({ sourcePath: path.join(mission, "INTAKE.md"), stage: "wip", status: null });
      expect(body.readiness.historicalStatus).toBeNull();
      fs.writeFileSync(path.join(mission, "INTAKE.md"), "# Body-only intake\n");
      const unstructured = await (await appWith(root).request("/api/scopes?mission=release-x")).json() as any;
      expect(unstructured.declaration.stage).toBeNull();
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it("overview + detail + narrative serve store-direct", async () => {
    const root = scaffold();
    const app = appWith(root);
    const overview = await (await app.request("/api/scopes")).json() as { missions: Array<{ mission: string; slices: Array<{ proof: { paired: number; total: number } }> }> };
    expect(overview.missions[0]!.mission).toBe("release-x");
    expect(overview.missions[0]!.slices[0]!.proof).toEqual({ paired: 1, total: 2 });
    const detail = await (await app.request("/api/scopes/slice?mission=release-x&slice=01-thing")).json() as { intent: string; proofContract: Array<{ paired: boolean }> };
    expect(detail.intent).toBe("Do the thing.");
    expect(detail.proofContract.map((p) => p.paired)).toEqual([true, false]);
    const narrative = await (await app.request("/api/scopes/narrative?mission=release-x&slice=01-thing")).json() as { content: string };
    expect(narrative.content).toBe("narrative only");
    fs.rmSync(root, { recursive: true, force: true });
  });
});
