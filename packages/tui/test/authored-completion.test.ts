import { expect, it } from "vitest";
import { demoSnapshot } from "../src/demo-data.js";
import { authoredCompletion, scopesExplorerRows, type MissionScopesSnap, type SliceScopeSnap } from "../src/scopes/scopes-model.js";
import { executionContentLines, type ExecutionViewSnap } from "../src/execution/execution-model.js";
import { createViewState } from "../src/state.js";
import { renderScreen } from "../src/render.js";

function fixture(verdict = "pass-with-residue") {
  const snap = demoSnapshot();
  const slices = ["one", "two"].map(id => ({ ...snap.scopes![0]!.slices[0]!, id, dirName: id,
    status: "done", stage: "closed", readiness: { configured: false, state: "legacy", revision: "unchanged", items: [] },
    proofReport: { file: "PROOF.md", verdict } }));
  const mission: MissionScopesSnap = { mission: "cleanup", slices };
  const execution: ExecutionViewSnap = { view: "execution", mission: "cleanup", sources: {}, q1_lanes: [], q2_sequencing: [], q4_ladder: slices.map(s => ({ slice_id: s.id, dir: s.dirName })), q5_park: [] };
  return { snap, mission, execution };
}

it.each(["pass", "PASS", "pass-with-residue"])("reports authored completion for %s without changing proof data", verdict => {
  const { mission, execution } = fixture(verdict);
  const before = JSON.stringify(mission);
  const expected = `2 of 2 done, ${verdict.toLowerCase() === "pass-with-residue" ? "closed with residue" : "pass"}`;
  expect(authoredCompletion(mission.slices)).toBe(expected);
  const text = executionContentLines(execution, [mission], [], null, 140).map(l => l.text).join("\n");
  expect(text).toContain(expected);
  expect(text).toContain("formal item proof not recorded");
  expect(text).toContain("nothing left to do");
  expect(text).not.toMatch(/OUTCOMES OPEN|proof unknown|LIFECYCLE|eligibility unknown|no open slice work/);
  expect(JSON.stringify(mission)).toBe(before);
});

it.each(["missing", "template", "fail", "unknown", "blocked", "unavailable", "formal-pending", "formal-rejected", "formal-accepted"])("does not hide incomplete or conflicting %s evidence", edge => {
  const { mission } = fixture();
  const slice: SliceScopeSnap = mission.slices[0]!;
  if (edge === "missing") slice.proofReport = null;
  if (edge === "template") slice.proofReport!.verdict = null;
  if (edge === "fail" || edge === "unknown") slice.proofReport!.verdict = edge;
  if (edge === "blocked") slice.status = "blocked";
  if (edge === "unavailable") slice.error = "source unavailable";
  if (edge.startsWith("formal-")) slice.readiness = { configured: true, state: edge === "formal-accepted" ? "ready" : "unknown", revision: "formal", items: [{ id: "item", index: 1, text: "Check", state: edge.slice(7), reason: "Recorded", judgment: null }] };
  expect(authoredCompletion(mission.slices)).toBeNull();
  expect(authoredCompletion([])).toBeNull();
});

it("does not say nothing left to do when live correction work remains", () => {
  const { mission, execution } = fixture();
  execution.q2_sequencing = [{ slice_id: "one", dir: "one", work_rows: [{ state: "in-progress", seat: "owner@rig" }] }];
  const text = executionContentLines(execution, [mission], [], null, 140).map(l => l.text).join("\n");
  expect(text).not.toContain("nothing left to do");
  expect(text).toContain("assigned");
});

it("retains residue from an explicit report detail when its short verdict is pass", () => {
  const { mission } = fixture("pass");
  mission.slices[0]!.proofReport = { file: "PROOF.md", verdict: "pass", detail: "PASS with residue: owner confirmation remains" };
  expect(authoredCompletion(mission.slices)).toBe("2 of 2 done, closed with residue");
});

it.each(["subset", "duplicate", "mission-error"])("does not certify the whole mission from a %s projection", edge => {
  const { mission, execution } = fixture();
  if (edge === "subset") execution.q4_ladder = [execution.q4_ladder[0]!];
  if (edge === "duplicate") execution.q4_ladder = [execution.q4_ladder[0]!, execution.q4_ladder[0]!];
  if (edge === "mission-error") mission.error = "incomplete read";
  const text = executionContentLines(execution, [mission], [], null, 140).map(l => l.text).join("\n");
  expect(text).not.toContain("closed with residue");
  expect(text).not.toContain("nothing left to do");
});

it.each([[140, 42], [84, 28]])("uses the same wording on project mission rows and opened mission at %ix%i", (cols, rows) => {
  const { snap, mission, execution } = fixture();
  snap.scopes = [mission];
  snap.execution = execution;
  snap.executionMission = "cleanup";
  snap.hydratedAt = new Date().toISOString();
  const project = { id: "fixture", name: "Fixture", root: "/fixture", sourcePath: "/fixture/project.yaml" };
  snap.projects = { catalogPath: "/catalog", projects: [project] };
  snap.projectRead = { id: project.id, root: project.root };
  const view = createViewState({ instanceId: "headline", getSnapshot: () => snap });
  view.dispatch({ type: "project-select", id: project.id });
  expect(renderScreen(view.get(), snap, { cols, rows }).lines.join("\n")).toContain("2 of 2 done, closed with residue");
  expect(scopesExplorerRows([mission], new Set(), "")[0]!.label).toContain("2 of 2 done, closed with residue");
  view.dispatch({ type: "scopes-mission-open", mission: "cleanup" });
  const text = renderScreen(view.get(), snap, { cols, rows }).lines.join("\n");
  expect(text).toContain("2 of 2 done, closed with residue");
  expect(text).toContain("formal item proof not recorded");
  expect(text).not.toContain("OUTCOMES OPEN");
});
