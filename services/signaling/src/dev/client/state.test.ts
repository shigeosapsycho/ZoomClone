import { describe, expect, it } from "vitest";
import type { RoomEvent, Welcome } from "@zoomclone/protocol";
import { applyEvent, applySnapshot, emptyView, expireReactions } from "./state";

const HOST = "11111111-1111-4111-8111-111111111111";
const A = "22222222-2222-4222-8222-222222222222";

const entry = (id: string, role: "host" | "attendee") => ({
  participant_id: id,
  name: id === HOST ? "Host" : "Ann",
  role,
  muted: false,
  video_off: false,
  hand: false,
  connected: true,
  joined_at: "2026-09-10T10:00:00.000Z",
});

const welcome: Welcome = {
  participant_id: A,
  role: "attendee",
  epoch: 1,
  seq: 4,
  state: "joined",
  roster: [entry(HOST, "host"), entry(A, "attendee")],
  tracks: [
    { track_id: "t1", owner: HOST, kind: "video", source: "camera", paused: false, layers: 3 },
  ],
  room_meta: {
    session_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    locked: false,
    lobby_enabled: true,
    recording: false,
    host_ids: [HOST],
    max_participants: 10,
  },
};

function ev(seq: number, type: RoomEvent["type"], payload: unknown): RoomEvent {
  return { type, seq, payload } as RoomEvent;
}

describe("room view reducer", () => {
  it("applies a snapshot and ignores events at or below its seq", () => {
    const view = applySnapshot(emptyView(), welcome);
    expect(view.state).toBe("joined");
    expect(view.roster.map((r) => r.participant_id)).toEqual([HOST, A]);
    expect(view.tracks).toHaveLength(1);
    expect(view.seq).toBe(4);
    const stale = applyEvent(view, ev(4, "reaction", { from: HOST, emoji: "x" }), 0);
    expect(stale).toBe(view);
  });

  it("tracks roster, tracks, hands, chat, reactions, speakers, layers and room meta", () => {
    let view = applySnapshot(emptyView(), welcome);
    view = applyEvent(
      view,
      ev(5, "participant.joined", {
        participant: entry("33333333-3333-4333-8333-333333333333", "attendee"),
      }),
      0,
    );
    expect(view.roster).toHaveLength(3);
    view = applyEvent(
      view,
      ev(6, "participant.updated", { participant_id: A, patch: { muted: true, connected: false } }),
      0,
    );
    expect(view.roster.find((r) => r.participant_id === A)).toMatchObject({
      muted: true,
      connected: false,
    });
    view = applyEvent(
      view,
      ev(7, "track.added", {
        track: { track_id: "t2", owner: A, kind: "audio", source: "mic", paused: true, layers: 1 },
      }),
      0,
    );
    view = applyEvent(
      view,
      ev(8, "track.updated", { track_id: "t2", patch: { paused: false } }),
      0,
    );
    expect(view.tracks.find((t) => t.track_id === "t2")?.paused).toBe(false);
    view = applyEvent(view, ev(9, "track.updated", { track_id: "t1", patch: { layers: 2 } }), 0);
    expect(view.layers["t1"]).toBe(2);
    view = applyEvent(view, ev(10, "track.removed", { track_id: "t2" }), 0);
    expect(view.tracks.map((t) => t.track_id)).toEqual(["t1"]);
    view = applyEvent(view, ev(11, "hand", { participant_id: A, raised: true }), 0);
    expect(view.roster.find((r) => r.participant_id === A)?.hand).toBe(true);
    view = applyEvent(
      view,
      ev(12, "chat", { from: HOST, body: "hi", sent_at: "2026-09-10T10:01:00.000Z" }),
      0,
    );
    expect(view.chat).toEqual([{ from: HOST, body: "hi", sentAt: "2026-09-10T10:01:00.000Z" }]);
    view = applyEvent(view, ev(13, "reaction", { from: HOST, emoji: "clap" }), 1_000);
    expect(view.reactions).toEqual([{ from: HOST, emoji: "clap", until: 3_000 }]);
    expect(expireReactions(view, 3_001).reactions).toEqual([]);
    view = applyEvent(view, ev(14, "active_speakers", { participant_ids: [HOST] }), 0);
    expect(view.activeSpeakers).toEqual([HOST]);
    view = applyEvent(view, ev(15, "room.updated", { locked: true }), 0);
    expect(view.meta?.locked).toBe(true);
    view = applyEvent(
      view,
      ev(16, "participant.left", { participant_id: A, reason: "removed" }),
      0,
    );
    expect(view.roster.map((r) => r.participant_id)).not.toContain(A);
    view = applyEvent(view, ev(17, "room.ended", { reason: "host_end" }), 0);
    expect(view.state).toBe("ended");
    expect(view.endReason).toBe("host_end");
    expect(view.seq).toBe(17);
  });

  it("keeps the lobby list for hosts and handles lobby events", () => {
    const hostWelcome: Welcome = {
      ...welcome,
      participant_id: HOST,
      role: "host",
      lobby: [{ participant_id: A, name: "Ann", requested_at: "2026-09-10T10:00:00.000Z" }],
    };
    let view = applySnapshot(emptyView(), hostWelcome);
    expect(view.lobby).toHaveLength(1);
    view = applyEvent(
      view,
      ev(5, "lobby.request", {
        participant_id: "44444444-4444-4444-8444-444444444444",
        name: "Wren",
      }),
      0,
    );
    expect(view.lobby).toHaveLength(2);
    view = applyEvent(view, ev(6, "lobby.left", { participant_id: A }), 0);
    expect(view.lobby.map((l) => l.participant_id)).toEqual([
      "44444444-4444-4444-8444-444444444444",
    ]);
    const waiter = applySnapshot(emptyView(), {
      participant_id: A,
      role: "attendee",
      epoch: 1,
      seq: 2,
      state: "lobby",
    });
    expect(waiter.state).toBe("lobby");
    expect(applyEvent(waiter, ev(3, "lobby.result", { admitted: false }), 0).state).toBe("lobby");
  });
});
