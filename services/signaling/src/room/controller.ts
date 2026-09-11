import { ConnectError, type Client } from "@connectrpc/connect";
import { endSession, type Db, type EndReason } from "@zoomclone/db";
import type { EventBus } from "@zoomclone/events";
import {
  CloseCode,
  type ClientMessage,
  type ConsumerParams,
  type HelloAck,
  type MediaParams,
  type MediaSource,
  type RoomEvent,
  type RosterEntry,
  type SignalingClaims,
  type SubscriptionPref,
  type TrackInfo,
  type TransportParams,
  type Welcome,
  type WsErrorCode,
} from "@zoomclone/protocol";
import {
  TransportDirection,
  type SfuService,
  type Snapshot,
  type StatsEvent,
} from "@zoomclone/sfu-proto";
import type { Logger } from "pino";
import type { ParticipantLink } from "../gateway/link";
import {
  SfuPayloadError,
  describeSfuError,
  isNotFound,
  kindFromPb,
  kindToPb,
  parseArray,
  parseObject,
  sourceFromPb,
  sourceToPb,
} from "../sfu/codec";
import { StatsConsumer } from "../sfu/stats-consumer";
import { ActiveSpeakerTracker } from "./active-speakers";
import type { Checkpoint, OwnerLease } from "./checkpoint";
import {
  DEFAULT_MAX_LAYER,
  DEFAULT_PRIORITY,
  MediaBindings,
  type ConsumerBinding,
} from "./media-bindings";
import type { Room } from "./room";
import type { Command, Emitted, RoomError, Target } from "./types";

export class RoomFailure extends Error {
  constructor(readonly failure: RoomError) {
    super(failure.message);
    this.name = "RoomFailure";
  }
}

export type ControllerTimings = {
  graceMs: number;
  idleMs: number;
  heartbeatMs: number;
  speakerTickMs: number;
  statsRetryMs: number;
};

export type ControllerMetrics = { resync(): void; replay(): void };

export type ControllerDeps = {
  room: Room;
  sfu: Client<typeof SfuService>;
  checkpoint: Checkpoint;
  lease: OwnerLease;
  db: Db;
  bus: EventBus;
  log: Logger;
  timings: ControllerTimings;
  metrics?: ControllerMetrics;
  /** Called once the controller is gone (room ended or controller closed); the registry drops it. */
  onGone: (sessionId: string) => void;
};

export type ControllerMessage = Exclude<ClientMessage, { type: "hello" | "ping" }>;
export type HelloPayload = { id: string; resume_seq?: number; epoch?: number };
type PayloadOf<T extends ClientMessage["type"]> = Extract<ClientMessage, { type: T }>["payload"];
type Reply = { ack: Record<string, unknown>; after?: () => Promise<void> };

const CLOSE_BY_DEPARTED = {
  removed: CloseCode.REMOVED,
  denied: CloseCode.LOBBY_DENIED,
  grace: CloseCode.REJOIN_REQUIRED,
} as const;

export function toWsError(error: unknown): { code: WsErrorCode; message: string } {
  if (error instanceof RoomFailure)
    return { code: error.failure.code, message: error.failure.message };
  if (error instanceof ConnectError || error instanceof SfuPayloadError) {
    return { code: "SFU_ERROR", message: describeSfuError(error) };
  }
  return { code: "INTERNAL", message: "internal error" };
}

/**
 * One live session (design doc "room/RoomController.ts"): turns socket messages into SFU calls
 * plus Room commands (SFU first, Room after), fans events to links, publishes bus events,
 * schedules checkpoints, runs the grace and idle timers and consumes the SFU Stats stream.
 */
export class RoomController {
  readonly room: Room;
  private readonly links = new Map<string, ParticipantLink>();
  private readonly graceTimers = new Map<string, NodeJS.Timeout>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly bindings = new MediaBindings();
  private readonly tracker: ActiveSpeakerTracker;
  private readonly stats: StatsConsumer;
  private rtpCapabilities: Record<string, unknown> = {};
  private idleTimer: NodeJS.Timeout | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private speakerTimer: NodeJS.Timeout | null = null;
  private ending: Promise<void> | null = null;
  private gone = false;

  constructor(private readonly deps: ControllerDeps) {
    this.room = deps.room;
    this.tracker = new ActiveSpeakerTracker((ids) => this.onActiveSpeakers(ids));
    this.stats = new StatsConsumer(
      deps.sfu,
      this.room.sessionId,
      {
        beforeOpen: () => this.allocate(),
        onSnapshot: (snapshot) => this.reconcile(snapshot),
        onEvent: (event) => this.onStatsEvent(event),
      },
      deps.log,
      deps.timings.statsRetryMs,
    );
  }

