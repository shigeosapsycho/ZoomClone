import { randomUUID } from "node:crypto";
import Redis from "ioredis";
import postgres from "postgres";
import { JoinResponseSchema, type JoinResponse } from "@zoomclone/protocol";
import { DATABASE_URL, REDIS_URL } from "./global-setup";
import { API_URL } from "./services";

export type Api = {
  hostToken: (name?: string) => Promise<string>;
  createMeeting: (
    token: string,
    settings?: { lobby?: boolean; max_participants?: number },
  ) => Promise<{ id: string; code: string }>;
  join: (code: string, name: string, token?: string) => Promise<JoinResponse>;
  joinError: (
    code: string,
    name: string,
    token?: string,
  ) => Promise<{ status: number; code: string }>;
  endMeeting: (token: string, id: string) => Promise<number>;
  sessionEnded: (sessionId: string) => Promise<boolean>;
  roomLocked: (sessionId: string) => Promise<boolean>;
  close: () => Promise<void>;
};

export function createApi(): Api {
  const sql = postgres(DATABASE_URL, { max: 2 });
  const redis = new Redis(REDIS_URL, { lazyConnect: true });
  const headers = (token?: string) => ({
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  });
  return {
    async hostToken(name = "Host") {
      // The dev issuer wants a UUID subject; a fresh one per call keeps every host distinct.
      const res = await fetch(`${API_URL}/dev/oidc/token`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ sub: randomUUID(), name }),
      });
      if (!res.ok) throw new Error(`dev token failed: ${res.status} ${await res.text()}`);
      const json = (await res.json()) as { access_token: string };
      return json.access_token;
    },
    async createMeeting(token, settings = {}) {
      const res = await fetch(`${API_URL}/v1/meetings`, {
        method: "POST",
        headers: headers(token),
        body: JSON.stringify({ title: "e2e", settings }),
      });
      if (!res.ok) throw new Error(`create meeting failed: ${res.status} ${await res.text()}`);
      const json = (await res.json()) as { id: string; code: string };
      return { id: json.id, code: json.code };
    },
    async join(code, name, token) {
      const res = await fetch(`${API_URL}/v1/join`, {
        method: "POST",
        headers: headers(token),
        body: JSON.stringify({ code, display_name: name }),
      });
      if (!res.ok) throw new Error(`join failed: ${res.status} ${await res.text()}`);
      return JoinResponseSchema.parse(await res.json());
    },
    async joinError(code, name, token) {
      const res = await fetch(`${API_URL}/v1/join`, {
        method: "POST",
        headers: headers(token),
        body: JSON.stringify({ code, display_name: name }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: { code?: string } };
      return { status: res.status, code: json.error?.code ?? "" };
    },
    async endMeeting(token, id) {
      // The route is "/meetings/:id(^[^:/]+)::end", where "::" is find-my-way's escaped colon.
      // No body, so no content type: Fastify answers 400 to an empty application/json body.
      const res = await fetch(`${API_URL}/v1/meetings/${id}:end`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      return res.status;
    },
    async sessionEnded(sessionId) {
      const [row] = await sql<
        { endedAt: Date | null }[]
      >`SELECT ended_at AS "endedAt" FROM meeting_sessions WHERE id = ${sessionId}`;
      return row?.endedAt !== null && row?.endedAt !== undefined;
    },
    // /join reads the lock from the controller's write-behind checkpoint (spec 4.2 key layout),
    // which lands a checkpoint window after the room.updated event the clients see.
    async roomLocked(sessionId) {
      return (await redis.hget(`{room:${sessionId}}:meta`, "locked")) === "true";
    },
    close: async () => {
      await sql.end();
      redis.disconnect();
    },
  };
}
