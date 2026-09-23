import {
  CloseCode,
  HOST_ROLES,
  type LobbyEntry,
  type MediaSource,
  type Role,
  type RoomEvent,
  type RoomMeta,
  type RosterEntry,
  type TrackInfo,
  type Welcome,
  type WsErrorCode,
} from "@zoomclone/protocol";
import { RingBuffer } from "./ring-buffer";
import type {
  Command,
  Departed,
  DepartedReason,
  Emitted,
  Membership,
  Outcome,
  RoomError,
  RoomSnapshot,
  Section,
  Target,
} from "./types";

export type RoomOptions = { ringSize: number; ringMs: number; departedTtlMs: number };
export const DEFAULT_ROOM_OPTIONS: RoomOptions = {
  ringSize: 500,
  ringMs: 60_000,
  departedTtlMs: 600_000,
};

export type RoomInit = {
  session_id: string;
  home_sfu: string;
  lobby_enabled: boolean;
  max_participants: number;
  epoch?: number;
};

type Ctx = { now: number; iso: string; events: Emitted[] };
type EventOf<T extends RoomEvent["type"]> = Extract<RoomEvent, { type: T }>;

const CLOSE_BY_DEPARTED: Record<DepartedReason, number> = {
  removed: CloseCode.REMOVED,
  denied: CloseCode.LOBBY_DENIED,
  grace: CloseCode.REJOIN_REQUIRED,
};

function fail(code: WsErrorCode, message: string, close?: number): Outcome {
  return { ok: false, error: close === undefined ? { code, message } : { code, message, close } };
}

function ok(ctx: Ctx): Outcome {
  return { ok: true, events: ctx.events };
}

/**
 * Pure, synchronous room state (design doc "room/Room.ts"): roster, lobby, tracks, departed,
 * seq and the replay ring buffer. No I/O, no timers; the controller sequences SFU calls before
 * applying commands and fans the returned events out.
 */
export class Room {
  private readonly ring: RingBuffer;
  private readonly rosterMap = new Map<string, RosterEntry>();
  private readonly lobbyMap = new Map<string, LobbyEntry>();
  private readonly trackMap = new Map<string, TrackInfo>();
  private readonly departedMap = new Map<string, Departed>();
  private dirty = new Set<Section>();
  private _seq = 0;
  private _status: "live" | "ended" = "live";
  private _endReason: string | null = null;
  private _locked = false;
  private _recording = false;
  private _peak = 0;

  private constructor(
    readonly sessionId: string,
    readonly homeSfu: string,
    private _epoch: number,
    private readonly _lobbyEnabled: boolean,
    private readonly _maxParticipants: number,
    private readonly opts: RoomOptions,
  ) {
    this.ring = new RingBuffer({ maxSize: opts.ringSize, maxAgeMs: opts.ringMs });
  }

  static create(init: RoomInit, opts: RoomOptions = DEFAULT_ROOM_OPTIONS): Room {
    const room = new Room(
      init.session_id,
      init.home_sfu,
      init.epoch ?? 1,
      init.lobby_enabled,
      init.max_participants,
      opts,
    );
    room.markAllDirty();
    return room;
  }

  /** bumpEpoch: rehydrate on a new controller (nobody is connected to it yet). */
  static fromSnapshot(
    s: RoomSnapshot,
    { bumpEpoch }: { bumpEpoch: boolean },
    opts: RoomOptions = DEFAULT_ROOM_OPTIONS,
  ): Room {
    const room = new Room(
      s.session_id,
      s.home_sfu,
      bumpEpoch ? s.epoch + 1 : s.epoch,
      s.lobby_enabled,
      s.max_participants,
      opts,
    );
    room._seq = s.seq;
    room._status = s.status;
    room._endReason = s.end_reason;
    room._locked = s.locked;
    room._recording = s.recording;
    room._peak = s.peak;
    for (const entry of s.roster) {
      room.rosterMap.set(
        entry.participant_id,
        bumpEpoch ? { ...entry, connected: false } : { ...entry },
      );
    }
    for (const entry of s.lobby) room.lobbyMap.set(entry.participant_id, { ...entry });
    for (const track of s.tracks) room.trackMap.set(track.track_id, { ...track });
    for (const [id, departed] of Object.entries(s.departed))
      room.departedMap.set(id, { ...departed });
    room.markAllDirty();
    return room;
  }

