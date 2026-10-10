import { describe, it, expect } from "vitest";
import { missionStatusLines, missionStatusHeadline, statusAge, type MissionStatusSnap } from "../src/scopes/scopes-model.js";

const base: MissionStatusSnap = {
  updatedAt: "2026-10-10T07:09:46Z", fileModifiedAt: "x", ageMs: 5 * 60_000, stale: false, integration: [{ repo: "api", branch: "jisc/main", hash: "daba319" }],
  total: 25, counts: { accepted: 0, "merged-incomplete": 3, "built-awaiting-gates": 3, "in-progress": 3, "design-only": 3, "not-started": 11, ongoing: 2 },
  accepted: 0, reviewOrQaPending: 3, blocked: 4, issues: [],
  items: [{ id: "15", title: "Blind marking", state: "built-awaiting-gates", review: "approve", qa: "pending", hash: "4938e59", branch: null, blockedBy: "safe view not built", note: null }],
};
const text = (st: MissionStatusSnap | null) => missionStatusLines(st, 120).map(l => l.text).join("\n");

describe("mission status block", () => {
  it("shows completed/total, each state count, pending and blocked, fresh timestamp, and never a percentage", () => {
    const t = text(base);
    expect(t).toContain("0 of 25 accepted"); expect(t).toContain("built, awaiting review/QA"); expect(t).toContain("design only (nothing built)");
    expect(t).toContain("not started"); expect(t).toContain("4 blocked"); expect(t).toContain("record updated 5m ago");
    expect(t).toContain("BLOCKED: safe view not built"); expect(t).not.toMatch(/%/);
    expect(t).toContain("api jisc/main@daba319");
  });
  it("stale record is loudly marked and the headline says STALE", () => {
    const st = { ...base, stale: true, ageMs: 30 * 3600_000 };
    expect(text(st)).toContain("STALE"); expect(missionStatusHeadline(st)).toContain("STALE");
  });
  it("record issues are surfaced, not hidden; absent record renders nothing", () => {
    expect(text({ ...base, issues: ["item 9: marked accepted without review=approve and qa=pass"] })).toContain("record issue: item 9");
    expect(missionStatusLines(null, 100)).toEqual([]); expect(missionStatusLines(undefined, 100)).toEqual([]);
  });
  it("age formatting", () => { expect(statusAge(null)).toBe("age unknown"); expect(statusAge(30_000)).toBe("just now"); expect(statusAge(26 * 3600_000)).toBe("26h 0m ago"); });
});
