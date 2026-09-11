import type { TransportParams } from "@zoomclone/protocol";
import { TransportDirection, type Snapshot } from "@zoomclone/sfu-proto";
import { parseArray, parseObject } from "../sfu/codec";

export type ConsumerBinding = {
  consumer_id: string;
  track_id: string;
  participant_id: string;
  producer_id: string;
  /** The client sent consumer_ready (or the consumer predates this controller). */
  ready: boolean;
  paused_pref: boolean;
  max_layer: number;
  priority: number;
};
export type Transports = { send?: TransportParams; recv?: TransportParams };
export type Direction = "send" | "recv";

export const DEFAULT_MAX_LAYER = 2;
export const DEFAULT_PRIORITY = 1;

/**
 * SFU ids and client-facing parameters for one room (design doc "MediaBindings"). Never
 * checkpointed: a restarted controller rebuilds it from the Stats snapshot.
 */
export class MediaBindings {
  private readonly transports = new Map<string, Transports>();
  private readonly transportOwners = new Map<
    string,
    { participant_id: string; direction: Direction }
  >();
  private readonly producersByTrack = new Map<string, { producer_id: string; owner: string }>();
  private readonly tracksByProducer = new Map<string, string>();
  private readonly consumersById = new Map<string, ConsumerBinding>();
  private readonly caps = new Map<string, Record<string, unknown>>();

  transportsOf(participantId: string): Transports {
    return { ...(this.transports.get(participantId) ?? {}) };
  }

  transport(participantId: string, direction: Direction): TransportParams | undefined {
    return this.transports.get(participantId)?.[direction];
  }

  setTransports(participantId: string, t: { send: TransportParams; recv: TransportParams }): void {
    this.transports.set(participantId, { send: t.send, recv: t.recv });
    this.transportOwners.set(t.send.id, { participant_id: participantId, direction: "send" });
    this.transportOwners.set(t.recv.id, { participant_id: participantId, direction: "recv" });
  }

  removeTransport(transportId: string): void {
    const owner = this.transportOwners.get(transportId);
    if (!owner) return;
    this.transportOwners.delete(transportId);
    const entry = this.transports.get(owner.participant_id);
    if (entry) delete entry[owner.direction];
  }

  /** Everything owned by the participant: transports, producers, consumers, capabilities. */
  clearParticipant(participantId: string): void {
    const entry = this.transports.get(participantId);
    for (const t of [entry?.send, entry?.recv]) if (t) this.transportOwners.delete(t.id);
    this.transports.delete(participantId);
    for (const [trackId, p] of this.producersByTrack) {
      if (p.owner === participantId) this.removeProducer(p.producer_id);
      void trackId;
    }
    for (const [id, c] of this.consumersById)
      if (c.participant_id === participantId) this.consumersById.delete(id);
    this.caps.delete(participantId);
  }

  addProducer(trackId: string, producerId: string, owner: string): void {
    this.producersByTrack.set(trackId, { producer_id: producerId, owner });
    this.tracksByProducer.set(producerId, trackId);
  }

  producerOf(trackId: string): string | undefined {
    return this.producersByTrack.get(trackId)?.producer_id;
  }

  trackOf(producerId: string): string | undefined {
    return this.tracksByProducer.get(producerId);
  }

  /** Also forgets consumers of that producer (the SFU closes them with it). */
  removeProducer(producerId: string): void {
    const trackId = this.tracksByProducer.get(producerId);
    this.tracksByProducer.delete(producerId);
    if (trackId !== undefined) this.producersByTrack.delete(trackId);
    for (const [id, c] of this.consumersById)
      if (c.producer_id === producerId) this.consumersById.delete(id);
  }

  addConsumer(binding: ConsumerBinding): void {
    this.consumersById.set(binding.consumer_id, binding);
  }

  consumerOf(participantId: string, trackId: string): ConsumerBinding | undefined {
    for (const c of this.consumersById.values()) {
      if (c.participant_id === participantId && c.track_id === trackId) return c;
    }
    return undefined;
  }

  consumerById(consumerId: string): ConsumerBinding | undefined {
    return this.consumersById.get(consumerId);
  }

  consumersOf(participantId: string): Map<string, ConsumerBinding> {
    const out = new Map<string, ConsumerBinding>();
    for (const c of this.consumersById.values())
      if (c.participant_id === participantId) out.set(c.track_id, c);
    return out;
  }

  removeConsumer(consumerId: string): void {
    this.consumersById.delete(consumerId);
  }

  setCapabilities(participantId: string, caps: Record<string, unknown>): void {
    this.caps.set(participantId, caps);
  }

  capabilities(participantId: string): Record<string, unknown> | undefined {
    return this.caps.get(participantId);
  }

  /** Rebuild from the SFU's view. Client capabilities survive (they never leave the controller). */
  replaceFromSnapshot(snapshot: Snapshot): void {
    this.transports.clear();
    this.transportOwners.clear();
    this.producersByTrack.clear();
    this.tracksByProducer.clear();
    this.consumersById.clear();
    for (const t of snapshot.transports) {
      const direction: Direction | null =
        t.direction === TransportDirection.SEND
          ? "send"
          : t.direction === TransportDirection.RECV
            ? "recv"
            : null;
      if (!direction) continue;
      const params: TransportParams = {
        id: t.transportId,
        ice_parameters: parseObject(t.iceParametersJson, "ice parameters"),
        ice_candidates: parseArray(t.iceCandidatesJson, "ice candidates"),
        dtls_parameters: parseObject(t.dtlsParametersJson, "dtls parameters"),
      };
      const entry = this.transports.get(t.participantId) ?? {};
      entry[direction] = params;
      this.transports.set(t.participantId, entry);
      this.transportOwners.set(t.transportId, { participant_id: t.participantId, direction });
    }
    for (const p of snapshot.producers) {
      if (!p.meta) continue;
      this.addProducer(p.meta.trackId, p.producerId, p.meta.participantId);
    }
    for (const c of snapshot.consumers) {
      const trackId = this.tracksByProducer.get(c.producerId);
      if (trackId === undefined) continue;
      this.addConsumer({
        consumer_id: c.consumerId,
        track_id: trackId,
        participant_id: c.participantId,
        producer_id: c.producerId,
        ready: true,
        paused_pref: c.paused,
        max_layer: c.preferredSpatialLayer ?? DEFAULT_MAX_LAYER,
        priority: c.priority || DEFAULT_PRIORITY,
      });
    }
  }
}
