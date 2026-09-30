import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { terminalRoutes } from "../src/routes/terminal.js";

describe("managed observer diagnostic route", () => {
  it("reports disabled honestly when no controller is wired", async () => {
    const app = new Hono().route("/api/terminal", terminalRoutes());
    const response = await app.request("/api/terminal/managed-views");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enabled: false, findings: {} });
  });

  it("reads only the current status without reconciling, opening or focusing views", async () => {
    const status = vi.fn(() => ({ rig: "views pending: native observation unavailable" }));
    const reconcile = vi.fn(() => { throw new Error("diagnostic must not mutate"); });
    const openView = vi.fn(() => { throw new Error("diagnostic must not open"); });
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("managedHerdrViews" as never, { status, reconcile } as never);
      c.set("terminalService" as never, { openView } as never);
      await next();
    });
    app.route("/api/terminal", terminalRoutes());
    for (let i = 0; i < 2; i++) {
      const response = await app.request("/api/terminal/managed-views");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ enabled: true, findings: { rig: "views pending: native observation unavailable" } });
    }
    expect(status).toHaveBeenCalledTimes(2);
    expect(reconcile).not.toHaveBeenCalled();
    expect(openView).not.toHaveBeenCalled();
    expect((await app.request("/api/terminal/managed-views", { method: "POST" })).status).toBe(404);
  });
});
