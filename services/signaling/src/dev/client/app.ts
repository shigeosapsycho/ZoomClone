import "./styles.css";
import {
  CloseCode,
  ErrorBodySchema,
  JoinResponseSchema,
  type HelloAck,
  type JoinResponse,
  type RoomEvent,
  type SubscriptionPref,
} from "@zoomclone/protocol";
import { LevelMeter } from "./levels";
import { MediaSession, type FeedStats, type LocalTracks } from "./media";
import { SignalingClient, type CloseInfo, type ConnectionStatus } from "./signaling";
import { applyEvent, applySnapshot, emptyView, expireReactions, type RoomView } from "./state";
import { createUi, type UiModel } from "./ui";

type Config = { apiBase: string };
const config = (window as unknown as { __config: Config }).__config;

export type Harness = {
  view: () => RoomView;
  status: () => ConnectionStatus;
  sessionId: () => string | null;
  participantId: () => string | null;
  epoch: () => number | null;
  seq: () => number;
  events: RoomEvent[];
  closes: CloseInfo[];
  snapshots: Array<{ kind: "welcome" | "resync"; seq: number; epoch: number }>;
  lastAck: () => HelloAck | null;
  joinResponse: () => JoinResponse | null;
  consumers: () => Array<{ track_id: string; consumer_id: string; kind: string }>;
  localTracks: () => { audio: string | null; video: string | null };
  stats: (trackId: string) => Promise<FeedStats>;
  frames: (trackId: string) => number;
  levels: () => Record<string, number>;
  dropSocket: () => void;
  setLayer: (trackId: string, maxLayer: number) => Promise<void>;
  lastError: () => string | null;
  joinError: () => { status: number; code: string } | null;
};

type LocalState = { muted: boolean; videoOff: boolean };

const root = document.getElementById("app")!;
let view: RoomView = emptyView();
let screen: UiModel["screen"] = "join";
let status: ConnectionStatus = "closed";
let roomCode = "";
let join: JoinResponse | null = null;
let joining = false;
let signaling: SignalingClient | null = null;
let media: MediaSession | null = null;
let localState: LocalState = { muted: false, videoOff: false };
let rosterState: LocalState | null = null;
let error: string | null = null;
let joinError: { status: number; code: string } | null = null;
let onAirSince: number | null = null;
let prefs: Record<string, SubscriptionPref> = {};
const meter = new LevelMeter();
const events: RoomEvent[] = [];
const closes: CloseInfo[] = [];
const snapshots: Array<{ kind: "welcome" | "resync"; seq: number; epoch: number }> = [];

const ui = createUi(root, {
  join: (input) => void doJoin(input).catch(report),
  leave: () => {
    signaling?.leave();
    media?.close();
    screen = "closed";
    error = null; // a chosen leave has no reason line; the panel reads "You left the room"
    render();
  },
  toggleMic: () => {
    const muted = !localState.muted;
    void media
      ?.setMuted(muted)
      .then(() => {
        localState = { ...localState, muted };
        render();
      })
      .catch(report);
  },
  toggleCamera: () => {
    const videoOff = !localState.videoOff;
    void media
      ?.setVideoOff(videoOff)
      .then(() => {
        localState = { ...localState, videoOff };
        render();
      })
      .catch(report);
  },
  // The set_media_state ack precedes the participant.updated event; both paths converge in render().
  toggleHand: () => {
    const me = view.roster.find((r) => r.participant_id === view.participantId);
    void signaling?.request(me?.hand ? "lower_hand" : "raise_hand", {}).catch(report);
  },
  react: (emoji) => void signaling?.request("reaction", { emoji }).catch(report),
  chat: (body) => void signaling?.request("chat", { body }).catch(report),
  admit: (pid) => void signaling?.request("host.admit", { participant_id: pid }).catch(report),
  deny: (pid) => void signaling?.request("host.deny", { participant_id: pid }).catch(report),
  mute: (pid) => void signaling?.request("host.mute", { participant_id: pid }).catch(report),
  remove: (pid) => void signaling?.request("host.remove", { participant_id: pid }).catch(report),
  setLock: (locked) => void signaling?.request("host.lock", { locked }).catch(report),
  end: () => void signaling?.request("host.end", {}).catch(report),
  setLayer: (trackId, maxLayer) => void setLayer(trackId, maxLayer).catch(report),
});

