import { expect, it } from "vitest";
import { DaemonClient } from "../src/daemon-client.js";
import { hydrateSnapshot } from "../src/hydrate.js";
import { createViewState, emptySnapshot, computeExplorerRows } from "../src/state.js";
import { attentionLines } from "../src/attention/attention-model.js";
import { parseCommand } from "../src/grammar.js";
import type { AttentionRead } from "@openrig/daemon/attention";
import type { FleetSnapshot } from "../src/types.js";

it("summarizes human requests without exposing successful source telemetry", () => {
  const snap = emptySnapshot();
  const view = createViewState({ instanceId: "attention", getSnapshot: () => snap });
  snap.attentionRead = { scope: "instance", readAt: "2026-09-29T23:00:00Z", items: [], detail: null, detailError: null,
    sources: [{ source: "queue", state: "available", detail: "Queue read succeeded" },
      ...Array.from({ length: 12 }, (_, i) => ({ source: `proof: project ${i}`, state: "available" as const, detail: "Native outcome judgments" }))] };
  const text = () => attentionLines(view.get(), snap, 80).map(l => l.text).join("\n");
  expect(text()).toContain("Nothing needs you right now.");
  expect(text()).not.toContain("proof: project");
  snap.attentionRead.items.push({ id: "queue:one", kind: "action", summary: "Choose the release", urgency: "normal", scope: "instance", at: null, unblocks: null, source: "/api/queue/one", project: null });
  expect(text()).toContain("1 request needs you.");
  snap.attentionRead.sources[0]!.state = "unavailable";
  expect(text()).toContain("Cannot confirm whether anything else needs you");
  expect(text()).not.toContain("Nothing needs you");
});

it.each([140, 80])("keeps readable summaries, passive exact source navigation and Back at width %i", async width => {
  const requests: string[] = [];
  const item = { id: "queue:request", kind: "action" as const, summary: "Choose the readable cover for the book", unblocks: "Print the approved edition", urgency: "urgent", at: "2026-09-10T01:00:00Z", scope: "project alpha", project: { id: "alpha", root: "/books/alpha" }, source: "/api/queue/request" };
  const data: AttentionRead = { scope: "instance", readAt: item.at, items: [item], sources: [{ source: "queue", state: "available", detail: "Actual source" }], detail: null, detailError: null };
  let unavailable = false;
  const client = new DaemonClient({ baseUrl: "http://fixture", fetchImpl: (async (url, init) => {
    const u = new URL(String(url)); requests.push(`${init?.method ?? "GET"} ${u.pathname}${u.search}`);
    if (u.pathname === "/api/attention") {
      if (unavailable) throw new Error("source offline");
      return Response.json({ ...data, detail: u.searchParams.get("item") ? { item, lines: ["Full original request", "History: still pending"], files: [{ label: "Evidence", path: "/books/alpha/proof.md#decision" }] } : null });
    }
    if (u.pathname === "/api/queue/human-updates") { if (unavailable) throw new Error("source offline"); return Response.json({ items: [], limit: 20, truncated: false }); }
    if (u.pathname === "/api/files/roots") return Response.json({ roots: [{ name: "alpha", path: "/books/alpha" }] });
    if (u.pathname === "/api/files/read") return Response.json({ root: "alpha", path: "proof.md", absolutePath: "/books/alpha/proof.md", content: "# Decision\nReadable cover", mtime: item.at, contentHash: "fixture", size: 25, truncated: false, totalBytes: 25 });
    throw new Error(`Unexpected request: ${u}`);
  }) as typeof fetch });
  let snap: FleetSnapshot = emptySnapshot();
  const view = createViewState({ instanceId: "attention", getSnapshot: () => snap });
  const refresh = async () => { snap = await hydrateSnapshot(client, undefined, null, null, null, view.get()); };
  view.dispatch(parseCommand("attention")); await refresh();
  const lines = attentionLines(view.get(), snap, width - 33), text = lines.map(l => l.text).join("\n");
  expect(text).toContain("Human requests"); expect(text).toContain("Updates");
  expect(text.replace(/\s+/g, " ")).toContain(item.summary);
  expect(lines.every(l => l.text.length <= width - 33)).toBe(true);
  view.dispatch(lines.find(l => l.action?.type === "attention-open")!.action!); await refresh();
  expect(view.get().attentionOpen).toBe(item.id);
  expect(attentionLines(view.get(), snap, width).map(l => l.text).join("\n")).toContain("Full original request");
  const retained = { ...snap, attentionRead: { ...snap.attentionRead!, items: [] } };
  const resolved = attentionLines(view.get(), retained, width).map(l => l.text).join("\n");
  expect(resolved).toContain("Source record"); expect(resolved).not.toContain("Human requests");
  const caller = view.get();
  view.dispatch({ type: "attention-source", path: "/books/alpha/proof.md#decision" });
  expect(view.get().file).toEqual({ root: "alpha", path: "proof.md", anchor: "decision" });
  expect(view.get().project).toEqual(item.project); await refresh();
  view.dispatch({ type: "back" }); await refresh();
  expect(view.get().project).toEqual(caller.project);
  expect(view.get().attentionOpen).toBe(item.id);
  view.dispatch({ type: "back" }); await refresh(); expect(view.get().attentionOpen).toBeNull();
  view.dispatch({ type: "attention-open", id: item.id }); await refresh();
  view.dispatch({ type: "attention-source", path: "/books/alpha/proof.md#decision" }); await refresh();
  view.dispatch({ type: "select", index: computeExplorerRows(view.get(), snap).findIndex(r => r.key === "section:needs") });
  view.dispatch({ type: "activate" }); await refresh();
  expect(view.get().attentionOpen).toBeNull(); expect(view.get().file).toBeNull();
  unavailable = true; await refresh();
  const failed = attentionLines(view.get(), snap, width).map(l => l.text).join("\n");
  expect(failed).toContain("Unavailable"); expect(failed).not.toContain("No current items");
  expect(requests.every(r => r.startsWith("GET "))).toBe(true);
  expect(requests.filter(r => r.includes("/api/files/read")).every(r => r === "GET /api/files/read?root=alpha&path=proof.md")).toBe(true);
});