  // ---- accessors ----

  get epoch(): number {
    return this._epoch;
  }
  get seq(): number {
    return this._seq;
  }
  get status(): "live" | "ended" {
    return this._status;
  }
  get endReason(): string | null {
    return this._endReason;
  }
  get locked(): boolean {
    return this._locked;
  }
  get lobbyEnabled(): boolean {
    return this._lobbyEnabled;
  }
  get recording(): boolean {
    return this._recording;
  }
  get maxParticipants(): number {
    return this._maxParticipants;
  }
  get peak(): number {
    return this._peak;
  }

  hostIds(): string[] {
    return [...this.rosterMap.values()]
      .filter((r) => HOST_ROLES.has(r.role))
      .map((r) => r.participant_id);
  }
  roster(): RosterEntry[] {
    return [...this.rosterMap.values()].map((r) => ({ ...r }));
  }
  rosterEntry(id: string): RosterEntry | undefined {
    const entry = this.rosterMap.get(id);
    return entry ? { ...entry } : undefined;
  }
  inRoster(id: string): boolean {
    return this.rosterMap.has(id);
  }
  rosterIds(): string[] {
    return [...this.rosterMap.keys()];
  }
  lobby(): LobbyEntry[] {
    return [...this.lobbyMap.values()].map((l) => ({ ...l }));
  }
  inLobby(id: string): boolean {
    return this.lobbyMap.has(id);
  }
  lobbyIds(): string[] {
    return [...this.lobbyMap.keys()];
  }
  tracks(): TrackInfo[] {
    return [...this.trackMap.values()].map((t) => ({ ...t }));
  }
  track(id: string): TrackInfo | undefined {
    const track = this.trackMap.get(id);
    return track ? { ...track } : undefined;
  }
  tracksOf(owner: string, source?: MediaSource): TrackInfo[] {
    return this.tracks().filter(
      (t) => t.owner === owner && (source === undefined || t.source === source),
    );
  }
  departed(id: string): DepartedReason | undefined {
    return this.departedMap.get(id)?.reason;
  }
  isHost(id: string): boolean {
    const entry = this.rosterMap.get(id);
    return entry !== undefined && HOST_ROLES.has(entry.role);
  }
  isIdle(): boolean {
    return this.rosterMap.size === 0 && this.lobbyMap.size === 0;
  }
  membership(): Membership {
    return {
      inRoster: (id) => this.rosterMap.has(id),
      isHost: (id) => this.isHost(id),
      inLobby: (id) => this.lobbyMap.has(id),
    };
  }

  // ---- snapshot and dirty tracking ----

  toSnapshot(): RoomSnapshot {
    return {
      session_id: this.sessionId,
      home_sfu: this.homeSfu,
      epoch: this._epoch,
      seq: this._seq,
      status: this._status,
      end_reason: this._endReason,
      locked: this._locked,
      lobby_enabled: this._lobbyEnabled,
      recording: this._recording,
      max_participants: this._maxParticipants,
      host_ids: this.hostIds(),
      peak: this._peak,
      roster: this.roster(),
      lobby: this.lobby(),
      tracks: this.tracks(),
      departed: Object.fromEntries([...this.departedMap].map(([id, d]) => [id, { ...d }])),
    };
  }

  takeDirty(): Set<Section> {
    const taken = this.dirty;
    this.dirty = new Set();
    return taken;
  }

  markAllDirty(): void {
    this.dirty = new Set<Section>(["meta", "roster", "lobby", "tracks", "departed"]);
  }

  // ---- welcome and replay ----

  /** Snapshot for one participant (design doc: exactly one welcome per connection). No media. */
  welcomeFor(participantId: string): Welcome {
    if (this.lobbyMap.has(participantId)) {
      return {
        participant_id: participantId,
        role: "attendee",
        epoch: this._epoch,
        seq: this._seq,
        state: "lobby",
      };
    }
    const entry = this.rosterMap.get(participantId);
    if (!entry) throw new Error(`unknown participant ${participantId}`);
    const welcome: Welcome = {
      participant_id: participantId,
      role: entry.role,
      epoch: this._epoch,
      seq: this._seq,
      state: "joined",
      roster: this.roster(),
      tracks: this.tracks(),
      room_meta: this.meta(),
    };
    if (HOST_ROLES.has(entry.role)) welcome.lobby = this.lobby();
    return welcome;
  }

