import { createHmac } from "node:crypto";
import {
  JoinResponseSchema,
  MeetingResponseSchema,
  type JoinResponse,
  type MeetingResponse,
} from "@zoomclone/protocol";
import { verifySignalingToken } from "@zoomclone/tokens";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bearer, createTestContext, mintUser, type TestContext } from "../../test/helpers";

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

async function createMeeting(settings: Record<string, unknown> = {}): Promise<MeetingResponse> {
  const res = await ctx.app.inject({
    method: "POST",
    url: "/v1/meetings",
    headers: bearer(host.token),
    payload: { settings },
  });
  expect(res.statusCode, res.body).toBe(201);
  return MeetingResponseSchema.parse(res.json());
}

function join(
  code: string,
  opts: { token?: string; name?: string; remoteAddress?: string; app?: TestContext["app"] } = {},
) {
  return (opts.app ?? ctx.app).inject({
    method: "POST",
    url: "/v1/join",
    headers: opts.token ? bearer(opts.token) : {},
    remoteAddress: opts.remoteAddress,
    payload: { code, display_name: opts.name ?? "Guest" },
  });
}

async function grant(code: string, opts: Parameters<typeof join>[1] = {}): Promise<JoinResponse> {
  const res = await join(code, opts);
  expect(res.statusCode, res.body).toBe(200);
  return JoinResponseSchema.parse(res.json());
}