  get sessionId(): string {
    return this.room.sessionId;
  }
  get connectionCount(): number {
    return this.links.size;
  }
  get isGone(): boolean {
    return this.gone;
  }

  /** AllocateRoom, first Stats snapshot (reconciled), initial checkpoint, timers. */
  async start(): Promise<void> {
    await this.stats.start();
    await this.deps.checkpoint.writeAll();
    this.heartbeat = setInterval(() => void this.heartbeatTick(), this.deps.timings.heartbeatMs);
    this.speakerTimer = setInterval(
      () => this.tracker.tick(Date.now()),
      this.deps.timings.speakerTickMs,
    );
    for (const entry of this.room.roster()) {
      if (!entry.connected) this.startGrace(entry.participant_id);
    }
    this.armIdle();
  }

  // ---- hello ----

  /** Returns the participant id once the link is attached, or null when the link was closed. */
  attach(
    link: ParticipantLink,
    claims: SignalingClaims,
    hello: HelloPayload,
  ): Promise<string | null> {
    return this.withLock(claims.participant_id, () => this.doAttach(link, claims, hello));
  }

  private async doAttach(
    link: ParticipantLink,
    claims: SignalingClaims,
    hello: HelloPayload,
  ): Promise<string | null> {
    const pid = claims.participant_id;
    if (this.gone || this.room.status === "ended") {
      link.close(CloseCode.ROOM_ENDED, "room ended");
      return null;
    }
    const departed = this.room.departed(pid);
    if (departed) {
      link.close(CLOSE_BY_DEPARTED[departed], `departed: ${departed}`);
      return null;
    }
    this.cancelGrace(pid);
    try {
      if (this.room.inRoster(pid)) return await this.resume(link, pid, hello);
      if (this.room.inLobby(pid)) {
        this.takeover(pid, link);
        this.sendSnapshot(link, hello.id, "welcome", this.room.welcomeFor(pid));
        return pid;
      }
      return await this.freshJoin(link, claims, hello.id);
    } catch (error) {
      this.deps.log.warn(
        { sessionId: this.sessionId, participantId: pid, error: describeSfuError(error) },
        "hello failed",
      );
      link.send({ type: "error", id: hello.id, payload: toWsError(error) });
      link.close(
        error instanceof RoomFailure ? (error.failure.close ?? 1008) : 1011,
        "hello failed",
      );
      if (this.room.inRoster(pid) && !this.links.has(pid)) this.startGrace(pid);
      return null;
    }
  }

  private async resume(link: ParticipantLink, pid: string, hello: HelloPayload): Promise<string> {
    const media = await this.ensureTransports(pid);
    if (!this.room.inRoster(pid)) {
      await this.closeTransports(pid);
      throw new RoomFailure({
        code: "NOT_FOUND",
        message: "left the room during hello",
        close: CloseCode.REJOIN_REQUIRED,
      });
    }
    this.takeover(pid, link);
    this.applyOrThrow({ type: "reconnect", participant_id: pid });
    const replay =
      hello.resume_seq !== undefined && hello.epoch === this.room.epoch
        ? this.room.replay(pid, hello.resume_seq)
        : null;
    if (replay) {
      this.sendAck(link, hello.id, "replay");
      for (const event of replay) link.send(event);
      this.deps.metrics?.replay();
    } else {
      this.sendSnapshot(link, hello.id, "resync", { ...this.room.welcomeFor(pid), media });
      this.deps.metrics?.resync();
    }
    return pid;
  }

  private async freshJoin(
    link: ParticipantLink,
    claims: SignalingClaims,
    helloId: string,
  ): Promise<string | null> {
    const pid = claims.participant_id;
    if (claims.lobby) {
      const outcome = this.room.apply({
        type: "lobby_request",
        participant_id: pid,
        name: claims.display_name,
      });
      if (!outcome.ok) {
        this.reject(link, helloId, outcome.error);
        return null;
      }
      this.takeover(pid, link);
      this.afterApply(outcome.events);
      this.sendSnapshot(link, helloId, "welcome", this.room.welcomeFor(pid));
      return pid;
    }
    const early = this.room.canJoin(pid, claims.role);
    if (early) {
      this.reject(link, helloId, early);
      return null;
    }
    const media = await this.createTransports(pid);
    const outcome = this.room.apply({
      type: "join",
      participant_id: pid,
      name: claims.display_name,
      role: claims.role,
    });
    if (!outcome.ok) {
      await this.closeTransports(pid);
      this.reject(link, helloId, outcome.error);
      return null;
    }
    this.takeover(pid, link);
    this.afterApply(outcome.events);
    this.sendSnapshot(link, helloId, "welcome", { ...this.room.welcomeFor(pid), media });
    return pid;
  }

