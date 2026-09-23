import { describe, expect, it } from "vitest";
import { CloseCode, ServerMessageSchema, type TrackInfo } from "@zoomclone/protocol";
import { Room, type RoomInit } from "./room";
import type { Emitted, Outcome } from "./types";

const S = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const HOST = "11111111-1111-4111-8111-111111111111";
const A = "22222222-2222-4222-8222-222222222222";
const B = "33333333-3333-4333-8333-333333333333";
const W = "44444444-4444-4444-8444-444444444444";
const T0 = Date.parse("2026-09-10T10:00:00.000Z");

function fresh(overrides: Partial<RoomInit> = {}): Room {
  return Room.create({
    session_id: S,
    home_sfu: "sfu-local-1",
    lobby_enabled: true,
    max_participants: 4,
    ...overrides,
  });
}

function must(outcome: Outcome): Emitted[] {
  if (!outcome.ok)
    throw new Error(`expected ok, got ${outcome.error.code}: ${outcome.error.message}`);
  for (const e of outcome.events) expect(ServerMessageSchema.safeParse(e.event).success).toBe(true);
  return outcome.events;
}

function mustFail(outcome: Outcome) {
  if (outcome.ok) throw new Error("expected failure");
  return outcome.error;
}

function types(events: Emitted[]): string[] {
  return events.map((e) => e.event.type);
}

function track(owner: string, id: string, source: TrackInfo["source"] = "mic"): TrackInfo {
  return {
    track_id: id,
    owner,
    kind: source === "mic" || source === "screen_audio" ? "audio" : "video",
    source,
    paused: false,
    layers: source === "camera" ? 3 : 1,
  };
}

/** Host plus two attendees joined, one mic and one camera track for A. */
function seeded(): Room {
  const room = fresh();
  must(room.apply({ type: "join", participant_id: HOST, name: "Host", role: "host" }, T0));
  must(room.apply({ type: "join", participant_id: A, name: "Ann", role: "attendee" }, T0 + 1));
  must(room.apply({ type: "join", participant_id: B, name: "Bob", role: "attendee" }, T0 + 2));
  must(room.apply({ type: "publish", participant_id: A, track: track(A, "t-a-mic") }, T0 + 3));
  must(
    room.apply(
      { type: "publish", participant_id: A, track: track(A, "t-a-cam", "camera") },
      T0 + 4,
    ),
  );
  return room;
}

