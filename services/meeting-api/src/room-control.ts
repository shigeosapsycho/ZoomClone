import type Redis from "ioredis";
import type { EndReason } from "@zoomclone/db";

/** Control plane to room controller commands (design doc: Redis pub/sub channel per session). */
export interface RoomControl {
  publishEnd(sessionId: string, reason: EndReason): Promise<void>;
}

export function ctlChannel(sessionId: string): string {
  return `room:${sessionId}:ctl`;
}

export class RedisRoomControl implements RoomControl {
  constructor(private readonly redis: Redis) {}

  async publishEnd(sessionId: string, reason: EndReason): Promise<void> {
    await this.redis.publish(ctlChannel(sessionId), JSON.stringify({ cmd: "end", reason }));
  }
}