  /** Newest socket wins: the previous one closes 4005 and its close callback is ignored. */
  private takeover(pid: string, link: ParticipantLink): void {
    const previous = this.links.get(pid);
    this.links.set(pid, link);
    if (previous && previous !== link)
      previous.close(CloseCode.REPLACED, "replaced by a newer connection");
  }

  private reject(link: ParticipantLink, helloId: string, error: RoomError): void {
    link.send({
      type: "error",
      id: helloId,
      payload: { code: error.code, message: error.message },
    });
    link.close(error.close ?? 1008, error.message);
  }

  private sendAck(link: ParticipantLink, id: string, mode: HelloAck["mode"]): void {
    const payload: HelloAck = { mode, epoch: this.room.epoch, seq: this.room.seq };
    link.send({ type: "ack", id, payload });
  }

  private sendSnapshot(
    link: ParticipantLink,
    id: string,
    mode: "welcome" | "resync",
    payload: Welcome,
  ): void {
    this.sendAck(link, id, mode);
    link.send({ type: mode, payload });
  }

  // ---- requests ----

  async handle(link: ParticipantLink, pid: string, message: ControllerMessage): Promise<void> {
    if (this.links.get(pid) !== link) return;
    let reply: Reply;
    try {
      reply = await this.dispatch(pid, message);
    } catch (error) {
      if (!(error instanceof RoomFailure)) {
        this.deps.log.warn(
          {
            sessionId: this.sessionId,
            participantId: pid,
            type: message.type,
            error: describeSfuError(error),
          },
          "request failed",
        );
      }
      link.send({ type: "error", id: message.id, payload: toWsError(error) });
      return;
    }
    link.send({ type: "ack", id: message.id, payload: reply.ack });
    if (reply.after) await reply.after();
  }

  private async dispatch(pid: string, message: ControllerMessage): Promise<Reply> {
    switch (message.type) {
      case "connect_transport": {
        const transport = this.bindings.transport(pid, message.payload.transport);
        if (!transport) throw new RoomFailure({ code: "NOT_FOUND", message: "no such transport" });
        await this.deps.sfu.connectTransport({
          transportId: transport.id,
          dtlsParametersJson: JSON.stringify(message.payload.dtls_parameters),
        });
        return { ack: {} };
      }
      case "publish":
        return { ack: await this.publish(pid, message.payload) };
      case "unpublish":
        await this.unpublish(pid, message.payload.track_id);
        return { ack: {} };
      case "subscribe":
        return { ack: await this.subscribe(pid, message.payload) };
      case "consumer_ready":
        await this.consumerReady(pid, message.payload.track_id);
        return { ack: {} };
      case "set_media_state":
        await this.setMediaState(pid, message.payload.muted, message.payload.video_off);
        return { ack: {} };
      case "raise_hand":
        this.applyOrThrow({ type: "hand", participant_id: pid, raised: true });
        return { ack: {} };
      case "lower_hand":
        this.applyOrThrow({ type: "hand", participant_id: pid, raised: false });
        return { ack: {} };
      case "reaction":
        this.applyOrThrow({ type: "reaction", from: pid, emoji: message.payload.emoji });
        return { ack: {} };
      case "chat":
        this.applyOrThrow(
          message.payload.to === undefined
            ? { type: "chat", from: pid, body: message.payload.body }
            : { type: "chat", from: pid, body: message.payload.body, to: message.payload.to },
        );
        return { ack: {} };
      case "host.admit":
        await this.admit(pid, message.payload.participant_id);
        return { ack: {} };
      case "host.deny":
        this.deny(pid, message.payload.participant_id);
        return { ack: {} };
      case "host.mute":
        await this.hostMute(pid, message.payload.participant_id);
        return { ack: {} };
      case "host.remove":
        await this.remove(pid, message.payload.participant_id);
        return { ack: {} };
      case "host.lock":
        this.requireHost(pid);
        this.applyOrThrow({ type: "lock", actor: pid, locked: message.payload.locked });
        this.audit(pid, message.payload.locked ? "lock" : "unlock");
        return { ack: {} };
      case "host.end":
        this.requireHost(pid);
        this.audit(pid, "end");
        return { ack: {}, after: () => this.endRoom("host_end") };
      case "restart_ice":
        throw new RoomFailure({
          code: "NOT_IMPLEMENTED",
          message: "restart_ice is not implemented",
        });
    }
  }

  private requireHost(pid: string): void {
    if (!this.room.isHost(pid))
      throw new RoomFailure({ code: "FORBIDDEN", message: "host role required" });
  }