describe("Room: joining", () => {
  it("adds to the roster, tracks peak and hosts, and tells everyone except the joiner", () => {
    const room = fresh();
    const events = must(
      room.apply({ type: "join", participant_id: HOST, name: "Host", role: "host" }, T0),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toEqual({
      type: "participant.joined",
      seq: 1,
      payload: {
        participant: {
          participant_id: HOST,
          name: "Host",
          role: "host",
          muted: false,
          video_off: false,
          hand: false,
          connected: true,
          joined_at: "2026-09-10T10:00:00.000Z",
        },
      },
    });
    expect(events[0]?.target).toEqual({ kind: "all_except", participant_id: HOST });
    expect(room.peak).toBe(1);
    expect(room.hostIds()).toEqual([HOST]);
    expect(room.isHost(HOST)).toBe(true);
    expect(room.isIdle()).toBe(false);
  });

  it.each([
    {
      name: "locked room refuses attendees with 4009",
      setup: (room: Room) => {
        must(room.apply({ type: "join", participant_id: HOST, name: "H", role: "host" }, T0));
        must(room.apply({ type: "lock", actor: HOST, locked: true }, T0));
      },
      join: { participant_id: A, role: "attendee" as const },
      code: "LOCKED",
      close: CloseCode.LOCKED,
    },
    {
      name: "full room refuses with 4007",
      setup: (room: Room) => {
        for (const id of [HOST, A, B, W]) {
          must(room.apply({ type: "join", participant_id: id, name: id, role: "attendee" }, T0));
        }
      },
      join: { participant_id: "55555555-5555-4555-8555-555555555555", role: "attendee" as const },
      code: "CAPACITY",
      close: CloseCode.CAPACITY,
    },
    {
      name: "removed participant is refused with 4002",
      setup: (room: Room) => {
        must(room.apply({ type: "join", participant_id: HOST, name: "H", role: "host" }, T0));
        must(room.apply({ type: "join", participant_id: A, name: "A", role: "attendee" }, T0));
        must(room.apply({ type: "remove", actor: HOST, participant_id: A }, T0));
      },
      join: { participant_id: A, role: "attendee" as const },
      code: "FORBIDDEN",
      close: CloseCode.REMOVED,
    },
    {
      name: "denied waiter is refused with 4003",
      setup: (room: Room) => {
        must(room.apply({ type: "join", participant_id: HOST, name: "H", role: "host" }, T0));
        must(room.apply({ type: "lobby_request", participant_id: W, name: "W" }, T0));
        must(room.apply({ type: "deny", actor: HOST, participant_id: W }, T0));
      },
      join: { participant_id: W, role: "attendee" as const },
      code: "FORBIDDEN",
      close: CloseCode.LOBBY_DENIED,
    },
    {
      name: "grace-expired participant is refused with 4008",
      setup: (room: Room) => {
        must(room.apply({ type: "join", participant_id: A, name: "A", role: "attendee" }, T0));
        must(room.apply({ type: "disconnect", participant_id: A }, T0));
        must(room.apply({ type: "leave", participant_id: A }, T0));
      },
      join: { participant_id: A, role: "attendee" as const },
      code: "FORBIDDEN",
      close: CloseCode.REJOIN_REQUIRED,
    },
    {
      name: "ended room refuses with 4004",
      setup: (room: Room) => {
        must(room.apply({ type: "end", reason: "host_end" }, T0));
      },
      join: { participant_id: A, role: "attendee" as const },
      code: "FORBIDDEN",
      close: CloseCode.ROOM_ENDED,
    },
  ])("$name", ({ setup, join, code, close }) => {
    const room = fresh();
    setup(room);
    const error = mustFail(
      room.apply(
        { type: "join", participant_id: join.participant_id, name: "x", role: join.role },
        T0,
      ),
    );
    expect(error.code).toBe(code);
    expect(error.close).toBe(close);
  });

  it("lets a host into a locked room and refuses duplicate joins", () => {
    const room = fresh();
    must(room.apply({ type: "join", participant_id: HOST, name: "H", role: "host" }, T0));
    must(room.apply({ type: "lock", actor: HOST, locked: true }, T0));
    const second = "55555555-5555-4555-8555-555555555555";
    must(room.apply({ type: "join", participant_id: second, name: "H2", role: "host" }, T0));
    expect(
      mustFail(room.apply({ type: "join", participant_id: HOST, name: "H", role: "host" }, T0))
        .code,
    ).toBe("INVALID");
  });

  it("canJoin mirrors join's rejections without mutating anything", () => {
    const room = fresh({ max_participants: 2 });
    must(room.apply({ type: "join", participant_id: HOST, name: "H", role: "host" }, T0));
    expect(room.canJoin(A, "attendee")).toBeNull();
    must(room.apply({ type: "lock", actor: HOST, locked: true }, T0));
    expect(room.canJoin(A, "attendee")).toMatchObject({ code: "LOCKED", close: CloseCode.LOCKED });
    expect(room.canJoin(A, "host")).toBeNull();
    must(room.apply({ type: "lock", actor: HOST, locked: false }, T0));
    must(room.apply({ type: "join", participant_id: A, name: "A", role: "attendee" }, T0));
    expect(room.canJoin(B, "attendee")).toMatchObject({
      code: "CAPACITY",
      close: CloseCode.CAPACITY,
    });
    expect(room.canJoin(A, "attendee")).toMatchObject({ code: "INVALID" });
    must(room.apply({ type: "remove", actor: HOST, participant_id: A }, T0));
    expect(room.canJoin(A, "attendee")).toMatchObject({
      code: "FORBIDDEN",
      close: CloseCode.REMOVED,
    });
    expect(room.seq).toBe(room.toSnapshot().seq);
    must(room.apply({ type: "end", reason: "host_end" }, T0));
    expect(room.canJoin(B, "attendee")).toMatchObject({ close: CloseCode.ROOM_ENDED });
  });
});

describe("Room: lobby", () => {
  it("request notifies hosts, admit moves the waiter in with lobby.result then participant.joined", () => {
    const room = fresh();
    must(room.apply({ type: "join", participant_id: HOST, name: "H", role: "host" }, T0));
    const request = must(
      room.apply({ type: "lobby_request", participant_id: W, name: "Wren" }, T0),
    );
    expect(request[0]?.event).toMatchObject({
      type: "lobby.request",
      payload: { participant_id: W, name: "Wren" },
    });
    expect(request[0]?.target).toEqual({ kind: "hosts" });
    expect(room.inLobby(W)).toBe(true);
    expect(room.lobby()).toEqual([
      { participant_id: W, name: "Wren", requested_at: "2026-09-10T10:00:00.000Z" },
    ]);

    const admit = must(room.apply({ type: "admit", actor: HOST, participant_id: W }, T0 + 5));
    expect(types(admit)).toEqual(["lobby.result", "participant.joined"]);
    expect(admit[0]?.event.payload).toEqual({ admitted: true });
    expect(admit[0]?.target).toEqual({ kind: "only", participant_ids: [W] });
    expect(admit[1]?.target).toEqual({ kind: "all_except", participant_id: W });
    expect(room.inLobby(W)).toBe(false);
    expect(room.rosterEntry(W)).toMatchObject({ role: "attendee", connected: true });
  });

  it("deny answers the waiter, tells hosts lobby.left and marks the waiter departed", () => {
    const room = fresh();
    must(room.apply({ type: "join", participant_id: HOST, name: "H", role: "host" }, T0));
    must(room.apply({ type: "lobby_request", participant_id: W, name: "W" }, T0));
    const deny = must(room.apply({ type: "deny", actor: HOST, participant_id: W }, T0));
    expect(types(deny)).toEqual(["lobby.result", "lobby.left"]);
    expect(deny[0]?.event.payload).toEqual({ admitted: false });
    expect(deny[1]?.target).toEqual({ kind: "hosts" });
    expect(room.departed(W)).toBe("denied");
    expect(room.lobby()).toEqual([]);
  });

  it("lobby_leave drops the waiter with lobby.left and is a no-op for strangers", () => {
    const room = fresh();
    must(room.apply({ type: "join", participant_id: HOST, name: "H", role: "host" }, T0));
    must(room.apply({ type: "lobby_request", participant_id: W, name: "W" }, T0));
    expect(types(must(room.apply({ type: "lobby_leave", participant_id: W }, T0)))).toEqual([
      "lobby.left",
    ]);
    expect(must(room.apply({ type: "lobby_leave", participant_id: W }, T0))).toEqual([]);
    expect(room.departed(W)).toBeUndefined();
  });

  it("waiters are refused while locked, and admit refuses when the room is full", () => {
    const room = fresh({ max_participants: 2 });
    must(room.apply({ type: "join", participant_id: HOST, name: "H", role: "host" }, T0));
    must(room.apply({ type: "lobby_request", participant_id: W, name: "W" }, T0));
    must(room.apply({ type: "join", participant_id: A, name: "A", role: "attendee" }, T0));
    expect(mustFail(room.apply({ type: "admit", actor: HOST, participant_id: W }, T0)).code).toBe(
      "CAPACITY",
    );
    must(room.apply({ type: "lock", actor: HOST, locked: true }, T0));
    const locked = mustFail(
      room.apply({ type: "lobby_request", participant_id: B, name: "B" }, T0),
    );
    expect(locked.close).toBe(CloseCode.LOCKED);
  });

  it("room end reaches waiters too", () => {
    const room = fresh();
    must(room.apply({ type: "join", participant_id: HOST, name: "H", role: "host" }, T0));
    must(room.apply({ type: "lobby_request", participant_id: W, name: "W" }, T0));
    const ended = must(room.apply({ type: "end", reason: "host_end" }, T0));
    expect(ended[0]?.target).toEqual({ kind: "everyone" });
  });
});

describe("Room: host controls and roles", () => {
  it.each([
    { type: "admit", actor: A, participant_id: W },
    { type: "deny", actor: A, participant_id: W },
    { type: "host_mute", actor: A, participant_id: B },
    { type: "remove", actor: A, participant_id: B },
  ] as const)("$type from an attendee is FORBIDDEN (role comes from the roster)", (command) => {
    const room = seeded();
    must(room.apply({ type: "lobby_request", participant_id: W, name: "W" }, T0));
    expect(mustFail(room.apply(command, T0)).code).toBe("FORBIDDEN");
  });

  it("lock from an attendee is FORBIDDEN and from a host emits room.updated once", () => {
    const room = seeded();
    expect(mustFail(room.apply({ type: "lock", actor: A, locked: true }, T0)).code).toBe(
      "FORBIDDEN",
    );
    const events = must(room.apply({ type: "lock", actor: HOST, locked: true }, T0));
    expect(events[0]?.event).toMatchObject({ type: "room.updated", payload: { locked: true } });
    expect(must(room.apply({ type: "lock", actor: HOST, locked: true }, T0))).toEqual([]);
    expect(room.locked).toBe(true);
  });

  it("remove drops the participant and their tracks, refuses self and hosts, and denies waiters", () => {
    const room = seeded();
    const events = must(room.apply({ type: "remove", actor: HOST, participant_id: A }, T0 + 10));
    expect(types(events)).toEqual(["track.removed", "track.removed", "participant.left"]);
    expect(events[2]?.event.payload).toEqual({ participant_id: A, reason: "removed" });
    expect(room.inRoster(A)).toBe(false);
    expect(room.tracks()).toEqual([]);
    expect(room.departed(A)).toBe("removed");
    expect(
      mustFail(room.apply({ type: "remove", actor: HOST, participant_id: HOST }, T0)).code,
    ).toBe("INVALID");
    const second = "55555555-5555-4555-8555-555555555555";
    must(room.apply({ type: "join", participant_id: second, name: "H2", role: "host" }, T0));
    expect(
      mustFail(room.apply({ type: "remove", actor: HOST, participant_id: second }, T0)).code,
    ).toBe("FORBIDDEN");
    expect(mustFail(room.apply({ type: "remove", actor: HOST, participant_id: W }, T0)).code).toBe(
      "NOT_FOUND",
    );
    must(room.apply({ type: "lobby_request", participant_id: W, name: "W" }, T0));
    const waiter = must(room.apply({ type: "remove", actor: HOST, participant_id: W }, T0));
    expect(types(waiter)).toEqual(["lobby.result", "lobby.left"]);
    expect(room.departed(W)).toBe("denied");
  });

  it("host_mute mutes the target and pauses their mic tracks", () => {
    const room = seeded();
    const events = must(room.apply({ type: "host_mute", actor: HOST, participant_id: A }, T0));
    expect(types(events)).toEqual(["participant.updated", "track.updated"]);
    expect(events[0]?.event.payload).toEqual({ participant_id: A, patch: { muted: true } });
    expect(events[1]?.event.payload).toEqual({ track_id: "t-a-mic", patch: { paused: true } });
    expect(room.rosterEntry(A)?.muted).toBe(true);
    expect(room.track("t-a-mic")?.paused).toBe(true);
    expect(room.track("t-a-cam")?.paused).toBe(false);
    expect(must(room.apply({ type: "host_mute", actor: HOST, participant_id: A }, T0))).toEqual([]);
  });
});

describe("Room: presence", () => {
  it("disconnect and reconnect toggle connected, notify the others, and are idempotent", () => {
    const room = seeded();
    const off = must(room.apply({ type: "disconnect", participant_id: A }, T0));
    expect(off[0]?.event).toMatchObject({
      type: "participant.updated",
      payload: { participant_id: A, patch: { connected: false } },
    });
    expect(off[0]?.target).toEqual({ kind: "all_except", participant_id: A });
    expect(must(room.apply({ type: "disconnect", participant_id: A }, T0))).toEqual([]);
    const on = must(room.apply({ type: "reconnect", participant_id: A }, T0));
    expect(on[0]?.event.payload).toEqual({ participant_id: A, patch: { connected: true } });
    expect(must(room.apply({ type: "reconnect", participant_id: A }, T0))).toEqual([]);
    expect(mustFail(room.apply({ type: "disconnect", participant_id: W }, T0)).code).toBe(
      "NOT_FOUND",
    );
  });

  it("leave after the grace removes tracks, reports timeout, marks departed grace, and is a no-op twice", () => {
    const room = seeded();
    const events = must(room.apply({ type: "leave", participant_id: A }, T0));
    expect(types(events)).toEqual(["track.removed", "track.removed", "participant.left"]);
    expect(events[2]?.event.payload).toEqual({ participant_id: A, reason: "timeout" });
    expect(events[2]?.target).toEqual({ kind: "all" });
    expect(room.departed(A)).toBe("grace");
    expect(must(room.apply({ type: "leave", participant_id: A }, T0))).toEqual([]);
    expect(room.peak).toBe(3);
  });

  it("is idle only when roster and lobby are both empty", () => {
    const room = fresh();
    expect(room.isIdle()).toBe(true);
    must(room.apply({ type: "lobby_request", participant_id: W, name: "W" }, T0));
    expect(room.isIdle()).toBe(false);
    must(room.apply({ type: "lobby_leave", participant_id: W }, T0));
    expect(room.isIdle()).toBe(true);
  });
});

describe("Room: tracks and media state", () => {
  it("publish adds a track for everyone; owner mismatch and duplicates are rejected", () => {
    const room = seeded();
    const events = must(
      room.apply({ type: "publish", participant_id: B, track: track(B, "t-b-mic") }, T0),
    );
    expect(events[0]?.event).toMatchObject({
      type: "track.added",
      payload: { track: { track_id: "t-b-mic" } },
    });
    expect(events[0]?.target).toEqual({ kind: "all" });
    expect(
      mustFail(room.apply({ type: "publish", participant_id: B, track: track(A, "t-x") }, T0)).code,
    ).toBe("INVALID");
    expect(
      mustFail(room.apply({ type: "publish", participant_id: B, track: track(B, "t-b-mic") }, T0))
        .code,
    ).toBe("INVALID");
    expect(
      mustFail(room.apply({ type: "publish", participant_id: W, track: track(W, "t-w") }, T0)).code,
    ).toBe("NOT_FOUND");
  });

  it("unpublish requires the owner; track_lost is a no-op for unknown tracks", () => {
    const room = seeded();
    expect(
      mustFail(room.apply({ type: "unpublish", participant_id: B, track_id: "t-a-mic" }, T0)).code,
    ).toBe("FORBIDDEN");
    expect(
      mustFail(room.apply({ type: "unpublish", participant_id: A, track_id: "nope" }, T0)).code,
    ).toBe("NOT_FOUND");
    expect(
      types(must(room.apply({ type: "unpublish", participant_id: A, track_id: "t-a-mic" }, T0))),
    ).toEqual(["track.removed"]);
    expect(types(must(room.apply({ type: "track_lost", track_id: "t-a-cam" }, T0)))).toEqual([
      "track.removed",
    ]);
    expect(must(room.apply({ type: "track_lost", track_id: "t-a-cam" }, T0))).toEqual([]);
    expect(room.tracks()).toEqual([]);
  });

  it("track_layers goes only to the subscriber and changes no state", () => {
    const room = seeded();
    // seeded() leaves the dirty set populated from its own joins/publishes; clear it first so
    // this test's takeDirty() below reflects only the track_layers command, matching the sibling
    // "reactions and active_speakers" test's pattern in the same file.
    room.takeDirty();
    const events = must(
      room.apply({ type: "track_layers", participant_id: B, track_id: "t-a-cam", layers: 1 }, T0),
    );
    expect(events[0]?.event).toMatchObject({
      type: "track.updated",
      payload: { track_id: "t-a-cam", patch: { layers: 1 } },
    });
    expect(events[0]?.target).toEqual({ kind: "only", participant_ids: [B] });
    expect(room.takeDirty().size).toBe(0);
    expect(
      must(
        room.apply({ type: "track_layers", participant_id: B, track_id: "gone", layers: 1 }, T0),
      ),
    ).toEqual([]);
  });

  it("set_media_state patches only what changed and pauses the matching tracks", () => {
    const room = seeded();
    const muted = must(room.apply({ type: "set_media_state", participant_id: A, muted: true }, T0));
    expect(types(muted)).toEqual(["participant.updated", "track.updated"]);
    expect(muted[1]?.event.payload).toEqual({ track_id: "t-a-mic", patch: { paused: true } });
    expect(
      must(room.apply({ type: "set_media_state", participant_id: A, muted: true }, T0)),
    ).toEqual([]);
    const video = must(
      room.apply({ type: "set_media_state", participant_id: A, muted: true, video_off: true }, T0),
    );
    expect(video[0]?.event.payload).toEqual({ participant_id: A, patch: { video_off: true } });
    expect(video[1]?.event.payload).toEqual({ track_id: "t-a-cam", patch: { paused: true } });
    const both = must(
      room.apply(
        { type: "set_media_state", participant_id: A, muted: false, video_off: false },
        T0,
      ),
    );
    expect(both[0]?.event.payload).toEqual({
      participant_id: A,
      patch: { muted: false, video_off: false },
    });
    expect(types(both)).toEqual(["participant.updated", "track.updated", "track.updated"]);
    expect(must(room.apply({ type: "set_media_state", participant_id: A }, T0))).toEqual([]);
  });

  it("a track published while muted keeps the paused flag it was given", () => {
    const room = seeded();
    must(room.apply({ type: "set_media_state", participant_id: B, muted: true }, T0));
    expect(room.rosterEntry(B)?.muted).toBe(true);
    must(
      room.apply(
        { type: "publish", participant_id: B, track: { ...track(B, "t-b-mic"), paused: true } },
        T0,
      ),
    );
    expect(room.track("t-b-mic")?.paused).toBe(true);
    const unmute = must(
      room.apply({ type: "set_media_state", participant_id: B, muted: false }, T0),
    );
    expect(unmute[1]?.event.payload).toEqual({ track_id: "t-b-mic", patch: { paused: false } });
  });
});

describe("Room: hand, chat, reactions, active speakers", () => {
  it("hand emits the hand event only when the flag changes", () => {
    const room = seeded();
    const up = must(room.apply({ type: "hand", participant_id: A, raised: true }, T0));
    expect(up.map((e) => e.event)).toEqual([
      { type: "hand", seq: 6, payload: { participant_id: A, raised: true } },
    ]);
    expect(must(room.apply({ type: "hand", participant_id: A, raised: true }, T0))).toEqual([]);
    expect(room.rosterEntry(A)?.hand).toBe(true);
  });

  it("chat broadcasts to all, direct messages reach sender and recipient, unknown recipients fail", () => {
    const room = seeded();
    const all = must(room.apply({ type: "chat", from: A, body: "hi" }, T0));
    expect(all[0]?.event.payload).toEqual({
      from: A,
      body: "hi",
      sent_at: "2026-09-10T10:00:00.000Z",
    });
    expect(all[0]?.target).toEqual({ kind: "all" });
    const dm = must(room.apply({ type: "chat", from: A, body: "psst", to: B }, T0));
    expect(dm[0]?.event.payload).toMatchObject({ from: A, to: B, body: "psst" });
    expect(dm[0]?.target).toEqual({ kind: "only", participant_ids: [A, B] });
    expect(mustFail(room.apply({ type: "chat", from: A, body: "x", to: W }, T0)).code).toBe(
      "NOT_FOUND",
    );
    expect(mustFail(room.apply({ type: "chat", from: W, body: "x" }, T0)).code).toBe("NOT_FOUND");
  });

  it("reactions and active_speakers fan to all; active_speakers dirties nothing", () => {
    const room = seeded();
    room.takeDirty();
    const reaction = must(room.apply({ type: "reaction", from: A, emoji: "clap" }, T0));
    expect(reaction[0]?.event.payload).toEqual({ from: A, emoji: "clap" });
    const speakers = must(room.apply({ type: "active_speakers", participant_ids: [A] }, T0));
    expect(speakers[0]?.event).toMatchObject({
      type: "active_speakers",
      payload: { participant_ids: [A] },
    });
    expect(speakers[0]?.target).toEqual({ kind: "all" });
    expect(room.takeDirty().size).toBe(0);
  });
});

describe("Room: end", () => {
  it("emits room.ended to everyone, is idempotent, and blocks every later command with 4004", () => {
    const room = seeded();
    const events = must(room.apply({ type: "end", reason: "host_end" }, T0));
    expect(events.map((e) => e.event)).toEqual([
      { type: "room.ended", seq: 6, payload: { reason: "host_end" } },
    ]);
    expect(room.status).toBe("ended");
    expect(room.endReason).toBe("host_end");
    expect(must(room.apply({ type: "end", reason: "api_end" }, T0))).toEqual([]);
    expect(room.endReason).toBe("host_end");
    const error = mustFail(room.apply({ type: "reaction", from: A, emoji: "x" }, T0));
    expect(error.code).toBe("FORBIDDEN");
    expect(error.close).toBe(CloseCode.ROOM_ENDED);
  });
});

describe("Room: seq, replay and welcome", () => {
  it("seq is monotonic across commands and welcome carries the current value", () => {
    const room = seeded();
    expect(room.seq).toBe(5);
    must(room.apply({ type: "reaction", from: A, emoji: "x" }, T0));
    expect(room.seq).toBe(6);
    expect(room.welcomeFor(A).seq).toBe(6);
  });

  it("replays only the events addressed to the participant since the cursor", () => {
    const room = fresh();
    must(room.apply({ type: "join", participant_id: HOST, name: "H", role: "host" }, T0)); // 1
    must(room.apply({ type: "join", participant_id: A, name: "A", role: "attendee" }, T0)); // 2 all_except A
    must(room.apply({ type: "lobby_request", participant_id: W, name: "W" }, T0)); // 3 hosts
    must(room.apply({ type: "reaction", from: HOST, emoji: "x" }, T0)); // 4 all
    must(room.apply({ type: "chat", from: HOST, body: "dm", to: A }, T0)); // 5 only [HOST, A]
    expect(room.replay(A, 1, T0)?.map((e) => e.seq)).toEqual([4, 5]);
    expect(room.replay(HOST, 1, T0)?.map((e) => e.seq)).toEqual([2, 3, 4, 5]);
    expect(room.replay(A, 5, T0)).toEqual([]);
    expect(room.replay(A, 9, T0)).toBeNull();
  });

  it("forces a resync once the window (500 events or 60 s) no longer covers the cursor", () => {
    const room = seeded();
    for (let i = 0; i < 500; i++)
      must(room.apply({ type: "reaction", from: A, emoji: "x" }, T0 + i));
    // seeded() leaves seq at 5 (events 1-5); 500 more pushes evict exactly the first 5 (the ring
    // holds maxSize=500), so the surviving window is seq 6-505 and oldestSeq is 6. A cursor of 5
    // sits exactly at oldestSeq - 1, i.e. no event was missed (seq 6 is still present), so per
    // RingBuffer.replay's own boundary rule (oldest === afterSeq + 1 is not a gap, matches its
    // own test in ring-buffer.test.ts) that cursor still replays cleanly. Cursor 4 is the first
    // one for which seq 5 itself (needed, now evicted) creates a real gap, forcing null.
    expect(room.replay(B, 4, T0 + 500)).toBeNull();
    expect(room.replay(B, 6, T0 + 500)).toHaveLength(499);
    expect(room.replay(B, 6, T0 + 500 + 60_000)).toBeNull();
    expect(room.replay(B, room.seq, T0 + 500 + 60_000)).toEqual([]);
  });

  it("welcome: joined members get roster, tracks and meta, hosts also the lobby, waiters only ids", () => {
    const room = seeded();
    must(room.apply({ type: "lobby_request", participant_id: W, name: "W" }, T0));
    const host = room.welcomeFor(HOST);
    expect(host).toMatchObject({
      participant_id: HOST,
      role: "host",
      epoch: 1,
      seq: 6,
      state: "joined",
    });
    expect(host.roster?.map((r) => r.participant_id)).toEqual([HOST, A, B]);
    expect(host.tracks?.map((t) => t.track_id)).toEqual(["t-a-mic", "t-a-cam"]);
    expect(host.lobby?.map((l) => l.participant_id)).toEqual([W]);
    expect(host.room_meta).toEqual({
      session_id: S,
      locked: false,
      lobby_enabled: true,
      recording: false,
      host_ids: [HOST],
      max_participants: 4,
    });
    expect(host.media).toBeUndefined();
    const attendee = room.welcomeFor(A);
    expect(attendee.lobby).toBeUndefined();
    expect(room.welcomeFor(W)).toEqual({
      participant_id: W,
      role: "attendee",
      epoch: 1,
      seq: 6,
      state: "lobby",
    });
    expect(() => room.welcomeFor("nobody")).toThrow();
  });
});

describe("Room: snapshot, dirty tracking, departed expiry", () => {
  it("round-trips through a snapshot; rehydrating bumps the epoch and disconnects everyone", () => {
    const room = seeded();
    must(room.apply({ type: "lobby_request", participant_id: W, name: "W" }, T0));
    must(room.apply({ type: "lock", actor: HOST, locked: true }, T0));
    must(room.apply({ type: "remove", actor: HOST, participant_id: B }, T0));
    const snapshot = room.toSnapshot();
    expect(snapshot).toMatchObject({
      session_id: S,
      home_sfu: "sfu-local-1",
      epoch: 1,
      seq: room.seq,
      status: "live",
      end_reason: null,
      locked: true,
      lobby_enabled: true,
      recording: false,
      max_participants: 4,
      host_ids: [HOST],
      peak: 3,
    });
    expect(snapshot.departed[B]).toMatchObject({ reason: "removed" });
    const same = Room.fromSnapshot(snapshot, { bumpEpoch: false });
    expect(same.toSnapshot()).toEqual(snapshot);
    const rehydrated = Room.fromSnapshot(snapshot, { bumpEpoch: true });
    expect(rehydrated.epoch).toBe(2);
    expect(rehydrated.roster().every((r) => !r.connected)).toBe(true);
    expect(rehydrated.seq).toBe(snapshot.seq);
    expect(rehydrated.replay(A, snapshot.seq - 1, T0)).toBeNull();
    expect(rehydrated.departed(B)).toBe("removed");
    expect(rehydrated.inLobby(W)).toBe(true);
  });

  it("tracks dirty sections per command and clears them on takeDirty", () => {
    const room = fresh();
    room.takeDirty();
    must(room.apply({ type: "join", participant_id: HOST, name: "H", role: "host" }, T0));
    expect([...room.takeDirty()].sort()).toEqual(["meta", "roster"]);
    must(room.apply({ type: "lobby_request", participant_id: W, name: "W" }, T0));
    expect([...room.takeDirty()]).toEqual(["lobby"]);
    must(room.apply({ type: "publish", participant_id: HOST, track: track(HOST, "t") }, T0));
    expect([...room.takeDirty()]).toEqual(["tracks"]);
    must(room.apply({ type: "deny", actor: HOST, participant_id: W }, T0));
    expect([...room.takeDirty()].sort()).toEqual(["departed", "lobby"]);
    must(room.apply({ type: "reaction", from: HOST, emoji: "x" }, T0));
    expect(room.takeDirty().size).toBe(0);
    room.markAllDirty();
    expect(room.takeDirty().size).toBe(5);
  });

  it("forgets departed participants after the ttl", () => {
    const room = Room.create(
      { session_id: S, home_sfu: "sfu-local-1", lobby_enabled: false, max_participants: 4 },
      { ringSize: 500, ringMs: 60_000, departedTtlMs: 1_000 },
    );
    must(room.apply({ type: "join", participant_id: HOST, name: "H", role: "host" }, T0));
    must(room.apply({ type: "join", participant_id: A, name: "A", role: "attendee" }, T0));
    must(room.apply({ type: "remove", actor: HOST, participant_id: A }, T0));
    expect(
      mustFail(
        room.apply({ type: "join", participant_id: A, name: "A", role: "attendee" }, T0 + 999),
      ).close,
    ).toBe(CloseCode.REMOVED);
    must(room.apply({ type: "join", participant_id: A, name: "A", role: "attendee" }, T0 + 1_000));
    expect(room.departed(A)).toBeUndefined();
  });
});