describe("POST /v1/join", () => {
  it("returns 404 for unknown and malformed codes", async () => {
    for (const code of ["zzz-zzzz-zzz", "nope", ""]) {
      const res = await join(code);
      expect(res.statusCode, code).toBe(code === "" ? 400 : 404);
      if (code !== "") expect(res.json().error.code).toBe("MEETING_NOT_FOUND");
    }
  });

  it("guest join starts the session and returns an attendee grant behind the lobby", async () => {
    const m = await createMeeting();
    const g = await grant(m.code.toUpperCase(), { name: "Ana" });
    expect(g.role).toBe("attendee");
    expect(g.lobby).toBe(true);
    expect(g.region).toBe(m.region);
    expect(g.signaling_url).toBe(`${ctx.env.SIGNALING_PUBLIC_URL}/rooms/${g.session_id}`);

    const claims = await verifySignalingToken(
      g.signaling_token,
      ctx.deps.keys.publicKey,
      ctx.env.TOKEN_ISSUER,
    );
    expect(claims).toMatchObject({
      session_id: g.session_id,
      participant_id: g.participant_id,
      role: "attendee",
      lobby: true,
      sfu_hint: ctx.env.SFU_ID,
      display_name: "Ana",
      lobby_enabled: true,
      max_participants: 500,
    });
    expect(claims.exp - claims.iat).toBe(300);

    const [session] = await ctx.db`SELECT * FROM meeting_sessions WHERE id = ${g.session_id}`;
    expect(session?.homeSfuId).toBe(ctx.env.SFU_ID);
    const [meeting] = await ctx.db`SELECT status FROM meetings WHERE id = ${m.id}`;
    expect(meeting?.status).toBe("live");
  });

  it("issues STUN plus time-limited TURN credentials", async () => {
    const m = await createMeeting();
    const g = await grant(m.code);
    expect(g.ice_servers[0]).toEqual({ urls: ["stun:stun.example.com:3478"] });
    const turn = g.ice_servers[1]!;
    expect(turn.urls).toEqual(["turn:turn.example.com:443?transport=tcp"]);
    expect(turn.username).toMatch(new RegExp(`^\\d+:${g.participant_id}$`));
    expect(turn.credential).toBe(
      createHmac("sha1", "turn-secret").update(turn.username!).digest("base64"),
    );
  });

  it("organizer joins as host without lobby and shares the guests' session", async () => {
    const m = await createMeeting();
    const guest = await grant(m.code);
    const h = await grant(m.code, { token: host.token });
    expect(h.role).toBe("host");
    expect(h.lobby).toBe(false);
    expect(h.session_id).toBe(guest.session_id);
    expect(h.participant_id).not.toBe(guest.participant_id);

    const claims = await verifySignalingToken(
      h.signaling_token,
      ctx.deps.keys.publicKey,
      ctx.env.TOKEN_ISSUER,
    );
    expect(claims.lobby).toBe(false);
  });

  it("org members skip the lobby; lobby off skips it for guests", async () => {
    const m = await createMeeting();
    const colleague = await mintUser(ctx, { org_id: host.orgId });
    expect((await grant(m.code, { token: colleague.token })).lobby).toBe(false);
    const stranger = await mintUser(ctx, { org_id: "22222222-2222-4222-8222-222222222222" });
    expect((await grant(m.code, { token: stranger.token })).lobby).toBe(true);
    const open = await createMeeting({ lobby: false });
    expect((await grant(open.code)).lobby).toBe(false);
  });

  it("50 concurrent joins on a fresh meeting create exactly one session", async () => {
    const m = await createMeeting();
    const results = await Promise.all(Array.from({ length: 50 }, () => join(m.code)));
    const sessions = new Set(
      results.map((r) => {
        expect(r.statusCode, r.body).toBe(200);
        return r.json().session_id as string;
      }),
    );
    expect(sessions.size).toBe(1);
    const rows =
      await ctx.db`SELECT count(*)::int AS n FROM meeting_sessions WHERE meeting_id = ${m.id}`;
    expect(rows[0]?.n).toBe(1);
  });

  it("returns 410 for ended and cancelled meetings", async () => {
    const m = await createMeeting();
    await grant(m.code);
    const end = await ctx.app.inject({
      method: "POST",
      url: `/v1/meetings/${m.id}:end`,
      headers: bearer(host.token),
    });
    expect(end.statusCode).toBe(200);
    const after = await join(m.code);
    expect(after.statusCode).toBe(410);
    expect(after.json().error.code).toBe("ENDED");

    const c = await createMeeting();
    await ctx.app.inject({
      method: "DELETE",
      url: `/v1/meetings/${c.id}`,
      headers: bearer(host.token),
    });
    expect((await join(c.code)).statusCode).toBe(410);
  });

  it("honours the controller's lock and capacity from Redis", async () => {
    const m = await createMeeting({ max_participants: 2 });
    const first = await grant(m.code);
    const meta = `{room:${first.session_id}}:meta`;
    await ctx.redis.hset(meta, { status: "live", locked: "true" });
    const locked = await join(m.code);
    expect(locked.statusCode).toBe(403);
    expect(locked.json().error.code).toBe("LOCKED");
    expect((await join(m.code, { token: host.token })).statusCode).toBe(200);

    await ctx.redis.hset(meta, { locked: "false" });
    await ctx.redis.hset(`{room:${first.session_id}}:roster`, { a: "{}", b: "{}" });
    const full = await join(m.code);
    expect(full.statusCode).toBe(429);
    expect(full.json().error.code).toBe("CAPACITY");
  });

  it("starts a new session when Redis says the old one ended idle, 410 when it ended by the host", async () => {
    const m = await createMeeting();
    const a = await grant(m.code);
    await ctx.redis.hset(`{room:${a.session_id}}:meta`, { status: "ended", end_reason: "idle" });
    const b = await grant(m.code);
    expect(b.session_id).not.toBe(a.session_id);
    const [old] = await ctx.db`SELECT ended_at FROM meeting_sessions WHERE id = ${a.session_id}`;
    expect(old?.endedAt).toBeInstanceOf(Date);

    await ctx.redis.hset(`{room:${b.session_id}}:meta`, {
      status: "ended",
      end_reason: "host_end",
    });
    const gone = await join(m.code);
    expect(gone.statusCode).toBe(410);
    const [meeting] = await ctx.db`SELECT status FROM meetings WHERE id = ${m.id}`;
    expect(meeting?.status).toBe("ended");
  });

  it("rejects invalid bearers", async () => {
    const m = await createMeeting();
    expect((await join(m.code, { token: "bad.token.value" })).statusCode).toBe(401);
  });

  it("rate limits per IP and per code with retry-after, and counts errors", async () => {
    const limited = await createTestContext({
      JOIN_RATE_LIMIT: "3",
      JOIN_RATE_LIMIT_PER_CODE: "3",
    });
    try {
      for (let i = 0; i < 3; i++) {
        expect((await join("zzz-zzzz-zzz", { app: limited.app })).statusCode).toBe(404);
      }
      const blocked = await join("zzz-zzzz-zzz", { app: limited.app });
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json().error.code).toBe("RATE_LIMITED");
      expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);

      for (let i = 0; i < 3; i++) {
        const res = await join("yyy-yyyy-yyy", {
          app: limited.app,
          remoteAddress: `10.0.0.${i + 1}`,
        });
        expect(res.statusCode).toBe(404);
      }
      const byCode = await join("yyy-yyyy-yyy", { app: limited.app, remoteAddress: "10.0.0.9" });
      expect(byCode.statusCode).toBe(429);

      const metrics = await limited.app.inject({ method: "GET", url: "/metrics" });
      expect(metrics.body).toMatch(/join_errors_total\{code="RATE_LIMITED"\} 2/);
      expect(metrics.body).toMatch(/join_errors_total\{code="MEETING_NOT_FOUND"\} 6/);
    } finally {
      await limited.close();
    }
  });
});
