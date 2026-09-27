import { describe, expect, it, vi } from "vitest";
import { JcodeResumeAdapter } from "../src/adapters/jcode-resume.js";
import type { JcodeRuntimeAdapter } from "../src/adapters/jcode-runtime-adapter.js";

const ID = "session_evergreen_1790178908510_a18975cec608bc81";

describe("JcodeResumeAdapter", () => {
  it("accepts only a nonempty jcode_id", () => {
    const resume = new JcodeResumeAdapter({} as JcodeRuntimeAdapter);
    expect(resume.canResume("jcode_id", ID)).toBe(true);
    expect(resume.canResume("jcode_id", null)).toBe(false);
    expect(resume.canResume("codex_id", ID)).toBe(false);
  });

  it("forwards exact resume id, cwd and model through the runtime adapter", async () => {
    const launchHarness = vi.fn(async () => ({ ok: true as const, resumeType: "jcode_id", resumeToken: ID }));
    const resume = new JcodeResumeAdapter({ launchHarness } as unknown as JcodeRuntimeAdapter);
    expect(await resume.resume("seat", "jcode_id", ID, "/repo", "gpt-5.5")).toEqual({ ok: true, appliedLaunch: undefined });
    expect(launchHarness).toHaveBeenCalledWith(expect.objectContaining({ tmuxSession: "seat", cwd: "/repo", model: "gpt-5.5" }),
      { name: "seat", resumeToken: ID });
  });

  it("preserves retry-fresh and attention-required outcomes", async () => {
    const launchHarness = vi.fn(async (): Promise<{ ok: false; recovery: "retry_fresh" | "attention_required"; error: string }> => ({ ok: false, recovery: "retry_fresh", error: "missing" }));
    const resume = new JcodeResumeAdapter({ launchHarness } as unknown as JcodeRuntimeAdapter);
    expect(await resume.resume("seat", "jcode_id", ID, "/repo")).toMatchObject({ ok: false, code: "retry_fresh" });
    launchHarness.mockResolvedValue({ ok: false, recovery: "attention_required", error: "login" });
    expect(await resume.resume("seat", "jcode_id", ID, "/repo")).toMatchObject({ ok: false, code: "attention_required" });
  });
});
