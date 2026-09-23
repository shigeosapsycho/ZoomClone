import { describe, expect, it } from "vitest";
import {
  ClientMessageSchema,
  ConsumerParamsSchema,
  HelloAckSchema,
  ServerMessageSchema,
  SubscribeAckSchema,
  WelcomeSchema,
} from "./index";

const pid = "2f6a2b6e-6f0b-4c1e-9a52-0c5d3f1a9b12";
const sid = "2f6a2b6e-6f0b-4c1e-9a52-0c5d3f1a9b11";

describe("ClientMessageSchema", () => {
  const cases: Array<[string, unknown]> = [
    ["hello", { token: "t", resume_seq: 10, epoch: 2 }],
    ["hello", { token: "t" }],
    ["connect_transport", { transport: "send", dtls_parameters: { role: "client" } }],
    ["publish", { kind: "video", source: "camera", rtp_parameters: { codecs: [] } }],
    ["unpublish", { track_id: "trk_1" }],
    ["subscribe", { track_ids: ["trk_1"], prefs: { trk_1: { max_layer: 1, priority: 10 } } }],
    ["consumer_ready", { track_id: "trk_1" }],
    ["set_media_state", { muted: true }],
    ["raise_hand", {}],
    ["lower_hand", {}],
    ["reaction", { emoji: "👍" }],
    ["chat", { body: "hi", to: pid }],
    ["host.admit", { participant_id: pid }],
    ["host.deny", { participant_id: pid }],
    ["host.mute", { participant_id: pid }],
    ["host.remove", { participant_id: pid }],
    ["host.lock", { locked: true }],
    ["host.end", {}],
    ["restart_ice", { transport: "recv" }],
    ["ping", { ts: 1 }],
  ];

  it.each(cases)("parses %s", (type, payload) => {
    const result = ClientMessageSchema.safeParse({ type, id: "r1", payload });
    expect(result.success, JSON.stringify(result.error)).toBe(true);
  });

  it("defaults publish.paused to false and subscribe.prefs to {}", () => {
    const pub = ClientMessageSchema.parse({
      type: "publish",
      id: "r1",
      payload: { kind: "audio", source: "mic", rtp_parameters: {} },
    });
    expect(pub.type === "publish" && pub.payload.paused).toBe(false);
    const sub = ClientMessageSchema.parse({
      type: "subscribe",
      id: "r2",
      payload: { track_ids: [] },
    });
    expect(sub.type === "subscribe" && sub.payload.prefs).toEqual({});
  });

  it("rejects unknown types, missing id and screen as a kind", () => {
    expect(ClientMessageSchema.safeParse({ type: "nope", id: "r", payload: {} }).success).toBe(
      false,
    );
    expect(ClientMessageSchema.safeParse({ type: "ping", payload: { ts: 1 } }).success).toBe(false);
    expect(
      ClientMessageSchema.safeParse({
        type: "publish",
        id: "r",
        payload: { kind: "screen", source: "screen", rtp_parameters: {} },
      }).success,
    ).toBe(false);
  });

  it("limits chat to 4 KB measured in UTF-8 bytes", () => {
    const threeByteChar = "€";
    const ok = ClientMessageSchema.safeParse({
      type: "chat",
      id: "r",
      payload: { body: threeByteChar.repeat(1365) },
    });
    const tooBig = ClientMessageSchema.safeParse({
      type: "chat",
      id: "r",
      payload: { body: threeByteChar.repeat(1366) },
    });
    expect(ok.success).toBe(true);
    expect(tooBig.success).toBe(false);
  });
});

