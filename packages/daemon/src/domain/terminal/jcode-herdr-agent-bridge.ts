import type { EventBus } from "../event-bus.js";
import type { ArbitratedSeatState } from "../activity-taxonomy.js";
import type { ComposedPane } from "./terminal-provider.js";
import type { HerdrResult, HerdrTransport } from "./herdr-transport.js";

/** OpenRig's distinct external-reporter source in Herdr. */
export const OPENRIG_HERDR_REPORT_SOURCE = "openrig";

export type HerdrReportedState = "idle" | "working" | "blocked" | "unknown";

export interface HerdrSeatIdentity {
  nodeId: string;
  runtime: string | null;
  resumeToken: string | null;
}

export interface HerdrAgentBridgeDeps {
  transport: Pick<HerdrTransport, "request">;
  eventBus: Pick<EventBus, "subscribe">;
  resolveSeat(sessionName: string): HerdrSeatIdentity | null;
  getSeatState(seatNodeId: string): Pick<ArbitratedSeatState, "activity" | "needsInput"> | null;
}

interface BridgeEvent {
  type: string;
  sessionName?: string;
  seatNodeId?: string;
  nodeId?: string;
  activity?: { state?: string };
}

interface PaneBinding {
  paneId: string;
  sessionName: string;
  seat: HerdrSeatIdentity;
  seq: number;
}

/**
 * Translate OpenRig's canonical activity oracle into Herdr's external reporter
 * protocol. This is deliberately a daemon-side bridge rather than a pane hook:
 * tiles contain tmux, while OpenRig owns the runtime identity and activity truth.
 */
export class HerdrAgentBridge {
  private readonly bindings = new Map<string, PaneBinding>();
  private readonly unsubscribe: () => void;
  private reportFailureLogged = false;

  constructor(private readonly deps: HerdrAgentBridgeDeps) {
    this.unsubscribe = deps.eventBus.subscribe((event) => this.onEvent(event as unknown as BridgeEvent));
  }

  /** Stop listening and forget all ephemeral pane mappings on daemon shutdown. */
  dispose(): void {
    this.unsubscribe();
    this.bindings.clear();
  }

  /**
   * Called immediately after Herdr creates a layout. Its returned tree contains
   * the public pane ids, in the same leaf order as the submitted layout tree.
   * Missing ids are an older-Herdr compatibility no-op, never an open failure.
   */
  registerLayout(panes: ComposedPane[], result: HerdrResult): void {
    const paneIds = layoutPaneIds(result);
    for (let index = 0; index < panes.length; index += 1) {
      const pane = panes[index]!;
      const paneId = paneIds[index];
      if (!paneId) continue;
      const seat = this.deps.resolveSeat(pane.seat);
      if (!seat?.runtime) continue;
      const binding: PaneBinding = {
        paneId,
        sessionName: pane.seat,
        seat,
        seq: 0,
      };
      this.bindings.set(paneId, binding);
      this.enqueueReport(binding);
    }
  }

  private onEvent(event: BridgeEvent): void {
    switch (event.type) {
      case "seat.activity_changed":
        for (const binding of this.bindingsFor(event.sessionName, event.seatNodeId)) this.enqueueReport(binding);
        break;
      case "agent.activity":
        // The taxonomy projection remains the primary source, but this is its immediate
        // existing lifecycle ingress. Relaying it closes the short projection/debounce gap
        // so Herdr sees a hook's idle transition too.
        for (const binding of this.bindingsFor(event.sessionName, event.nodeId)) {
          this.enqueueReport(binding, mapHookActivityState(event.activity?.state));
        }
        break;
      case "session.stopped":
      case "session.detached":
        if (event.sessionName) this.dropSession(event.sessionName);
        break;
      case "node.removed":
        for (const [paneId, binding] of this.bindings) {
          if (binding.seat.nodeId === event.nodeId) this.bindings.delete(paneId);
        }
        break;
    }
  }

  private bindingsFor(sessionName: string | undefined, nodeId: string | undefined): PaneBinding[] {
    return [...this.bindings.values()].filter((b) => b.sessionName === sessionName && b.seat.nodeId === nodeId);
  }

  private dropSession(sessionName: string): void {
    for (const [paneId, binding] of this.bindings) {
      if (binding.sessionName === sessionName) this.bindings.delete(paneId);
    }
  }

  /** Send a best-effort report with the source sequence Herdr uses to reject stale updates. */
  private enqueueReport(binding: PaneBinding, reportedState?: HerdrReportedState): void {
    if (this.bindings.get(binding.paneId) !== binding) return;
    const state = this.deps.getSeatState(binding.seat.nodeId);
    const seq = ++binding.seq;
    void this.deps.transport.request("pane.report_agent", {
      pane_id: binding.paneId,
      source: OPENRIG_HERDR_REPORT_SOURCE,
      agent: runtimeAgentLabel(binding.seat.runtime),
      state: reportedState ?? mapHerdrAgentState(state),
      seq,
      ...(binding.seat.resumeToken ? { agent_session_id: binding.seat.resumeToken } : {}),
    }).catch((err: unknown) => {
      // A closed pane/workspace or a vanished Herdr socket is best effort only.
      // Forget the mapping so the bridge cannot keep retrying a rejected pane.
      if (!this.reportFailureLogged) {
        this.reportFailureLogged = true;
        const detail = err instanceof Error ? err.message : String(err);
        console.warn(`[openrig] Herdr agent report failed: ${detail}`);
      }
      if (this.bindings.get(binding.paneId) === binding) this.bindings.delete(binding.paneId);
    });
  }
}

/** Herdr's layout response exposes public pane ids at pane leaves. */
export function layoutPaneIds(result: HerdrResult): string[] {
  const root = (result["layout"] as { root?: unknown } | undefined)?.root;
  const ids: string[] = [];
  collectPaneIds(root, ids);
  return ids;
}

function collectPaneIds(node: unknown, ids: string[]): void {
  if (!node || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  if (record["type"] === "pane") {
    if (typeof record["pane_id"] === "string") ids.push(record["pane_id"]);
    return;
  }
  if (record["type"] === "split") {
    collectPaneIds(record["first"], ids);
    collectPaneIds(record["second"], ids);
  }
}

/** Herdr uses its own short labels for the known managed runtime names. */
export function runtimeAgentLabel(runtime: string | null): string {
  if (runtime === "claude-code") return "claude";
  return runtime ?? "unknown";
}

/** OpenRig activity truth: needs-input outranks the working/idle axis. */
export function mapHerdrAgentState(
  state: Pick<ArbitratedSeatState, "activity" | "needsInput"> | null,
): HerdrReportedState {
  if (!state) return "unknown";
  if (state.needsInput.count > 0) return "blocked";
  if (state.activity === "working") return "working";
  if (state.activity === "idle-at-prompt") return "idle";
  return "unknown";
}

/** Direct hook activity is the taxonomy's event-bus ingress vocabulary. */
export function mapHookActivityState(activity: string | undefined): HerdrReportedState {
  switch (activity) {
    case "running": return "working";
    case "idle": return "idle";
    case "needs_input": return "blocked";
    default: return "unknown";
  }
}
