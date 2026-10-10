import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path";
import { readMissionStatus, MISSION_STATUS_STALE_MS } from "../src/domain/scope/mission-status.js";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "mstatus-")); });
const write = (y: string) => fs.writeFileSync(path.join(dir, "status.yaml"), y);
const NOW = Date.parse("2026-10-10T08:00:00Z");

describe("readMissionStatus", () => {
  it("no status.yaml: null (no invented status)", () => { expect(readMissionStatus(dir, NOW)).toBeNull(); });
  it("counts come from items; excluded are not in the total; no percentage field exists", () => {
    write(`updated_at: 2026-10-10T07:59:00Z
items:
  - {id: a, title: A, state: accepted, review: approve, qa: pass}
  - {id: b, title: B, state: built-awaiting-gates, review: approve, qa: pending}
  - {id: c, title: C, state: merged-incomplete, review: approve, qa: pass}
  - {id: d, title: D, state: not-started, blocked_by: "item b"}
  - {id: e, title: E, state: design-only}
  - {id: f, title: F, state: excluded}
`);
    fs.utimesSync(path.join(dir, "status.yaml"), NOW / 1000, NOW / 1000);
    const s = readMissionStatus(dir, NOW)!;
    expect(s.total).toBe(5); expect(s.accepted).toBe(1);
    expect(s.counts["built-awaiting-gates"]).toBe(1); expect(s.counts["design-only"]).toBe(1); expect(s.counts["not-started"]).toBe(1);
    expect(s.reviewOrQaPending).toBe(1);               // b only; c is review+qa passed but outcome incomplete (not pending gates)
    expect(s.blocked).toBe(1); expect(s.stale).toBe(false);
    expect(JSON.stringify(s)).not.toMatch(/percent/i);
  });
  it("accepted without review=approve AND qa=pass is NOT counted and is flagged", () => {
    write(`updated_at: 2026-10-10T07:59:00Z\nitems:\n  - {id: a, title: A, state: accepted, review: approve, qa: pending}\n`);
    const s = readMissionStatus(dir, NOW)!;
    expect(s.accepted).toBe(0); expect(s.counts["built-awaiting-gates"]).toBe(1);
    expect(s.issues.join(" ")).toMatch(/item a: marked accepted without/);
  });
  it("unknown state counts as not-started, duplicate ids ignored, both flagged", () => {
    write(`updated_at: 2026-10-10T07:59:00Z\nitems:\n  - {id: a, title: A, state: weird}\n  - {id: a, title: A2, state: accepted, review: approve, qa: pass}\n`);
    const s = readMissionStatus(dir, NOW)!;
    expect(s.total).toBe(1); expect(s.counts["not-started"]).toBe(1); expect(s.accepted).toBe(0);
    expect(s.issues.length).toBe(2);
  });
  it("freshness: uses the OLDER-looking guard, a touched-but-unchanged claim cannot hide staleness only via updated_at", () => {
    write(`updated_at: 2026-10-09T01:00:00Z\nitems:\n  - {id: a, title: A, state: not-started}\n`);
    fs.utimesSync(path.join(dir, "status.yaml"), (NOW - MISSION_STATUS_STALE_MS - 60_000) / 1000, (NOW - MISSION_STATUS_STALE_MS - 60_000) / 1000);
    expect(readMissionStatus(dir, NOW)!.stale).toBe(true);
  });
  it("freshness: mixed age, fresh mtime but stale authored updated_at is STALE (older of the two)", () => {
    write(`updated_at: 2026-10-09T01:00:00Z\nitems:\n  - {id: a, title: A, state: not-started}\n`);
    fs.utimesSync(path.join(dir, "status.yaml"), NOW / 1000, NOW / 1000);
    expect(readMissionStatus(dir, NOW)!.stale).toBe(true);
  });
  it("freshness: mixed age, fresh updated_at but stale mtime is STALE (older of the two)", () => {
    write(`updated_at: 2026-10-10T07:59:00Z\nitems:\n  - {id: a, title: A, state: not-started}\n`);
    const old = (NOW - MISSION_STATUS_STALE_MS - 60_000) / 1000;
    fs.utimesSync(path.join(dir, "status.yaml"), old, old);
    expect(readMissionStatus(dir, NOW)!.stale).toBe(true);
  });
  it("containment: a status.yaml symlink escaping the root is refused; an in-root one is read", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "mstatus-out-"));
    fs.writeFileSync(path.join(outside, "status.yaml"), `updated_at: 2026-10-10T07:59:00Z\nitems:\n  - {id: x, title: X, state: accepted, review: approve, qa: pass}\n`);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mstatus-root-"));
    const mission = path.join(root, "m"); fs.mkdirSync(mission);
    fs.symlinkSync(path.join(outside, "status.yaml"), path.join(mission, "status.yaml"));
    expect(readMissionStatus(mission, NOW, root)).toBeNull();
    fs.rmSync(path.join(mission, "status.yaml"));
    fs.writeFileSync(path.join(mission, "status.yaml"), `updated_at: 2026-10-10T07:59:00Z\nitems:\n  - {id: a, title: A, state: not-started}\n`);
    expect(readMissionStatus(mission, NOW, root)!.total).toBe(1);
  });
  it("missing/invalid updated_at is flagged and freshness falls back to the file mtime", () => {
    write(`items:\n  - {id: a, title: A, state: not-started}\n`);
    fs.utimesSync(path.join(dir, "status.yaml"), NOW / 1000, NOW / 1000);
    const s = readMissionStatus(dir, NOW)!;
    expect(s.issues.join(" ")).toMatch(/updated_at/); expect(s.stale).toBe(false);
  });
  it("malformed yaml: explicit unavailable-style summary, zero counts, stale", () => {
    write("items: [ {id: a\n");
    const s = readMissionStatus(dir, NOW)!;
    expect(s.total).toBe(0); expect(s.stale).toBe(true); expect(s.issues[0]).toMatch(/not valid YAML/);
  });
  it("a hash that looks like a number (34e7702) stays the exact string", () => {
    write(`updated_at: 2026-10-10T07:59:00Z\nitems:\n  - {id: a, title: A, state: built-awaiting-gates, hash: 34e7702, review: approve, qa: pending}\n  - {id: b, title: B, state: not-started, hash: 1234567}\n`);
    const s = readMissionStatus(dir, NOW)!;
    expect(s.items[0]!.hash).toBe("34e7702"); expect(s.items[1]!.hash).toBe("1234567"); expect(s.items[1]!.id).toBe("b");
  });
});
