import { describe, expect, it, vi } from "vitest";
import { adoptRuntimeSessionSeat } from "../src/runtime-session-seat.js";

describe("adoptRuntimeSessionSeat", () => {
  it("does not make a request when no runtime session id is available", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const env: NodeJS.ProcessEnv = {};

    await adoptRuntimeSessionSeat(env, fetchImpl);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(env["OPENRIG_SESSION_NAME"]).toBeUndefined();
  });

  it("adopts only the seat returned for this exact runtime session", async () => {
    const env: NodeJS.ProcessEnv = {
      JCODE_SESSION_ID: "runtime-session-1",
      OPENRIG_URL: "http://127.0.0.1:7433///",
      OPENRIG_SESSION_NAME: "inherited-seat@kernel",
      OPENRIG_NODE_ID: "inherited-node",
    };
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("http://127.0.0.1:7433/api/whoami/seat");
      expect(new Headers(init?.headers).get("X-OpenRig-Runtime-Session")).toBe("runtime-session-1");
      return new Response(JSON.stringify({ seat: "mapped-seat@kernel" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    await adoptRuntimeSessionSeat(env, fetchImpl);

    expect(env["OPENRIG_SESSION_NAME"]).toBe("mapped-seat@kernel");
    expect(env["OPENRIG_NODE_ID"]).toBeUndefined();
  });

  it.each([
    ["unknown mapping", 200, { seat: null }],
    ["ambiguous mapping", 200, {}],
    ["non-success response", 404, { seat: "untrusted-seat@kernel" }],
  ])("does not guess a seat on %s", async (_label, status, body) => {
    const env: NodeJS.ProcessEnv = { JCODE_SESSION_ID: "runtime-session-1" };
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), {
      status: Number(status),
      headers: { "content-type": "application/json" },
    }));

    await adoptRuntimeSessionSeat(env, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(env["OPENRIG_SESSION_NAME"]).toBeUndefined();
    expect(env["OPENRIG_NODE_ID"]).toBeUndefined();
  });

  it("preserves existing environment identity when the lookup fails", async () => {
    const env: NodeJS.ProcessEnv = {
      JCODE_SESSION_ID: "runtime-session-1",
      OPENRIG_SESSION_NAME: "existing-seat@kernel",
      OPENRIG_NODE_ID: "existing-node",
    };
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error("lookup unavailable");
    });

    await adoptRuntimeSessionSeat(env, fetchImpl);

    expect(env["OPENRIG_SESSION_NAME"]).toBe("existing-seat@kernel");
    expect(env["OPENRIG_NODE_ID"]).toBe("existing-node");
  });
});
