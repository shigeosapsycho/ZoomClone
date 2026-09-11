import { createHmac } from "node:crypto";
import type { IceServer } from "@zoomclone/protocol";

export type IceConfig = {
  stunUrls: string[];
  turnUrls: string[];
  turnSecret?: string;
  turnTtlSeconds: number;
};

/**
 * Spec 6.1: TURN credentials are pre-issued in /join so the client gathers relay candidates in
 * parallel with signaling. Credentials follow coturn's use-auth-secret (TURN REST API) scheme.
 */
export function buildIceServers(cfg: IceConfig, participantId: string, now: Date): IceServer[] {
  const servers: IceServer[] = [];
  if (cfg.stunUrls.length > 0) servers.push({ urls: cfg.stunUrls });
  if (cfg.turnUrls.length > 0 && cfg.turnSecret) {
    const expiry = Math.floor(now.getTime() / 1000) + cfg.turnTtlSeconds;
    const username = `${expiry}:${participantId}`;
    const credential = createHmac("sha1", cfg.turnSecret).update(username).digest("base64");
    servers.push({ urls: cfg.turnUrls, username, credential });
  }
  return servers;
}