  private requireJoined(pid: string): RosterEntry {
    const entry = this.room.rosterEntry(pid);
    if (!entry) throw new RoomFailure({ code: "NOT_FOUND", message: "not in the room" });
    return entry;
  }

  private applyOrThrow(command: Command): Emitted[] {
    const outcome = this.room.apply(command);
    if (!outcome.ok) throw new RoomFailure(outcome.error);
    this.afterApply(outcome.events);
    return outcome.events;
  }

  // ---- media ----

  private async createTransport(pid: string, direction: "send" | "recv"): Promise<TransportParams> {
    const res = await this.deps.sfu.createTransport({
      sessionId: this.sessionId,
      participantId: pid,
      direction: direction === "send" ? TransportDirection.SEND : TransportDirection.RECV,
    });
    return {
      id: res.transportId,
      ice_parameters: parseObject(res.iceParametersJson, "ice parameters"),
      ice_candidates: parseArray(res.iceCandidatesJson, "ice candidates"),
      dtls_parameters: parseObject(res.dtlsParametersJson, "dtls parameters"),
    };
  }

  /** Both transports or none (design doc ordering rule): a failed second call closes the first. */
  private async createTransports(pid: string): Promise<MediaParams> {
    const send = await this.createTransport(pid, "send");
    let recv: TransportParams;
    try {
      recv = await this.createTransport(pid, "recv");
    } catch (error) {
      await this.deps.sfu
        .closeTransport({ transportId: send.id })
        .catch((e: unknown) => this.warn("rollback closeTransport failed", e));
      throw error;
    }
    this.bindings.setTransports(pid, { send, recv });
    return { rtp_capabilities: this.rtpCapabilities, send_transport: send, recv_transport: recv };
  }

  private async ensureTransports(pid: string): Promise<MediaParams> {
    const existing = this.bindings.transportsOf(pid);
    if (existing.send && existing.recv) {
      return {
        rtp_capabilities: this.rtpCapabilities,
        send_transport: existing.send,
        recv_transport: existing.recv,
      };
    }
    await this.closeTransports(pid);
    return this.createTransports(pid);
  }

  private async closeTransports(pid: string): Promise<void> {
    const { send, recv } = this.bindings.transportsOf(pid);
    this.bindings.clearParticipant(pid);
    for (const transport of [send, recv]) {
      if (!transport) continue;
      await this.deps.sfu.closeTransport({ transportId: transport.id }).catch((error: unknown) => {
        if (!isNotFound(error)) this.warn("closeTransport failed", error);
      });
    }
  }

  private async publish(pid: string, payload: PayloadOf<"publish">): Promise<{ track_id: string }> {
    const entry = this.requireJoined(pid);
    const send = this.bindings.transport(pid, "send");
    if (!send) throw new RoomFailure({ code: "NOT_FOUND", message: "no send transport" });
    const paused =
      payload.paused ||
      (payload.source === "mic" && entry.muted) ||
      (payload.source === "camera" && entry.video_off);
    const res = await this.deps.sfu.publish({
      sessionId: this.sessionId,
      participantId: pid,
      transportId: send.id,
      kind: kindToPb(payload.kind),
      source: sourceToPb(payload.source),
      rtpParametersJson: JSON.stringify(payload.rtp_parameters),
      paused,
    });
    const track: TrackInfo = {
      track_id: res.trackId,
      owner: pid,
      kind: payload.kind,
      source: payload.source,
      paused,
      layers: res.layerCount,
    };
    const outcome = this.room.apply({ type: "publish", participant_id: pid, track });
    if (!outcome.ok) {
      await this.deps.sfu
        .unpublish({ producerId: res.producerId })
        .catch((e: unknown) => this.warn("rollback unpublish failed", e));
      throw new RoomFailure(outcome.error);
    }
    this.bindings.addProducer(track.track_id, res.producerId, pid);
    this.afterApply(outcome.events);
    return { track_id: track.track_id };
  }

  private async unpublish(pid: string, trackId: string): Promise<void> {
    const track = this.room.track(trackId);
    if (!track) throw new RoomFailure({ code: "NOT_FOUND", message: "unknown track" });
    if (track.owner !== pid)
      throw new RoomFailure({ code: "FORBIDDEN", message: "not your track" });
    const producerId = this.bindings.producerOf(trackId);
    if (producerId) {
      await this.deps.sfu.unpublish({ producerId }).catch((error: unknown) => {
        if (!isNotFound(error)) throw error;
      });
      this.bindings.removeProducer(producerId);
    }
    this.applyOrThrow({ type: "unpublish", participant_id: pid, track_id: trackId });
  }

