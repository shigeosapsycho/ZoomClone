import { createClient, type Client } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { SfuService } from "@zoomclone/sfu-proto";
import type { Logger } from "pino";
import { rpcClientLog } from "./rpc-log";

export class UnknownSfuError extends Error {
  constructor(sfuId: string) {
    super(`unknown sfu ${sfuId}`);
    this.name = "UnknownSfuError";
  }
}

/** sfu_id -> Connect client (design doc: static map from env now, registry-backed later). */
export class SfuDirectory {
  private readonly clients = new Map<string, Client<typeof SfuService>>();

  constructor(
    private readonly endpoints: Record<string, string>,
    private readonly log?: Logger,
  ) {}

  has(sfuId: string): boolean {
    return sfuId in this.endpoints;
  }

  ids(): string[] {
    return Object.keys(this.endpoints);
  }

  get(sfuId: string): Client<typeof SfuService> {
    const cached = this.clients.get(sfuId);
    if (cached) return cached;
    const baseUrl = this.endpoints[sfuId];
    if (!baseUrl) throw new UnknownSfuError(sfuId);
    // Keepalive pings: an idle room's Stats stream carries no frames, so without them a NAT or
    // proxy could drop the h2 connection unnoticed.
    const client = createClient(
      SfuService,
      createGrpcTransport({
        baseUrl,
        pingIntervalMs: 10_000,
        interceptors: this.log ? [rpcClientLog(this.log, sfuId)] : [],
      }),
    );
    this.clients.set(sfuId, client);
    return client;
  }
}
