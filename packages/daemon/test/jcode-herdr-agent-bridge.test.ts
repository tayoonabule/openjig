import { describe, expect, it, vi } from "vitest";
import type { EventBus } from "../src/domain/event-bus.js";
import {
  HerdrAgentBridge,
  layoutPaneIds,
  mapHookActivityState,
  mapHerdrAgentState,
  runtimeAgentLabel,
} from "../src/domain/terminal/jcode-herdr-agent-bridge.js";
import type { HerdrResult, HerdrTransport } from "../src/domain/terminal/herdr-transport.js";
import type { ComposedPane } from "../src/domain/terminal/terminal-provider.js";

class FakeEventBus {
  private subscriber: ((event: unknown) => void) | null = null;

  subscribe(callback: (event: unknown) => void): () => void {
    this.subscriber = callback;
    return () => {
      this.subscriber = null;
    };
  }

  emit(event: unknown): void {
    this.subscriber?.(event);
  }
}

const pane: ComposedPane = {
  seat: "queue-worker@kernel",
  label: "queue worker",
  paneCommand: "tmux attach -t 'queue-worker@kernel'",
  readOnly: false,
};

const layoutResult: HerdrResult = {
  type: "layout_apply",
  layout: {
    root: {
      type: "split",
      first: { type: "pane", pane_id: "w9:3" },
      second: { type: "pane", pane_id: "w9:4" },
    },
  },
};

async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function bridgeFixture(opts: { reject?: boolean } = {}) {
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const transport: Pick<HerdrTransport, "request"> = {
    request: async (method, params) => {
      requests.push({ method, params: params as Record<string, unknown> });
      if (opts.reject) throw new Error("pane_not_found");
      return { type: "ok" };
    },
  };
  const eventBus = new FakeEventBus();
  let state: { activity: string; needsInput: { count: number; reason: string | null } } | null = {
    activity: "idle-at-prompt",
    needsInput: { count: 0, reason: null },
  };
  const bridge = new HerdrAgentBridge({
    transport,
    eventBus: eventBus as unknown as Pick<EventBus, "subscribe">,
    resolveSeat: (session) => session === pane.seat
      ? { nodeId: "node-queue", runtime: "jcode", resumeToken: "jcode-session-1" }
      : null,
    getSeatState: () => state as never,
  });
  return {
    bridge,
    eventBus,
    requests,
    setState(next: typeof state) {
      state = next;
    },
  };
}

describe("HerdrAgentBridge", () => {
  it("maps layout leaves to created seats and reports the initial runtime, state, and resume token", async () => {
    const { bridge, requests } = bridgeFixture();
    bridge.registerLayout([pane], layoutResult);
    await settled();

    expect(layoutPaneIds(layoutResult)).toEqual(["w9:3", "w9:4"]);
    expect(requests).toEqual([{
      method: "pane.report_agent",
      params: { pane_id: "w9:3", source: "openrig", agent: "jcode", state: "idle", seq: 1, agent_session_id: "jcode-session-1" },
    }]);
  });

  it("pushes canonical activity changes with a monotonic per-pane sequence", async () => {
    const { bridge, eventBus, requests, setState } = bridgeFixture();
    bridge.registerLayout([pane], layoutResult);
    await settled();

    setState({ activity: "working", needsInput: { count: 0, reason: null } });
    eventBus.emit({ type: "seat.activity_changed", seatNodeId: "node-queue", sessionName: pane.seat });
    await settled();

    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual({
      method: "pane.report_agent",
      params: { pane_id: "w9:3", source: "openrig", agent: "jcode", state: "working", seq: 2, agent_session_id: "jcode-session-1" },
    });
  });

  it("relays the immediate hook idle transition when the canonical projection has not changed", async () => {
    const { bridge, eventBus, requests } = bridgeFixture();
    bridge.registerLayout([pane], layoutResult);
    await settled();

    eventBus.emit({
      type: "agent.activity",
      nodeId: "node-queue",
      sessionName: pane.seat,
      activity: { state: "idle" },
    });
    await settled();

    expect(requests[1]?.params).toMatchObject({ state: "idle", seq: 2 });
  });

  it("uses blocked for attention, preserves known runtime labels, and treats unknown state honestly", () => {
    expect(mapHerdrAgentState({ activity: "working", needsInput: { count: 1, reason: "approval" } } as never)).toBe("blocked");
    expect(mapHerdrAgentState({ activity: "idle-at-prompt", needsInput: { count: 0, reason: null } } as never)).toBe("idle");
    expect(mapHerdrAgentState(null)).toBe("unknown");
    expect(mapHookActivityState("running")).toBe("working");
    expect(mapHookActivityState("needs_input")).toBe("blocked");
    expect(mapHookActivityState("mystery")).toBe("unknown");
    expect(runtimeAgentLabel("claude-code")).toBe("claude");
    expect(runtimeAgentLabel("codex")).toBe("codex");
  });

  it("drops a rejected pane mapping and logs the best-effort failure once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { bridge, eventBus, requests } = bridgeFixture({ reject: true });
      bridge.registerLayout([pane], layoutResult);
      await settled();
      eventBus.emit({ type: "seat.activity_changed", seatNodeId: "node-queue", sessionName: pane.seat });
      await settled();

      expect(requests).toHaveLength(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith("[openrig] Herdr agent report failed: pane_not_found");
    } finally {
      warn.mockRestore();
    }
  });
});
