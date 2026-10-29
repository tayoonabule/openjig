/**
 * Resolve the seat for this runtime session before a CLI command needs sender identity.
 * A shared runtime process can inherit stale OPENRIG_* environment, so the daemon's
 * exact-one-session mapping is authoritative. The mapping proves a seat, not a physical node,
 * so discard any inherited node id even when the seat name already matches. Any
 * missing/ambiguous/error response preserves the existing environment rather than guessing.
 */
export async function adoptRuntimeSessionSeat(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const runtimeId = env["JCODE_SESSION_ID"]?.trim();
  if (!runtimeId) return;

  try {
    const base = (env["OPENRIG_URL"] || "http://127.0.0.1:7433").replace(/\/+$/, "");
    const res = await fetchImpl(`${base}/api/whoami/seat`, {
      headers: { "X-OpenRig-Runtime-Session": runtimeId },
      signal: AbortSignal.timeout(1000),
    });
    const payload = res.ok ? (await res.json()) as { seat?: string | null } : null;
    const seat = typeof payload?.seat === "string" ? payload.seat.trim() : "";
    if (seat) {
      env["OPENRIG_SESSION_NAME"] = seat;
      delete env["OPENRIG_NODE_ID"];
    }
  } catch {
    // Keep the existing identity when the daemon cannot establish an exact seat mapping.
  }
}
