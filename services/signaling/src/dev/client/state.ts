import type {
  LobbyEntry,
  Role,
  RoomEvent,
  RoomMeta,
  RosterEntry,
  TrackInfo,
  Welcome,
} from "@zoomclone/protocol";

export type ChatLine = { from: string; to?: string; body: string; sentAt: string };
export type Reaction = { from: string; emoji: string; until: number };

export type RoomView = {
  participantId: string | null;
  role: Role | null;
  epoch: number;
  seq: number;
  state: "idle" | "lobby" | "joined" | "ended";
  endReason: string | null;
  roster: RosterEntry[];
  tracks: TrackInfo[];
  lobby: LobbyEntry[];
  meta: RoomMeta | null;
  activeSpeakers: string[];
  /** Spatial layers delivered to this client per track (track.updated {layers}). */
  layers: Record<string, number>;
  chat: ChatLine[];
  reactions: Reaction[];
};

export const REACTION_MS = 2_000;
const CHAT_KEEP = 200;

export function emptyView(): RoomView {
  return {
    participantId: null,
    role: null,
    epoch: 0,
    seq: 0,
    state: "idle",
    endReason: null,
    roster: [],
    tracks: [],
    lobby: [],
    meta: null,
    activeSpeakers: [],
    layers: {},
    chat: [],
    reactions: [],
  };
}

/** welcome and resync replace everything the snapshot carries; chat and reactions are kept. */
export function applySnapshot(view: RoomView, welcome: Welcome): RoomView {
  return {
    ...view,
    participantId: welcome.participant_id,
    role: welcome.role,
    epoch: welcome.epoch,
    seq: welcome.seq,
    state: welcome.state,
    endReason: null,
    roster: welcome.roster ?? [],
    tracks: welcome.tracks ?? [],
    lobby: welcome.lobby ?? [],
    meta: welcome.room_meta ?? null,
    activeSpeakers: [],
    layers: {},
  };
}

export function expireReactions(view: RoomView, now: number): RoomView {
  if (view.reactions.every((r) => r.until > now)) return view;
  return { ...view, reactions: view.reactions.filter((r) => r.until > now) };
}

/** Applies one seq'd event; events at or below the view's seq are duplicates and are ignored. */
export function applyEvent(view: RoomView, event: RoomEvent, now: number): RoomView {
  if (event.seq <= view.seq) return view;
  const next: RoomView = { ...view, seq: event.seq };
  switch (event.type) {
    case "participant.joined":
      next.roster = [
        ...view.roster.filter((r) => r.participant_id !== event.payload.participant.participant_id),
        event.payload.participant,
      ];
      next.lobby = view.lobby.filter(
        (l) => l.participant_id !== event.payload.participant.participant_id,
      );
      return next;
    case "participant.left":
      next.roster = view.roster.filter((r) => r.participant_id !== event.payload.participant_id);
      next.tracks = view.tracks.filter((t) => t.owner !== event.payload.participant_id);
      next.activeSpeakers = view.activeSpeakers.filter((id) => id !== event.payload.participant_id);
      return next;
    case "participant.updated":
      next.roster = view.roster.map((r) =>
        r.participant_id === event.payload.participant_id ? { ...r, ...event.payload.patch } : r,
      );
      return next;
    case "track.added":
      next.tracks = [
        ...view.tracks.filter((t) => t.track_id !== event.payload.track.track_id),
        event.payload.track,
      ];
      return next;
    case "track.removed": {
      next.tracks = view.tracks.filter((t) => t.track_id !== event.payload.track_id);
      const { [event.payload.track_id]: _dropped, ...layers } = view.layers;
      next.layers = layers;
      return next;
    }
    case "track.updated":
      if (event.payload.patch.paused !== undefined) {
        const paused = event.payload.patch.paused;
        next.tracks = view.tracks.map((t) =>
          t.track_id === event.payload.track_id ? { ...t, paused } : t,
        );
      }
      if (event.payload.patch.layers !== undefined) {
        next.layers = { ...view.layers, [event.payload.track_id]: event.payload.patch.layers };
      }
      return next;
    case "active_speakers":
      next.activeSpeakers = event.payload.participant_ids;
      return next;
    case "lobby.request":
      next.lobby = [
        ...view.lobby.filter((l) => l.participant_id !== event.payload.participant_id),
        {
          participant_id: event.payload.participant_id,
          name: event.payload.name,
          requested_at: new Date(now).toISOString(),
        },
      ];
      return next;
    case "lobby.left":
      next.lobby = view.lobby.filter((l) => l.participant_id !== event.payload.participant_id);
      return next;
    case "lobby.result":
      // The snapshot that follows an admit carries the room; a denial is followed by close 4003.
      return next;
    case "chat": {
      const line: ChatLine =
        event.payload.to === undefined
          ? { from: event.payload.from, body: event.payload.body, sentAt: event.payload.sent_at }
          : {
              from: event.payload.from,
              to: event.payload.to,
              body: event.payload.body,
              sentAt: event.payload.sent_at,
            };
      next.chat = [...view.chat, line].slice(-CHAT_KEEP);
      return next;
    }
    case "reaction":
      next.reactions = [
        ...view.reactions,
        { from: event.payload.from, emoji: event.payload.emoji, until: now + REACTION_MS },
      ];
      return next;
    case "hand":
      next.roster = view.roster.map((r) =>
        r.participant_id === event.payload.participant_id
          ? { ...r, hand: event.payload.raised }
          : r,
      );
      return next;
    case "room.updated":
      next.meta = view.meta ? { ...view.meta, ...stripUndefined(event.payload) } : view.meta;
      return next;
    case "room.ended":
      next.state = "ended";
      next.endReason = event.payload.reason;
      return next;
  }
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
