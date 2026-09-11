import type Redis from "ioredis";

export type RoomState = {
  status: string | null;
  endReason: string | null;
  locked: boolean;
  rosterSize: number;
};

/** Read-only view of the room controller's Redis checkpoint (spec 4.2 key layout). */
export class RoomStateReader {
  constructor(private readonly redis: Redis) {}

  async read(sessionId: string): Promise<RoomState | null> {
    const prefix = `{room:${sessionId}}`;
    const meta = await this.redis.hgetall(`${prefix}:meta`);
    if (Object.keys(meta).length === 0) return null;
    const rosterSize = await this.redis.hlen(`${prefix}:roster`);
    return {
      status: meta["status"] ?? null,
      endReason: meta["end_reason"] ?? null,
      locked: meta["locked"] === "true",
      rosterSize,
    };
  }
}