  meta(): RoomMeta {
    return {
      session_id: this.sessionId,
      locked: this._locked,
      lobby_enabled: this._lobbyEnabled,
      recording: this._recording,
      host_ids: this.hostIds(),
      max_participants: this._maxParticipants,
    };
  }

  replay(participantId: string, afterSeq: number, now: number = Date.now()): RoomEvent[] | null {
    this.ring.evict(now);
    return this.ring.replay(participantId, afterSeq, this._seq, this.membership());
  }

  /** Hello-time pre-check so the controller can refuse before spending SFU calls. Pure. */
  canJoin(participantId: string, role: Role): RoomError | null {
    if (this._status === "ended") {
      return { code: "FORBIDDEN", message: "room ended", close: CloseCode.ROOM_ENDED };
    }
    const rejected = this.rejectEntry(participantId, role);
    if (rejected && !rejected.ok) return rejected.error;
    if (this.rosterMap.size >= this._maxParticipants) {
      return { code: "CAPACITY", message: "meeting is full", close: CloseCode.CAPACITY };
    }
    return null;
  }

  // ---- commands ----

  apply(command: Command, now: number = Date.now()): Outcome {
    this.pruneDeparted(now);
    const ctx: Ctx = { now, iso: new Date(now).toISOString(), events: [] };
    if (this._status === "ended" && command.type !== "end") {
      return fail("FORBIDDEN", "room ended", CloseCode.ROOM_ENDED);
    }
    switch (command.type) {
      case "join":
        return this.join(ctx, command.participant_id, command.name, command.role);
      case "lobby_request":
        return this.lobbyRequest(ctx, command.participant_id, command.name);
      case "lobby_leave":
        return this.lobbyLeave(ctx, command.participant_id);
      case "admit":
        return this.admit(ctx, command.actor, command.participant_id);
      case "deny":
        return this.deny(ctx, command.actor, command.participant_id);
      case "disconnect":
        return this.setConnected(ctx, command.participant_id, false);
      case "reconnect":
        return this.setConnected(ctx, command.participant_id, true);
      case "leave":
        return this.leave(ctx, command.participant_id);
      case "remove":
        return this.remove(ctx, command.actor, command.participant_id);
      case "publish":
        return this.publish(ctx, command.participant_id, command.track);
      case "unpublish":
        return this.unpublish(ctx, command.participant_id, command.track_id);
      case "track_lost":
        return this.trackLost(ctx, command.track_id);
      case "track_layers":
        return this.trackLayers(ctx, command.participant_id, command.track_id, command.layers);
      case "set_media_state":
        return this.setMediaState(ctx, command.participant_id, command.muted, command.video_off);
      case "host_mute":
        return this.hostMute(ctx, command.actor, command.participant_id);
      case "hand":
        return this.hand(ctx, command.participant_id, command.raised);
      case "chat":
        return this.chat(ctx, command.from, command.body, command.to);
      case "reaction":
        return this.reaction(ctx, command.from, command.emoji);
      case "lock":
        return this.lock(ctx, command.actor, command.locked);
      case "active_speakers":
        this.emit(
          ctx,
          "active_speakers",
          { participant_ids: command.participant_ids },
          { kind: "all" },
        );
        return ok(ctx);
      case "end":
        return this.end(ctx, command.reason);
    }
  }

  private join(ctx: Ctx, participantId: string, name: string, role: Role): Outcome {
    const rejected = this.rejectEntry(participantId, role);
    if (rejected) return rejected;
    if (this.rosterMap.size >= this._maxParticipants) {
      return fail("CAPACITY", "meeting is full", CloseCode.CAPACITY);
    }
    const entry = this.addToRoster(ctx, participantId, name, role);
    this.emit(
      ctx,
      "participant.joined",
      { participant: entry },
      { kind: "all_except", participant_id: participantId },
    );
    return ok(ctx);
  }

