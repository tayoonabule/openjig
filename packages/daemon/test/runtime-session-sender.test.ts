import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import Database from "better-sqlite3";
import { transportSenderSession } from "../src/routes/require-sender-identity.js";

function appWith(rows: Array<[string, string]>) {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE sessions (id INTEGER PRIMARY KEY, session_name TEXT, resume_token TEXT)");
  for (const [name, token] of rows) db.prepare("INSERT INTO sessions (session_name, resume_token) VALUES (?, ?)").run(name, token);
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("db" as never, db); await next(); });
  app.get("/who", (c) => c.json({ s: transportSenderSession(c) ?? null }));
  return app;
}
const get = async (app: Hono, h: Record<string, string>) => (await (await app.request("/who", { headers: h })).json() as { s: string | null }).s;

describe("sender identity survives a shared server's inherited OPENRIG_* env", () => {
  const app = appWith([["advisor-lead@kernel", "session_adv_1"], ["rust-core-core@blip", "session_rc_1"]]);
  it("runtime session mapping to one seat overrides the wrong inherited env identity", async () => {
    expect(await get(app, { "x-openrig-session": "rust-core-core@blip", "x-openrig-runtime-session": "session_adv_1" })).toBe("advisor-lead@kernel");
  });
  it("matching env identity is unchanged", async () => {
    expect(await get(app, { "x-openrig-session": "rust-core-core@blip", "x-openrig-runtime-session": "session_rc_1" })).toBe("rust-core-core@blip");
  });
  it("unknown runtime session falls back to env identity", async () => {
    expect(await get(app, { "x-openrig-session": "rust-core-core@blip", "x-openrig-runtime-session": "nope" })).toBe("rust-core-core@blip");
  });
  it("ambiguous runtime session (two seats) falls back to env identity, never guesses", async () => {
    const amb = appWith([["a@r", "tok"], ["b@r", "tok"]]);
    expect(await get(amb, { "x-openrig-session": "c@r", "x-openrig-runtime-session": "tok" })).toBe("c@r");
  });
  it("no runtime header: behaves exactly as before", async () => {
    expect(await get(app, { "x-openrig-session": "x@y" })).toBe("x@y");
    expect(await get(app, {})).toBeNull();
  });
});
