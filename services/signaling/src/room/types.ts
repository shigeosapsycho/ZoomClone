import type {
  LobbyEntry,
  Role,
  RoomEvent,
  RosterEntry,
  TrackInfo,
  WsErrorCode,
} from "@zoomclone/protocol";

/** Who receives an event. Resolved over the roster (and lobby for "everyone") at fanout time. */
export type Target =
  | { kind: "all" }
  | { kind: "hosts" }
  | { kind: "everyone" }
  | { kind: "only"; participant_ids: string[] }
  | { kind: "all_except"; participant_id: string };

export type Emitted = { event: RoomEvent; target: Target; at: number };

export type DepartedReason = "removed" | "denied" | "grace";
export type Departed = { reason: DepartedReason; at: string };

/** Checkpoint sections; the write-behind writer only rewrites dirty ones. */
export type Section = "meta" | "roster" | "lobby" | "tracks" | "departed";

export type RoomSnapshot = {
  session_id: string;
  home_sfu: string;
  epoch: number;
  seq: number;
  status: "live" | "ended";
  end_reason: string | null;
  locked: boolean;
  lobby_enabled: boolean;
  recording: boolean;
  max_participants: number;
  host_ids: string[];
  peak: number;
  roster: RosterEntry[];
  lobby: LobbyEntry[];
  tracks: TrackInfo[];
  departed: Record<string, Departed>;
};

export type Command =
  | { type: "join"; participant_id: string; name: string; role: Role }
  | { type: "lobby_request"; participant_id: string; name: string }
  | { type: "lobby_leave"; participant_id: string }
  | { type: "admit"; actor: string; participant_id: string }
  | { type: "deny"; actor: string; participant_id: string }
  | { type: "disconnect"; participant_id: string }
  | { type: "reconnect"; participant_id: string }
  | { type: "leave"; participant_id: string }
  | { type: "remove"; actor: string; participant_id: string }
  | { type: "publish"; participant_id: string; track: TrackInfo }
  | { type: "unpublish"; participant_id: string; track_id: string }
  | { type: "track_lost"; track_id: string }
  | { type: "track_layers"; participant_id: string; track_id: string; layers: number }
  | { type: "set_media_state"; participant_id: string; muted?: boolean; video_off?: boolean }
  | { type: "host_mute"; actor: string; participant_id: string }
  | { type: "hand"; participant_id: string; raised: boolean }
  | { type: "chat"; from: string; body: string; to?: string }
  | { type: "reaction"; from: string; emoji: string }
  | { type: "lock"; actor: string; locked: boolean }
  | { type: "active_speakers"; participant_ids: string[] }
  | { type: "end"; reason: string };

/** close is set when the rejection maps to a WebSocket close code (hello path). */
export type RoomError = { code: WsErrorCode; message: string; close?: number };

export type Outcome = { ok: true; events: Emitted[] } | { ok: false; error: RoomError };

export type Membership = {
  inRoster: (participantId: string) => boolean;
  isHost: (participantId: string) => boolean;
  inLobby: (participantId: string) => boolean;
};