  private lobbyRequest(ctx: Ctx, participantId: string, name: string): Outcome {
    const rejected = this.rejectEntry(participantId, "attendee");
    if (rejected) return rejected;
    const entry: LobbyEntry = { participant_id: participantId, name, requested_at: ctx.iso };
    this.lobbyMap.set(participantId, entry);
    this.dirty.add("lobby");
    this.emit(ctx, "lobby.request", { participant_id: participantId, name }, { kind: "hosts" });
    return ok(ctx);
  }

  private lobbyLeave(ctx: Ctx, participantId: string): Outcome {
    if (this.lobbyMap.delete(participantId)) {
      this.dirty.add("lobby");
      this.emit(ctx, "lobby.left", { participant_id: participantId }, { kind: "hosts" });
    }
    return ok(ctx);
  }

  private admit(ctx: Ctx, actor: string, participantId: string): Outcome {
    const denied = this.requireHost(actor);
    if (denied) return denied;
    const waiter = this.lobbyMap.get(participantId);
    if (!waiter) return fail("NOT_FOUND", "not in the lobby");
    if (this.rosterMap.size >= this._maxParticipants) return fail("CAPACITY", "meeting is full");
    this.lobbyMap.delete(participantId);
    this.dirty.add("lobby");
    this.addToRoster(ctx, participantId, waiter.name, "attendee");
    this.emit(
      ctx,
      "lobby.result",
      { admitted: true },
      { kind: "only", participant_ids: [participantId] },
    );
    const entry = this.rosterMap.get(participantId)!;
    this.emit(
      ctx,
      "participant.joined",
      { participant: { ...entry } },
      { kind: "all_except", participant_id: participantId },
    );
    return ok(ctx);
  }

  private deny(ctx: Ctx, actor: string, participantId: string): Outcome {
    const denied = this.requireHost(actor);
    if (denied) return denied;
    if (!this.lobbyMap.has(participantId)) return fail("NOT_FOUND", "not in the lobby");
    this.denyWaiter(ctx, participantId);
    return ok(ctx);
  }

  private denyWaiter(ctx: Ctx, participantId: string): void {
    this.lobbyMap.delete(participantId);
    this.departedMap.set(participantId, { reason: "denied", at: ctx.iso });
    this.dirty.add("lobby");
    this.dirty.add("departed");
    this.emit(
      ctx,
      "lobby.result",
      { admitted: false },
      { kind: "only", participant_ids: [participantId] },
    );
    this.emit(ctx, "lobby.left", { participant_id: participantId }, { kind: "hosts" });
  }

  private setConnected(ctx: Ctx, participantId: string, connected: boolean): Outcome {
    const entry = this.rosterMap.get(participantId);
    if (!entry) return fail("NOT_FOUND", "not in the room");
    if (entry.connected === connected) return ok(ctx);
    entry.connected = connected;
    this.dirty.add("roster");
    this.emit(
      ctx,
      "participant.updated",
      { participant_id: participantId, patch: { connected } },
      { kind: "all_except", participant_id: participantId },
    );
    return ok(ctx);
  }

  private leave(ctx: Ctx, participantId: string): Outcome {
    if (!this.rosterMap.has(participantId)) return ok(ctx);
    this.dropParticipant(ctx, participantId, "timeout", "grace");
    return ok(ctx);
  }

  private remove(ctx: Ctx, actor: string, participantId: string): Outcome {
    const denied = this.requireHost(actor);
    if (denied) return denied;
    if (participantId === actor) return fail("INVALID", "cannot remove yourself");
    if (this.rosterMap.has(participantId)) {
      if (this.isHost(participantId)) return fail("FORBIDDEN", "cannot remove a host");
      this.dropParticipant(ctx, participantId, "removed", "removed");
      return ok(ctx);
    }
    if (this.lobbyMap.has(participantId)) {
      this.denyWaiter(ctx, participantId);
      return ok(ctx);
    }
    return fail("NOT_FOUND", "not in the room");
  }