describe("ServerMessageSchema", () => {
  const roster = {
    participant_id: pid,
    name: "Ana",
    role: "attendee",
    muted: false,
    video_off: false,
    hand: false,
    connected: true,
    joined_at: "2026-09-10T09:00:00.000Z",
  };

  it("parses a joined welcome with media", () => {
    const welcome = {
      participant_id: pid,
      role: "attendee",
      epoch: 1,
      seq: 5,
      state: "joined",
      roster: [roster],
      tracks: [
        { track_id: "trk", owner: pid, kind: "video", source: "camera", paused: false, layers: 3 },
      ],
      lobby: [],
      room_meta: {
        session_id: sid,
        locked: false,
        lobby_enabled: true,
        recording: false,
        host_ids: [],
        max_participants: 500,
      },
      media: {
        rtp_capabilities: { codecs: [] },
        send_transport: { id: "t1", ice_parameters: {}, ice_candidates: [], dtls_parameters: {} },
        recv_transport: { id: "t2", ice_parameters: {}, ice_candidates: [], dtls_parameters: {} },
      },
    };
    expect(WelcomeSchema.safeParse(welcome).success).toBe(true);
    expect(ServerMessageSchema.safeParse({ type: "welcome", payload: welcome }).success).toBe(true);
    expect(ServerMessageSchema.safeParse({ type: "resync", payload: welcome }).success).toBe(true);
  });

  it("parses a lobby welcome with only ids", () => {
    const ok = ServerMessageSchema.safeParse({
      type: "welcome",
      payload: { participant_id: pid, role: "attendee", epoch: 1, seq: 0, state: "lobby" },
    });
    expect(ok.success).toBe(true);
  });

  it("requires seq on room events and id on ack/error", () => {
    expect(
      ServerMessageSchema.safeParse({
        type: "participant.joined",
        seq: 1,
        payload: { participant: roster },
      }).success,
    ).toBe(true);
    expect(
      ServerMessageSchema.safeParse({
        type: "participant.joined",
        payload: { participant: roster },
      }).success,
    ).toBe(false);
    expect(
      ServerMessageSchema.safeParse({ type: "ack", id: "r1", payload: { track_id: "trk" } })
        .success,
    ).toBe(true);
    expect(
      ServerMessageSchema.safeParse({
        type: "error",
        id: "r1",
        payload: { code: "FORBIDDEN", message: "host only" },
      }).success,
    ).toBe(true);
    expect(ServerMessageSchema.safeParse({ type: "pong", payload: { ts: 1 } }).success).toBe(true);
  });

  it("parses the remaining room events", () => {
    const events: Array<[string, unknown]> = [
      ["participant.left", { participant_id: pid, reason: "timeout" }],
      ["participant.updated", { participant_id: pid, patch: { muted: true, connected: false } }],
      [
        "track.added",
        {
          track: {
            track_id: "t",
            owner: pid,
            kind: "audio",
            source: "mic",
            paused: false,
            layers: 1,
          },
        },
      ],
      ["track.removed", { track_id: "t" }],
      ["track.updated", { track_id: "t", patch: { paused: true } }],
      ["active_speakers", { participant_ids: [pid] }],
      ["lobby.request", { participant_id: pid, name: "Ana" }],
      ["lobby.result", { admitted: false }],
      ["chat", { from: pid, body: "hi", sent_at: "2026-09-10T09:00:00.000Z" }],
      ["reaction", { from: pid, emoji: "👍" }],
      ["hand", { participant_id: pid, raised: true }],
      ["room.updated", { locked: true }],
      ["room.ended", { reason: "host_end" }],
    ];
    for (const [type, payload] of events) {
      const result = ServerMessageSchema.safeParse({ type, seq: 7, payload });
      expect(result.success, `${type}: ${JSON.stringify(result.error)}`).toBe(true);
    }
  });

  it("accepts lobby.left and the hello ack payload", () => {
    const left = ServerMessageSchema.safeParse({
      type: "lobby.left",
      seq: 7,
      payload: { participant_id: "0f1b6c2e-8d5a-4e2b-9c1d-2b3a4c5d6e7f" },
    });
    expect(left.success).toBe(true);
    expect(HelloAckSchema.safeParse({ mode: "replay", epoch: 2, seq: 40 }).success).toBe(true);
    expect(HelloAckSchema.safeParse({ mode: "nope", epoch: 2, seq: 40 }).success).toBe(false);
  });

  it("SubscribeAckSchema carries consumer params", () => {
    const ok = SubscribeAckSchema.safeParse({
      consumers: [
        {
          track_id: "t",
          consumer_id: "c",
          producer_id: "p",
          kind: "video",
          rtp_parameters: {},
          producer_paused: false,
        },
      ],
      removed: ["old"],
    });
    expect(ok.success).toBe(true);
  });

  it("requires producer_id on consumer params", () => {
    const base = {
      track_id: "t1",
      consumer_id: "c1",
      kind: "audio",
      rtp_parameters: {},
      producer_paused: false,
    };
    expect(ConsumerParamsSchema.safeParse(base).success).toBe(false);
    expect(ConsumerParamsSchema.safeParse({ ...base, producer_id: "p1" }).success).toBe(true);
  });
});
