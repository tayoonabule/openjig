import { createRequire } from "node:module";
import nodePath from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const relay = require(nodePath.resolve(import.meta.dirname, "../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs")) as {
  jcodeHookPayload(env: Record<string, string>): Record<string, unknown>;
  buildOpenRigPayload(payload: Record<string, unknown>, env: Record<string, string>): Record<string, unknown>;
  buildSessionIdentityPayload(payload: Record<string, unknown>, env: Record<string, string>): Record<string, unknown>;
};
const seatEnv = { OPENRIG_SESSION_NAME: "seat", OPENRIG_NODE_ID: "n", OPENRIG_RUNTIME: "jcode" };

describe("Jcode activity hooks", () => {
  it.each([
    ["turn_start", "UserPromptSubmit"], ["turn_end", "Stop"],
    ["session_start", "SessionStart"], ["session_end", "SessionEnd"],
  ])("maps %s to %s activity", (event, expected) => {
    const payload = relay.jcodeHookPayload({ JCODE_HOOK_EVENT: event, JCODE_HOOK_SESSION_ID: "session_1", JCODE_HOOK_PAYLOAD: "{}" });
    expect(relay.buildOpenRigPayload(payload, seatEnv)).toMatchObject({ runtime: "jcode", hookEvent: expected, sessionName: "seat" });
  });

  it("forwards session-start identity to the existing ingest path", () => {
    const payload = relay.jcodeHookPayload({ JCODE_HOOK_EVENT: "session_start", JCODE_HOOK_SESSION_ID: "session_1", JCODE_HOOK_PAYLOAD: "{}" });
    expect(relay.buildSessionIdentityPayload(payload, seatEnv)).toMatchObject({ eventFamily: "session_identity", sessionId: "session_1", runtime: "jcode" });
  });
});