function report(err: unknown): void {
  error = err instanceof Error ? err.message : String(err);
  // The panel screens print the error; in a room the tape is the log that carries it.
  ui.tape(view.seq, `error ${error}`);
  render();
}

function render(): void {
  view = expireReactions(view, Date.now());
  const me = view.roster.find((r) => r.participant_id === view.participantId);
  if (me) {
    // The roster is the server's truth (a host mute lands as participant.updated on our own
    // entry); follow it when it changes, and only then, so a local toggle whose ack has landed
    // is not undone by a render that runs before the event arrives.
    const next = { muted: me.muted, videoOff: me.video_off };
    if (rosterState?.muted !== next.muted || rosterState.videoOff !== next.videoOff) {
      rosterState = next;
      if (localState.muted !== next.muted || localState.videoOff !== next.videoOff) {
        localState = next;
        media?.syncPaused(localState);
      }
    }
  }
  const model: UiModel = {
    screen,
    status,
    view,
    roomCode,
    sessionId: join?.session_id ?? null,
    localState,
    levels: meter.read(),
    error,
    sinceMs: onAirSince === null ? null : Date.now() - onAirSince,
  };
  ui.render(model);
}

async function doJoin(input: { code: string; name: string; token: string }): Promise<void> {
  if (joining) return; // a second click while the first join is in flight would seat us twice
  joining = true;
  error = null;
  joinError = null;
  roomCode = input.code;
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (input.token) headers["authorization"] = `Bearer ${input.token}`;
    let response: Response;
    try {
      response = await fetch(`${config.apiBase}/v1/join`, {
        method: "POST",
        headers,
        body: JSON.stringify({ code: input.code, display_name: input.name || "Guest" }),
      });
    } catch {
      error = "Could not reach the meeting service. Is it running?";
      render();
      return;
    }
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const parsed = ErrorBodySchema.safeParse(body);
      const code = parsed.success ? parsed.data.error.code : "UNKNOWN";
      joinError = { status: response.status, code };
      error = joinMessage(response.status, code);
      render();
      return;
    }
    join = JoinResponseSchema.parse(body);
    startSession(join);
  } finally {
    joining = false;
  }
}

function joinMessage(status: number, code: string): string {
  if (status === 404) return "No room has that code. Check it with the host.";
  if (status === 410) return "That room has ended. Ask the host for a new code.";
  if (status === 403) return "The host has locked this room.";
  if (status === 429) {
    return code === "CAPACITY"
      ? "This room is full."
      : "Too many attempts. Wait a minute and try again.";
  }
  return `Could not join (${code}).`;
}

function startSession(joined: JoinResponse): void {
  media = new MediaSession(signalingRef(), {
    onFeed: (feed) => {
      ui.attachFeed(feed.trackId, feed.kind, feed.track);
      const owner = view.tracks.find((t) => t.track_id === feed.trackId)?.owner;
      if (owner && feed.kind === "audio") meter.attach(owner, feed.track);
    },
    onFeedRemoved: (trackId) => {
      ui.detachFeed(trackId);
    },
    log: (line) => ui.tape(view.seq, line),
  });
  screen = joined.lobby ? "waiting" : "room";
  render();

  function signalingRef(): SignalingClient {
    signaling = new SignalingClient({
      url: joined.signaling_url,
      token: joined.signaling_token,
      onSnapshot: (kind, welcome) => void onSnapshot(kind, welcome).catch(report),
      onEvent: (event) => onEvent(event),
      onStatus: (next) => {
        status = next;
        if (next === "joined" && onAirSince === null) onAirSince = Date.now();
        render();
      },
      onClosed: (info) => {
        closes.push(info);
        ui.tape(view.seq, `socket closed ${info.code} ${info.reason}`);
        if (info.terminal && info.code !== 1000) {
          const ended = info.code === CloseCode.ROOM_ENDED || view.state === "ended";
          screen = ended ? "ended" : "closed";
          // The ended panel's heading says what happened; every other close carries its reason.
          error = ended ? null : closeMessage(info.code);
          media?.close();
        }
        render();
      },
      log: (line) => ui.tape(view.seq, line),
    });
    signaling.connect();
    return signaling;
  }
}