  /** Declarative full set (design doc): create missing consumers, drop extra ones, diff prefs. */
  private async subscribe(
    pid: string,
    payload: PayloadOf<"subscribe">,
  ): Promise<{ consumers: ConsumerParams[]; removed: string[] }> {
    this.requireJoined(pid);
    const recv = this.bindings.transport(pid, "recv");
    if (!recv) throw new RoomFailure({ code: "NOT_FOUND", message: "no recv transport" });
    if (payload.rtp_capabilities) this.bindings.setCapabilities(pid, payload.rtp_capabilities);
    const caps = this.bindings.capabilities(pid);
    if (!caps)
      throw new RoomFailure({
        code: "INVALID",
        message: "rtp_capabilities required on the first subscribe",
      });
    const desired = new Set(
      payload.track_ids.filter((id) => {
        const track = this.room.track(id);
        return track !== undefined && track.owner !== pid;
      }),
    );
    const consumers: ConsumerParams[] = [];
    const removed: string[] = [];
    for (const [trackId, binding] of this.bindings.consumersOf(pid)) {
      if (desired.has(trackId)) continue;
      await this.deps.sfu
        .unsubscribe({ consumerId: binding.consumer_id })
        .catch((error: unknown) => {
          if (!isNotFound(error)) throw error;
        });
      this.bindings.removeConsumer(binding.consumer_id);
      removed.push(trackId);
    }
    for (const trackId of desired) {
      const pref: SubscriptionPref = payload.prefs[trackId] ?? {};
      const existing = this.bindings.consumerOf(pid, trackId);
      if (existing) {
        await this.updatePrefs(existing, pref);
        continue;
      }
      const producerId = this.bindings.producerOf(trackId);
      if (!producerId) continue;
      const res = await this.deps.sfu.subscribe({
        sessionId: this.sessionId,
        participantId: pid,
        transportId: recv.id,
        producerId,
        rtpCapabilitiesJson: JSON.stringify(caps),
        maxSpatialLayer: pref.max_layer,
        priority: pref.priority,
      });
      this.bindings.addConsumer({
        consumer_id: res.consumerId,
        track_id: trackId,
        participant_id: pid,
        producer_id: producerId,
        ready: false,
        paused_pref: pref.paused ?? false,
        max_layer: pref.max_layer ?? DEFAULT_MAX_LAYER,
        priority: pref.priority ?? DEFAULT_PRIORITY,
      });
      consumers.push({
        track_id: trackId,
        consumer_id: res.consumerId,
        kind: kindFromPb(res.kind),
        rtp_parameters: parseObject(res.rtpParametersJson, "rtp parameters"),
        producer_paused: res.producerPaused,
      });
    }
    return { consumers, removed };
  }

  private async updatePrefs(binding: ConsumerBinding, pref: SubscriptionPref): Promise<void> {
    const maxLayer = pref.max_layer ?? DEFAULT_MAX_LAYER;
    const priority = pref.priority ?? DEFAULT_PRIORITY;
    const isVideo = this.room.track(binding.track_id)?.kind === "video";
    if (isVideo && (maxLayer !== binding.max_layer || priority !== binding.priority)) {
      await this.deps.sfu.setLayer({
        consumerId: binding.consumer_id,
        spatialLayer: maxLayer,
        priority,
      });
      binding.max_layer = maxLayer;
      binding.priority = priority;
    }
    const paused = pref.paused ?? false;
    if (paused !== binding.paused_pref) {
      binding.paused_pref = paused;
      if (binding.ready)
        await this.deps.sfu.setConsumerPaused({ consumerId: binding.consumer_id, paused });
    }
  }

  private async consumerReady(pid: string, trackId: string): Promise<void> {
    const binding = this.bindings.consumerOf(pid, trackId);
    if (!binding)
      throw new RoomFailure({ code: "NOT_FOUND", message: "no consumer for that track" });
    if (binding.ready) return;
    binding.ready = true;
    if (!binding.paused_pref) {
      await this.deps.sfu.setConsumerPaused({ consumerId: binding.consumer_id, paused: false });
    }
  }

  private async setMediaState(pid: string, muted?: boolean, videoOff?: boolean): Promise<void> {
    const entry = this.requireJoined(pid);
    await this.pauseProducers(entry, muted, videoOff);
    const command: Command = { type: "set_media_state", participant_id: pid };
    if (muted !== undefined) command.muted = muted;
    if (videoOff !== undefined) command.video_off = videoOff;
    this.applyOrThrow(command);
  }