  private publish(ctx: Ctx, participantId: string, track: TrackInfo): Outcome {
    if (!this.rosterMap.has(participantId)) return fail("NOT_FOUND", "not in the room");
    if (track.owner !== participantId) return fail("INVALID", "track owner mismatch");
    if (this.trackMap.has(track.track_id)) return fail("INVALID", "duplicate track id");
    this.trackMap.set(track.track_id, { ...track });
    this.dirty.add("tracks");
    this.emit(ctx, "track.added", { track: { ...track } }, { kind: "all" });
    return ok(ctx);
  }

  private unpublish(ctx: Ctx, participantId: string, trackId: string): Outcome {
    const track = this.trackMap.get(trackId);
    if (!track) return fail("NOT_FOUND", "unknown track");
    if (track.owner !== participantId) return fail("FORBIDDEN", "not your track");
    this.removeTrack(ctx, trackId);
    return ok(ctx);
  }

  private trackLost(ctx: Ctx, trackId: string): Outcome {
    if (this.trackMap.has(trackId)) this.removeTrack(ctx, trackId);
    return ok(ctx);
  }

  private trackLayers(ctx: Ctx, participantId: string, trackId: string, layers: number): Outcome {
    if (!this.trackMap.has(trackId)) return ok(ctx);
    this.emit(
      ctx,
      "track.updated",
      { track_id: trackId, patch: { layers } },
      { kind: "only", participant_ids: [participantId] },
    );
    return ok(ctx);
  }

  private setMediaState(
    ctx: Ctx,
    participantId: string,
    muted?: boolean,
    videoOff?: boolean,
  ): Outcome {
    const entry = this.rosterMap.get(participantId);
    if (!entry) return fail("NOT_FOUND", "not in the room");
    this.applyMediaState(ctx, entry, muted, videoOff);
    return ok(ctx);
  }

  private hostMute(ctx: Ctx, actor: string, participantId: string): Outcome {
    const denied = this.requireHost(actor);
    if (denied) return denied;
    const entry = this.rosterMap.get(participantId);
    if (!entry) return fail("NOT_FOUND", "not in the room");
    this.applyMediaState(ctx, entry, true, undefined);
    return ok(ctx);
  }

  private hand(ctx: Ctx, participantId: string, raised: boolean): Outcome {
    const entry = this.rosterMap.get(participantId);
    if (!entry) return fail("NOT_FOUND", "not in the room");
    if (entry.hand === raised) return ok(ctx);
    entry.hand = raised;
    this.dirty.add("roster");
    this.emit(ctx, "hand", { participant_id: participantId, raised }, { kind: "all" });
    return ok(ctx);
  }

  private chat(ctx: Ctx, from: string, body: string, to?: string): Outcome {
    if (!this.rosterMap.has(from)) return fail("NOT_FOUND", "not in the room");
    if (to !== undefined && !this.rosterMap.has(to)) return fail("NOT_FOUND", "unknown recipient");
    const payload =
      to === undefined ? { from, body, sent_at: ctx.iso } : { from, to, body, sent_at: ctx.iso };
    const target: Target =
      to === undefined ? { kind: "all" } : { kind: "only", participant_ids: [from, to] };
    this.emit(ctx, "chat", payload, target);
    return ok(ctx);
  }

  private reaction(ctx: Ctx, from: string, emoji: string): Outcome {
    if (!this.rosterMap.has(from)) return fail("NOT_FOUND", "not in the room");
    this.emit(ctx, "reaction", { from, emoji }, { kind: "all" });
    return ok(ctx);
  }

  private lock(ctx: Ctx, actor: string, locked: boolean): Outcome {
    const denied = this.requireHost(actor);
    if (denied) return denied;
    if (this._locked === locked) return ok(ctx);
    this._locked = locked;
    this.dirty.add("meta");
    this.emit(ctx, "room.updated", { locked }, { kind: "all" });
    return ok(ctx);
  }

  private end(ctx: Ctx, reason: string): Outcome {
    if (this._status === "ended") return ok(ctx);
    this._status = "ended";
    this._endReason = reason;
    this.dirty.add("meta");
    this.emit(ctx, "room.ended", { reason }, { kind: "everyone" });
    return ok(ctx);
  }

  // ---- helpers ----

