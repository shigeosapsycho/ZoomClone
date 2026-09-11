import { ApiError } from "@zoomclone/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestContext, type TestContext } from "../test/helpers";
import { buildApp } from "./app";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});

describe("app skeleton", () => {
  it("serves /healthz", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it("returns the error envelope for unknown routes", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: "NOT_FOUND", message: "route not found" } });
  });

  it("exposes prometheus metrics", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("join_latency_seconds");
    expect(res.body).toContain("join_errors_total");
  });

  it("renders ApiError with status, code and retry-after, and hides internal errors", async () => {
    const app = await buildApp(ctx.deps);
    app.get("/boom", async () => {
      throw new ApiError("RATE_LIMITED", "slow down", 12);
    });
    app.get("/crash", async () => {
      throw new Error("secret detail");
    });
    await app.ready();
    const boom = await app.inject({ method: "GET", url: "/boom" });
    expect(boom.statusCode).toBe(429);
    expect(boom.headers["retry-after"]).toBe("12");
    expect(boom.json()).toEqual({ error: { code: "RATE_LIMITED", message: "slow down" } });
    const crash = await app.inject({ method: "GET", url: "/crash" });
    expect(crash.statusCode).toBe(500);
    expect(crash.json()).toEqual({ error: { code: "INTERNAL", message: "internal error" } });
    await app.close();
  });
});
