import Redis from "ioredis";
import { MEETING_CODE_RE, MeetingResponseSchema, type MeetingResponse } from "@zoomclone/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  bearer,
  createTestContext,
  mintUser,
  startSession,
  testRedisUrl,
  type TestContext,
} from "../../test/helpers";
import { ctlChannel } from "../room-control";

let ctx: TestContext;
let host: { token: string; sub: string; orgId: string };

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  host = await mintUser(ctx, { name: "Host" });
});

async function createMeeting(token = host.token, body: object = {}): Promise<MeetingResponse> {
  const res = await ctx.app.inject({
    method: "POST",
    url: "/v1/meetings",
    headers: bearer(token),
    payload: body,
  });
  expect(res.statusCode, res.body).toBe(201);
  return MeetingResponseSchema.parse(res.json());
}

describe("POST /v1/meetings", () => {
  it("creates a scheduled meeting with a spec-shaped code and default settings", async () => {
    const m = await createMeeting(host.token, { title: "Standup" });
    expect(m.code).toMatch(MEETING_CODE_RE);
    expect(m.status).toBe("scheduled");
    expect(m.settings).toEqual({ lobby: true, max_participants: 500 });
    expect(m.organizer_id).toBe(host.sub);
    expect(m.org_id).toBe(host.orgId);
    expect(m.region).toBe(ctx.env.DEFAULT_REGION);
    expect(m.title).toBe("Standup");
  });

  it("accepts settings and a schedule", async () => {
    const m = await createMeeting(host.token, {
      scheduled_start: "2026-09-10T09:00:00Z",
      scheduled_end: "2026-09-10T09:30:00Z",
      settings: { lobby: false, max_participants: 10 },
    });
    expect(m.settings).toEqual({ lobby: false, max_participants: 10 });
    expect(m.scheduled_start).toBe("2026-09-10T09:00:00.000Z");
  });

  it("rejects an end before the start, malformed JSON and missing auth", async () => {
    const bad = await ctx.app.inject({
      method: "POST",
      url: "/v1/meetings",
      headers: bearer(host.token),
      payload: { scheduled_start: "2026-09-10T09:30:00Z", scheduled_end: "2026-09-10T09:00:00Z" },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("VALIDATION");
    const malformed = await ctx.app.inject({
      method: "POST",
      url: "/v1/meetings",
      headers: { ...bearer(host.token), "content-type": "application/json" },
      payload: "{oops",
    });
    expect(malformed.statusCode).toBe(400);
    const anon = await ctx.app.inject({ method: "POST", url: "/v1/meetings", payload: {} });
    expect(anon.statusCode).toBe(401);
  });

  it("retries on a meeting code collision", async () => {
    let draws = 0;
    const rng = () => (draws++ < 20 ? 0 : 1);
    const local = await createTestContext({}, { codeRng: rng });
    try {
      const u = await mintUser(local, {});
      const first = await local.app.inject({
        method: "POST",
        url: "/v1/meetings",
        headers: bearer(u.token),
        payload: {},
      });
      expect(first.json().code).toBe("aaa-aaaa-aaa");
      const second = await local.app.inject({
        method: "POST",
        url: "/v1/meetings",
        headers: bearer(u.token),
        payload: {},
      });
      expect(second.statusCode).toBe(201);
      expect(second.json().code).toBe("bbb-bbbb-bbb");
    } finally {
      await local.close();
    }
  });
});

describe("GET /v1/meetings/:id", () => {
  it("returns own-org meetings and hides others", async () => {
    const m = await createMeeting();
    const ok = await ctx.app.inject({
      method: "GET",
      url: `/v1/meetings/${m.id}`,
      headers: bearer(host.token),
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().id).toBe(m.id);
    const stranger = await mintUser(ctx, { org_id: "22222222-2222-4222-8222-222222222222" });
    const hidden = await ctx.app.inject({
      method: "GET",
      url: `/v1/meetings/${m.id}`,
      headers: bearer(stranger.token),
    });
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json().error.code).toBe("MEETING_NOT_FOUND");
    const badId = await ctx.app.inject({
      method: "GET",
      url: "/v1/meetings/not-a-uuid",
      headers: bearer(host.token),
    });
    expect(badId.statusCode).toBe(400);
  });
});

describe("PATCH /v1/meetings/:id", () => {
  it("lets the organizer update title, schedule and settings, including nulls", async () => {
    const m = await createMeeting(host.token, { title: "Old" });
    const res = await ctx.app.inject({
      method: "PATCH",
      url: `/v1/meetings/${m.id}`,
      headers: bearer(host.token),
      payload: { title: null, settings: { lobby: false } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().title).toBeNull();
    expect(res.json().settings).toEqual({ lobby: false, max_participants: 500 });
  });

  it("is organizer only", async () => {
    const m = await createMeeting();
    const colleague = await mintUser(ctx, { org_id: host.orgId });
    const res = await ctx.app.inject({
      method: "PATCH",
      url: `/v1/meetings/${m.id}`,
      headers: bearer(colleague.token),
      payload: { title: "Hijack" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
  });
});

describe("DELETE /v1/meetings/:id", () => {
  it("cancels a scheduled meeting", async () => {
    const m = await createMeeting();
    const res = await ctx.app.inject({
      method: "DELETE",
      url: `/v1/meetings/${m.id}`,
      headers: bearer(host.token),
    });
    expect(res.statusCode).toBe(204);
    const after = await ctx.app.inject({
      method: "GET",
      url: `/v1/meetings/${m.id}`,
      headers: bearer(host.token),
    });
    expect(after.json().status).toBe("cancelled");
  });

  it("refuses to cancel a live meeting", async () => {
    const m = await createMeeting();
    await startSession(ctx.db, m.id);
    const res = await ctx.app.inject({
      method: "DELETE",
      url: `/v1/meetings/${m.id}`,
      headers: bearer(host.token),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("CONFLICT");
  });
});

describe("POST /v1/meetings/:id::end", () => {
  it("returns NOT_LIVE when there is no live session", async () => {
    const m = await createMeeting();
    const res = await ctx.app.inject({
      method: "POST",
      url: `/v1/meetings/${m.id}:end`,
      headers: bearer(host.token),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("NOT_LIVE");
  });

  it("ends the live session, marks the meeting ended and notifies the room controller", async () => {
    const m = await createMeeting();
    const sessionId = await startSession(ctx.db, m.id);
    const sub = new Redis(testRedisUrl());
    await sub.subscribe(ctlChannel(sessionId));
    const message = new Promise<string>((resolve) => sub.on("message", (_c, msg) => resolve(msg)));
    try {
      const res = await ctx.app.inject({
        method: "POST",
        url: `/v1/meetings/${m.id}:end`,
        headers: bearer(host.token),
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({ session_id: sessionId });
      expect(JSON.parse(await message)).toEqual({ cmd: "end", reason: "api_end" });
      const [session] = await ctx.db`SELECT ended_at FROM meeting_sessions WHERE id = ${sessionId}`;
      expect(session?.endedAt).toBeInstanceOf(Date);
      const after = await ctx.app.inject({
        method: "GET",
        url: `/v1/meetings/${m.id}`,
        headers: bearer(host.token),
      });
      expect(after.json().status).toBe("ended");
    } finally {
      await sub.quit();
    }
  });

  it("is organizer only", async () => {
    const m = await createMeeting();
    await startSession(ctx.db, m.id);
    const colleague = await mintUser(ctx, { org_id: host.orgId });
    const res = await ctx.app.inject({
      method: "POST",
      url: `/v1/meetings/${m.id}:end`,
      headers: bearer(colleague.token),
    });
    expect(res.statusCode).toBe(403);
  });
});