  /** SFU first: pause or resume the producers the room will mark afterwards. */
  private async pauseProducers(
    entry: RosterEntry,
    muted?: boolean,
    videoOff?: boolean,
  ): Promise<void> {
    const changes: Array<{ source: MediaSource; paused: boolean }> = [];
    if (muted !== undefined && muted !== entry.muted)
      changes.push({ source: "mic", paused: muted });
    if (videoOff !== undefined && videoOff !== entry.video_off)
      changes.push({ source: "camera", paused: videoOff });
    for (const { source, paused } of changes) {
      for (const track of this.room.tracksOf(entry.participant_id, source)) {
        if (track.paused === paused) continue;
        const producerId = this.bindings.producerOf(track.track_id);
        if (producerId) await this.deps.sfu.setProducerPaused({ producerId, paused });
      }
    }
  }

  // ---- host controls ----

  private async admit(actor: string, target: string): Promise<void> {
    this.requireHost(actor);
    if (!this.room.inLobby(target))
      throw new RoomFailure({ code: "NOT_FOUND", message: "not in the lobby" });
    if (this.room.roster().length >= this.room.maxParticipants) {
      throw new RoomFailure({ code: "CAPACITY", message: "meeting is full" });
    }
    const media = await this.createTransports(target);
    const outcome = this.room.apply({ type: "admit", actor, participant_id: target });
    if (!outcome.ok) {
      await this.closeTransports(target);
      throw new RoomFailure(outcome.error);
    }
    this.afterApply(outcome.events);
    this.links
      .get(target)
      ?.send({ type: "resync", payload: { ...this.room.welcomeFor(target), media } });
    this.audit(actor, "admit", target);
  }

  private deny(actor: string, target: string): void {
    this.requireHost(actor);
    this.applyOrThrow({ type: "deny", actor, participant_id: target });
    const link = this.links.get(target);
    if (link) {
      this.links.delete(target);
      link.close(CloseCode.LOBBY_DENIED, "denied by host");
    }
    this.audit(actor, "deny", target);
  }

  private async hostMute(actor: string, target: string): Promise<void> {
    this.requireHost(actor);
    const entry = this.requireJoined(target);
    await this.pauseProducers(entry, true, undefined);
    this.applyOrThrow({ type: "host_mute", actor, participant_id: target });
    this.audit(actor, "mute", target);
  }

  private async remove(actor: string, target: string): Promise<void> {
    this.requireHost(actor);
    const wasInRoster = this.room.inRoster(target);
    this.applyOrThrow({ type: "remove", actor, participant_id: target });
    this.cancelGrace(target);
    const link = this.links.get(target);
    if (link) {
      this.links.delete(target);
      link.close(wasInRoster ? CloseCode.REMOVED : CloseCode.LOBBY_DENIED, "removed by host");
    }
    if (wasInRoster) await this.closeTransports(target);
    this.audit(actor, "remove", target);
  }

  // ---- presence ----

  detach(link: ParticipantLink, pid: string): void {
    if (this.links.get(pid) !== link) return;
    this.links.delete(pid);
    if (this.gone || this.room.status === "ended") return;
    if (this.room.inLobby(pid)) {
      const outcome = this.room.apply({ type: "lobby_leave", participant_id: pid });
      if (outcome.ok) this.afterApply(outcome.events);
      return;
    }
    if (this.room.inRoster(pid)) {
      const outcome = this.room.apply({ type: "disconnect", participant_id: pid });
      if (outcome.ok) this.afterApply(outcome.events);
      this.startGrace(pid);
    }
  }

  private startGrace(pid: string): void {
    this.cancelGrace(pid);
    this.graceTimers.set(
      pid,
      setTimeout(() => {
        this.graceTimers.delete(pid);
        void this.expireGrace(pid);
      }, this.deps.timings.graceMs),
    );
  }

  private cancelGrace(pid: string): void {
    const timer = this.graceTimers.get(pid);
    if (!timer) return;
    clearTimeout(timer);
    this.graceTimers.delete(pid);
  }

  private expireGrace(pid: string): Promise<void> {
    return this.withLock(pid, async () => {
      if (this.gone || this.links.has(pid) || !this.room.inRoster(pid)) return;
      const outcome = this.room.apply({ type: "leave", participant_id: pid });
      if (outcome.ok) this.afterApply(outcome.events);
      await this.closeTransports(pid);
    });
  }

  private armIdle(): void {
    if (this.gone) return;
    if (this.room.isIdle()) {
      if (this.idleTimer) return;
      this.idleTimer = setTimeout(() => {
        this.idleTimer = null;
        void this.endRoom("idle");
      }, this.deps.timings.idleMs);
    } else if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  /** Serializes hello and grace expiry per participant so they never interleave. */
  private withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(fn);
    const settled: Promise<unknown> = run.catch(() => undefined);
    this.locks.set(key, settled);
    void settled.then(() => {
      if (this.locks.get(key) === settled) this.locks.delete(key);
    });
    return run;
  }