function closeMessage(code: number): string {
  switch (code) {
    case CloseCode.REMOVED:
      return "The host removed you from the room.";
    case CloseCode.LOBBY_DENIED:
      return "The host did not let you in.";
    case CloseCode.REPLACED:
      return "You joined from another tab, so this one stopped.";
    case CloseCode.CAPACITY:
      return "This room is full.";
    case CloseCode.REJOIN_REQUIRED:
      return "You were away too long. Join again with a fresh code.";
    case CloseCode.LOCKED:
      return "The host has locked this room.";
    default:
      return `The connection closed (${code}).`;
  }
}

async function onSnapshot(
  kind: "welcome" | "resync",
  welcome: Parameters<typeof applySnapshot>[1],
): Promise<void> {
  view = applySnapshot(view, welcome);
  snapshots.push({ kind, seq: welcome.seq, epoch: welcome.epoch });
  ui.tape(welcome.seq, `${kind} ${welcome.state} epoch ${welcome.epoch}`);
  if (welcome.state === "lobby") {
    screen = "waiting";
    render();
    return;
  }
  screen = "room";
  render();
  if (!media || !welcome.media || !join) return;
  const outcome = await media.applyMedia(welcome.media, join.ice_servers);
  if (outcome === "created") {
    // No devices (or no permission) still gets a seat in the room, just without tracks.
    let tracks: LocalTracks = { audio: null, video: null };
    try {
      tracks = await media.captureLocal();
    } catch (err) {
      report(err);
    }
    ui.attachLocal(tracks);
    if (tracks.audio) meter.attach("you", tracks.audio);
    await media.publishLocal(localState);
  }
  await resubscribe();
  render();
}

function onEvent(event: RoomEvent): void {
  events.push(event);
  if (events.length > 1000) events.shift();
  view = applyEvent(view, event, Date.now());
  ui.tape(event.seq, `${event.type}${describe(event)}`);
  if (
    event.type === "track.added" ||
    event.type === "track.removed" ||
    event.type === "participant.left"
  ) {
    void resubscribe().catch(report);
  }
  if (event.type === "room.ended") screen = "ended";
  render();
}

function describe(event: RoomEvent): string {
  switch (event.type) {
    case "participant.joined":
      return ` ${event.payload.participant.name}`;
    case "participant.left":
      return ` ${event.payload.reason}`;
    case "lobby.request":
      return ` ${event.payload.name}`;
    case "track.added":
      return ` ${event.payload.track.source} ${event.payload.track.track_id.slice(0, 8)}`;
    case "track.updated":
      return ` ${event.payload.track_id.slice(0, 8)} ${JSON.stringify(event.payload.patch)}`;
    case "active_speakers":
      return ` ${event.payload.participant_ids.length}`;
    case "chat":
      return ` ${event.payload.body.slice(0, 24)}`;
    default:
      return "";
  }
}

async function resubscribe(): Promise<void> {
  if (!media || view.state !== "joined") return;
  const wanted = view.tracks.filter((t) => t.owner !== view.participantId).map((t) => t.track_id);
  await media.subscribe(wanted, prefs);
}

async function setLayer(trackId: string, maxLayer: number): Promise<void> {
  prefs = { ...prefs, [trackId]: { ...(prefs[trackId] ?? {}), max_layer: maxLayer } };
  await resubscribe();
}

const harness: Harness = {
  view: () => view,
  status: () => status,
  sessionId: () => join?.session_id ?? null,
  participantId: () => view.participantId,
  epoch: () => signaling?.epoch ?? null,
  seq: () => view.seq,
  events,
  closes,
  snapshots,
  lastAck: () => signaling?.lastAck ?? null,
  joinResponse: () => join,
  consumers: () =>
    (media?.feeds() ?? []).map((f) => ({
      track_id: f.trackId,
      consumer_id: f.consumerId,
      kind: f.kind,
    })),
  localTracks: () => media?.localTrackIds() ?? { audio: null, video: null },
  stats: (trackId) =>
    media?.stats(trackId) ??
    Promise.resolve({ packetsReceived: 0, framesDecoded: 0, bytesReceived: 0 }),
  frames: (trackId) => ui.frames(trackId),
  levels: () => meter.read(),
  dropSocket: () => signaling?.drop(),
  setLayer,
  lastError: () => error,
  joinError: () => joinError,
};
(window as unknown as { __harness: Harness }).__harness = harness;

// The meters and the clock move between events; nothing else does, so only a room ticks.
setInterval(() => {
  if (screen === "room") render();
}, 250);
render();
