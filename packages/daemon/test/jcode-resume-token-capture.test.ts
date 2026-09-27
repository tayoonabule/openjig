import { describe, expect, it, vi } from "vitest";
import { deriveResumeToken } from "../src/domain/resume-token-capture.js";

const ID = "session_evergreen_1790178908510_a18975cec608bc81";
describe("Jcode resume-token capture", () => {
  it("reads seat-scoped session identity without changing state", async () => {
    const captureSessionId = vi.fn(async () => ID);
    expect(await deriveResumeToken({ runtime: "jcode", sessionName: "seat" }, { jcodeSessionReader: { captureSessionId } })).toEqual({
      outcome: "captured", resumeType: "jcode_id", token: ID,
    });
    expect(captureSessionId).toHaveBeenCalledWith("seat");
  });

  it("does not fabricate a missing or invalid id", async () => {
    expect(await deriveResumeToken({ runtime: "jcode", sessionName: "seat" }, {})).toEqual({ outcome: "noop" });
    expect(await deriveResumeToken({ runtime: "jcode", sessionName: "seat" }, { jcodeSessionReader: { captureSessionId: async () => undefined } })).toEqual({ outcome: "skipped", reason: "probe_timeout" });
    expect(await deriveResumeToken({ runtime: "jcode", sessionName: "seat" }, { jcodeSessionReader: { captureSessionId: async () => "invalid" } })).toEqual({ outcome: "skipped", reason: "invalid_token" });
  });
});