  // ---- fanout and bus ----

  private afterApply(events: Emitted[]): void {
    this.fanout(events);
    this.deps.checkpoint.schedule();
    this.armIdle();
  }

  private fanout(events: Emitted[]): void {
    for (const { event, target } of events) {
      for (const pid of this.resolve(target)) this.links.get(pid)?.send(event);
      this.publishBusEvent(event);
    }
  }

  private resolve(target: Target): string[] {
    switch (target.kind) {
      case "all":
        return this.room.rosterIds();
      case "hosts":
        return this.room.rosterIds().filter((id) => this.room.isHost(id));
      case "everyone":
        return [...this.room.rosterIds(), ...this.room.lobbyIds()];
      case "only":
        return target.participant_ids;
      case "all_except":
        return this.room.rosterIds().filter((id) => id !== target.participant_id);
    }
  }

  private publishBusEvent(event: RoomEvent): void {
    const session_id = this.sessionId;
    switch (event.type) {
      case "participant.joined": {
        const p = event.payload.participant;
        this.deps.bus.publish("participant.joined", session_id, {
          session_id,
          participant_id: p.participant_id,
          user_id: null,
          display_name: p.name,
          role: p.role,
          joined_at: p.joined_at,
        });
        return;
      }
      case "participant.left":
        this.deps.bus.publish("participant.left", session_id, {
          session_id,
          participant_id: event.payload.participant_id,
          left_at: new Date().toISOString(),
          reason: event.payload.reason,
        });
        return;
      case "participant.updated":
        this.deps.bus.publish("participant.updated", session_id, {
          session_id,
          participant_id: event.payload.participant_id,
          patch: event.payload.patch,
        });
        return;
      default:
        return;
    }
  }

  private audit(actor: string, action: string, target?: string): void {
    const session_id = this.sessionId;
    this.deps.bus.publish(
      "host.action",
      session_id,
      target === undefined
        ? { session_id, actor_id: actor, action }
        : { session_id, actor_id: actor, action, target_id: target },
    );
  }

  // ---- SFU stats ----

  private async allocate(): Promise<void> {
    const res = await this.deps.sfu.allocateRoom({ sessionId: this.sessionId });
    this.rtpCapabilities = parseObject(res.rtpCapabilitiesJson, "rtp capabilities");
  }

  /** Both-way reconcile with the SFU's view (design doc "RoomRegistry" rehydrate). */
  private reconcile(snapshot: Snapshot): void {
    if (this.gone) return;
    this.bindings.replaceFromSnapshot(snapshot);
    const live = new Map<string, Snapshot["producers"][number]>();
    for (const p of snapshot.producers) {
      if (p.meta && p.meta.origin !== "pipe" && p.meta.trackId) live.set(p.meta.trackId, p);
    }
    for (const track of this.room.tracks()) {
      if (live.has(track.track_id)) continue;
      const outcome = this.room.apply({ type: "track_lost", track_id: track.track_id });
      if (outcome.ok) this.fanout(outcome.events);
    }
    for (const [trackId, p] of live) {
      if (this.room.track(trackId) || !p.meta) continue;
      if (!this.room.inRoster(p.meta.participantId)) {
        void this.deps.sfu
          .unpublish({ producerId: p.producerId })
          .catch((e: unknown) => this.warn("orphan unpublish failed", e));
        this.bindings.removeProducer(p.producerId);
        continue;
      }
      const track: TrackInfo = {
        track_id: trackId,
        owner: p.meta.participantId,
        kind: kindFromPb(p.meta.kind),
        source: sourceFromPb(p.meta.source),
        paused: p.paused,
        layers: p.layerCount,
      };
      const outcome = this.room.apply({
        type: "publish",
        participant_id: p.meta.participantId,
        track,
      });
      if (outcome.ok) this.fanout(outcome.events);
    }
    this.deps.checkpoint.schedule();
    this.armIdle();
  }

