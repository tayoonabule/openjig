/** Stop restore before launch when saved startup or snapshot identity names a different runtime. */
export function restoreRuntimeCompatibilityError(
  runtime: string | null,
  startupRuntime: string | null | undefined,
  snapshotRuntime?: string | null,
): string | null {
  if (!runtime) return null;
  if ((!startupRuntime || startupRuntime === runtime) && (!snapshotRuntime || snapshotRuntime === runtime)) return null;
  return "No session was started for this seat. Restore a snapshot whose saved seat and startup runtimes match the seat's current runtime.";
}
