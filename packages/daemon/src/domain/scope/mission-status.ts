// Mission status.yaml projection: honest at-a-glance counts from a lead-maintained structured record.
// Counts are computed FROM the items, never authored, and no percentage is produced. A record whose
// `accepted` items lack review=approve AND qa=pass is shown as inconsistent and NOT counted as accepted.
import * as fs from "node:fs";
import * as path from "node:path";
import { parse } from "yaml";

export const MISSION_STATUS_STATES = ["accepted", "merged-incomplete", "built-awaiting-gates", "in-progress", "design-only", "not-started", "ongoing", "excluded"] as const;
export type MissionItemState = (typeof MISSION_STATUS_STATES)[number];
export const MISSION_STATUS_STALE_MS = 12 * 60 * 60 * 1000; // policy: a record untouched for 12h is shown as stale

export interface MissionStatusItem { id: string; title: string; state: MissionItemState; review: string | null; qa: string | null; hash: string | null; branch: string | null; blockedBy: string | null; slice: string | null; note: string | null }
export interface MissionStatusSummary {
  sourcePath: string;
  updatedAt: string | null;       // authored timestamp in the record
  fileModifiedAt: string;         // filesystem mtime, so a record nobody touched cannot look fresh
  ageMs: number | null;           // from the older of the two timestamps
  stale: boolean;
  integration: Array<{ repo: string; branch: string | null; hash: string | null }>;
  total: number;                  // items excluding "excluded"
  counts: Record<MissionItemState, number>;
  accepted: number;               // only items that pass the strict acceptance check
  reviewOrQaPending: number;      // built-awaiting-gates + merged-incomplete items that are not fully review+qa passed
  blocked: number;                // items with a blocked_by reason, not accepted
  issues: string[];
  items: MissionStatusItem[];
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : v === undefined || v === null ? null : String(v));

export function readMissionStatus(missionDir: string, now = Date.now()): MissionStatusSummary | null {
  const file = path.join(missionDir, "status.yaml");
  let text: string; let mtime: Date;
  try { text = fs.readFileSync(file, "utf-8"); mtime = fs.statSync(file).mtime; } catch { return null; }
  const issues: string[] = [];
  let doc: any; // parsed with the failsafe schema: all scalars stay strings, so a hash like 34e7702 never becomes a number
  try { doc = parse(text, { schema: "failsafe" }); } catch (e) { return emptySummary(file, mtime, now, [`status.yaml is not valid YAML: ${(e as Error).message.split("\n")[0]}`]); }
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.items)) return emptySummary(file, mtime, now, ["status.yaml has no items list"]);
  const counts = Object.fromEntries(MISSION_STATUS_STATES.map(s => [s, 0])) as Record<MissionItemState, number>;
  const items: MissionStatusItem[] = [];
  const seen = new Set<string>();
  let accepted = 0, pending = 0, blocked = 0;
  for (const raw of doc.items) {
    const id = str(raw?.id);
    if (!id) { issues.push("an item has no id"); continue; }
    if (seen.has(id)) { issues.push(`duplicate item id ${id}`); continue; }
    seen.add(id);
    let state = str(raw.state) as MissionItemState | null;
    if (!state || !(MISSION_STATUS_STATES as readonly string[]).includes(state)) { issues.push(`item ${id}: unknown state "${raw.state}" counted as not-started`); state = "not-started"; }
    const review = str(raw.review), qa = str(raw.qa);
    if (state === "accepted" && !(review === "approve" && qa === "pass")) { issues.push(`item ${id}: marked accepted without review=approve and qa=pass, NOT counted as accepted (shown as built-awaiting-gates)`); state = "built-awaiting-gates"; }
    counts[state]++;
    const blockedBy = str(raw.blocked_by);
    if (state === "accepted") accepted++;
    else {
      if ((state === "built-awaiting-gates" || state === "merged-incomplete") && !(review === "approve" && qa === "pass")) pending++;
      if (blockedBy && state !== "excluded") blocked++;
    }
    items.push({ id, title: str(raw.title) ?? id, state, review, qa, hash: str(raw.hash), branch: str(raw.branch), blockedBy, slice: str(raw.slice), note: str(raw.note) });
  }
  const updatedAt = str(doc.updated_at);
  const authored = updatedAt ? Date.parse(updatedAt) : NaN;
  if (!updatedAt || Number.isNaN(authored)) issues.push("updated_at is missing or not a timestamp; freshness uses the file modification time only");
  const newest = Math.max(Number.isNaN(authored) ? 0 : authored, mtime.getTime());
  const ageMs = Math.max(0, now - newest);
  const integration = Object.entries((doc.integration ?? {}) as Record<string, any>).map(([repo, v]) => ({ repo, branch: str(v?.branch), hash: str(v?.hash) }));
  return { sourcePath: file, updatedAt, fileModifiedAt: mtime.toISOString(), ageMs, stale: ageMs > MISSION_STATUS_STALE_MS, integration,
    total: items.length - counts.excluded, counts, accepted, reviewOrQaPending: pending, blocked, issues, items };
}

function emptySummary(file: string, mtime: Date, now: number, issues: string[]): MissionStatusSummary {
  const counts = Object.fromEntries(MISSION_STATUS_STATES.map(s => [s, 0])) as Record<MissionItemState, number>;
  return { sourcePath: file, updatedAt: null, fileModifiedAt: mtime.toISOString(), ageMs: Math.max(0, now - mtime.getTime()), stale: true, integration: [], total: 0, counts, accepted: 0, reviewOrQaPending: 0, blocked: 0, issues, items: [] };
}