  private onStatsEvent(event: StatsEvent): void {
    if (this.gone) return;
    const now = Date.now();
    const e = event.event;
    switch (e.case) {
      case "dominantSpeakers":
        this.tracker.onSample(
          e.value.speakers.map((s) => ({ participant_id: s.participantId, volume: s.volume })),
          now,
        );
        return;
      case "silence":
        this.tracker.onSilence(now);
        return;
      case "consumerLayers": {
        const binding = this.bindings.consumerById(e.value.consumerId);
        if (!binding) return;
        const layers = e.value.active ? e.value.spatialLayer + 1 : 0;
        const outcome = this.room.apply({
          type: "track_layers",
          participant_id: binding.participant_id,
          track_id: binding.track_id,
          layers,
        });
        if (outcome.ok) this.fanout(outcome.events);
        return;
      }
      case "producerClosed": {
        this.bindings.removeProducer(e.value.producerId);
        const outcome = this.room.apply({ type: "track_lost", track_id: e.value.trackId });
        if (outcome.ok && outcome.events.length > 0) this.afterApply(outcome.events);
        return;
      }
      case "consumerClosed":
        this.bindings.removeConsumer(e.value.consumerId);
        return;
      case "transportClosed":
        this.bindings.removeTransport(e.value.transportId);
        return;
      case "iceState":
        this.deps.log.debug(
          { sessionId: this.sessionId, transportId: e.value.transportId, state: e.value.state },
          "ice state",
        );
        return;
      case "qos":
        this.deps.log.debug(
          {
            sessionId: this.sessionId,
            transportId: e.value.transportId,
            sendBitrate: e.value.sendBitrate,
            recvBitrate: e.value.recvBitrate,
            lossSent: e.value.rtpPacketLossSent,
          },
          "qos",
        );
        return;
      default:
        return;
    }
  }

  private onActiveSpeakers(ids: string[]): void {
    if (this.gone || this.room.status === "ended") return;
    const outcome = this.room.apply({ type: "active_speakers", participant_ids: ids });
    if (outcome.ok) this.fanout(outcome.events);
  }

  // ---- lifecycle ----

  private async heartbeatTick(): Promise<void> {
    if (this.gone) return;
    try {
      if (!(await this.deps.lease.refresh())) {
        this.deps.log.error({ sessionId: this.sessionId }, "owner lease lost, closing controller");
        await this.close(1012, "controller lost ownership");
        return;
      }
      await this.deps.checkpoint.refreshTtl();
    } catch (error) {
      this.warn("heartbeat failed", error);
    }
  }

  /** host.end, ctl end and idle all run this once: fanout, close links, CloseRoom, endSession. */
  endRoom(reason: EndReason): Promise<void> {
    if (!this.ending) this.ending = this.doEnd(reason);
    return this.ending;
  }

  private async doEnd(reason: EndReason): Promise<void> {
    if (this.gone) return;
    this.gone = true;
    this.stopTimers();
    const outcome = this.room.apply({ type: "end", reason });
    if (outcome.ok) this.fanout(outcome.events);
    for (const link of this.links.values()) link.close(CloseCode.ROOM_ENDED, reason);
    this.links.clear();
    this.stats.stop();
    const sessionId = this.sessionId;
    await this.deps.sfu
      .closeRoom({ sessionId })
      .catch((e: unknown) => this.warn("closeRoom failed", e));
    await this.deps.checkpoint
      .markEnded(reason)
      .catch((e: unknown) => this.warn("markEnded failed", e));
    try {
      await endSession(this.deps.db, { sessionId, reason, peakParticipants: this.room.peak });
    } catch (error) {
      this.deps.log.error(
        { sessionId, error },
        "endSession failed, the writer's session.ended handler is the backup",
      );
    }
    this.deps.bus.publish("session.ended", sessionId, {
      session_id: sessionId,
      reason,
      peak_participants: this.room.peak,
    });
    await this.deps.lease.release().catch((e: unknown) => this.warn("lease release failed", e));
    this.deps.onGone(sessionId);
  }

  /** Graceful stop without ending the room: flush the checkpoint, release the lease, drop sockets. */
  async close(code = 1012, reason = "controller restarting"): Promise<void> {
    if (this.ending) return this.ending;
    if (this.gone) return;
    this.gone = true;
    this.stopTimers();
    for (const link of this.links.values()) link.close(code, reason);
    this.links.clear();
    this.stats.stop();
    await this.deps.checkpoint.stop().catch((e: unknown) => this.warn("checkpoint stop failed", e));
    await this.deps.lease.release().catch((e: unknown) => this.warn("lease release failed", e));
    this.deps.onGone(this.sessionId);
  }

  private stopTimers(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.speakerTimer) clearInterval(this.speakerTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.heartbeat = null;
    this.speakerTimer = null;
    this.idleTimer = null;
    for (const timer of this.graceTimers.values()) clearTimeout(timer);
    this.graceTimers.clear();
  }

  private warn(message: string, error: unknown): void {
    this.deps.log.warn({ sessionId: this.sessionId, error: describeSfuError(error) }, message);
  }
}