  /** Hello-time checks shared by join and lobby_request. */
  private rejectEntry(participantId: string, role: Role): Outcome | null {
    const departed = this.departedMap.get(participantId);
    if (departed) {
      return fail("FORBIDDEN", `departed: ${departed.reason}`, CLOSE_BY_DEPARTED[departed.reason]);
    }
    if (this.rosterMap.has(participantId) || this.lobbyMap.has(participantId)) {
      return fail("INVALID", "already present");
    }
    if (this._locked && !HOST_ROLES.has(role)) {
      return fail("LOCKED", "meeting is locked", CloseCode.LOCKED);
    }
    return null;
  }

  private requireHost(actor: string): Outcome | null {
    return this.isHost(actor) ? null : fail("FORBIDDEN", "host role required");
  }

  private addToRoster(ctx: Ctx, participantId: string, name: string, role: Role): RosterEntry {
    const entry: RosterEntry = {
      participant_id: participantId,
      name,
      role,
      muted: false,
      video_off: false,
      hand: false,
      connected: true,
      joined_at: ctx.iso,
    };
    this.rosterMap.set(participantId, entry);
    this._peak = Math.max(this._peak, this.rosterMap.size);
    this.dirty.add("roster");
    this.dirty.add("meta");
    return { ...entry };
  }

  private dropParticipant(
    ctx: Ctx,
    participantId: string,
    leaveReason: "timeout" | "removed",
    departedReason: DepartedReason,
  ): void {
    this.rosterMap.delete(participantId);
    this.departedMap.set(participantId, { reason: departedReason, at: ctx.iso });
    this.dirty.add("roster");
    this.dirty.add("departed");
    this.dirty.add("meta");
    for (const track of this.tracks()) {
      if (track.owner === participantId) this.removeTrack(ctx, track.track_id);
    }
    this.emit(
      ctx,
      "participant.left",
      { participant_id: participantId, reason: leaveReason },
      { kind: "all" },
    );
  }

  private removeTrack(ctx: Ctx, trackId: string): void {
    this.trackMap.delete(trackId);
    this.dirty.add("tracks");
    this.emit(ctx, "track.removed", { track_id: trackId }, { kind: "all" });
  }

  private applyMediaState(ctx: Ctx, entry: RosterEntry, muted?: boolean, videoOff?: boolean): void {
    const patch: { muted?: boolean; video_off?: boolean } = {};
    const pauses: Array<{ source: MediaSource; paused: boolean }> = [];
    if (muted !== undefined && muted !== entry.muted) {
      entry.muted = muted;
      patch.muted = muted;
      pauses.push({ source: "mic", paused: muted });
    }
    if (videoOff !== undefined && videoOff !== entry.video_off) {
      entry.video_off = videoOff;
      patch.video_off = videoOff;
      pauses.push({ source: "camera", paused: videoOff });
    }
    if (pauses.length === 0) return;
    this.dirty.add("roster");
    this.emit(
      ctx,
      "participant.updated",
      { participant_id: entry.participant_id, patch },
      { kind: "all" },
    );
    for (const { source, paused } of pauses) {
      for (const track of this.trackMap.values()) {
        if (
          track.owner !== entry.participant_id ||
          track.source !== source ||
          track.paused === paused
        )
          continue;
        track.paused = paused;
        this.dirty.add("tracks");
        this.emit(
          ctx,
          "track.updated",
          { track_id: track.track_id, patch: { paused } },
          { kind: "all" },
        );
      }
    }
  }

  private pruneDeparted(now: number): void {
    for (const [id, departed] of this.departedMap) {
      if (Date.parse(departed.at) + this.opts.departedTtlMs <= now) {
        this.departedMap.delete(id);
        this.dirty.add("departed");
      }
    }
  }

  private emit<T extends RoomEvent["type"]>(
    ctx: Ctx,
    type: T,
    payload: EventOf<T>["payload"],
    target: Target,
  ): void {
    // The payload parameter is typed per event; the cast only erases the generic for the union.
    const event = { type, seq: ++this._seq, payload } as unknown as RoomEvent;
    const emitted: Emitted = { event, target, at: ctx.now };
    this.ring.push(emitted);
    ctx.events.push(emitted);
  }
}
