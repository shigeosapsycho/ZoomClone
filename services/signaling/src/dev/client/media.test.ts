import { afterEach, describe, expect, it, vi } from "vitest";
import { MediaSession, type MediaEvents } from "./media";
import { RequestError } from "./signaling";

const T1 = "trk1";
const T2 = "trk2";

type Request = (type: string, payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
type Ack = Record<string, unknown>;

function params(trackId: string, consumerId: string): Record<string, unknown> {
  return {
    track_id: trackId,
    consumer_id: consumerId,
    producer_id: `prod-${trackId}`,
    kind: "video",
    rtp_parameters: {},
    producer_paused: false,
  };
}

/**
 * A MediaSession over a scripted signaling client, with the private device and recv transport
 * replaced by fakes: consume() hands back a stub consumer, so no mediasoup-client Device is built.
 */
function build() {
  const request = vi.fn<Request>();
  const events: MediaEvents = { onFeed: vi.fn(), onFeedRemoved: vi.fn(), log: vi.fn() };
  const session = new MediaSession({ request } as never, events);
  const consume = vi.fn(async (opts: { id: string; kind: string }) => ({
    id: opts.id,
    kind: opts.kind,
    track: {},
    on() {},
    close() {},
  }));
  Object.assign(session, { device: { rtpCapabilities: {} }, recv: { consume } });
  return { session, request, events, consume };
}

/** The track id lists sent on every subscribe so far, in order. */
function subscribes(request: ReturnType<typeof vi.fn<Request>>): string[][] {
  return request.mock.calls
    .filter(([type]) => type === "subscribe")
    .map(([, payload]) => payload["track_ids"] as string[]);
}

function readyCalls(request: ReturnType<typeof vi.fn<Request>>): string[] {
  return request.mock.calls
    .filter(([type]) => type === "consumer_ready")
    .map(([, payload]) => payload["track_id"] as string);
}

/** Answers subscribe with one new consumer per asked id that `held` does not list; everything else acks {}. */
function answering(held: Set<string>, nextId: { n: number }): Request {
  return async (type, payload) => {
    if (type !== "subscribe") return {};
    const asked = payload["track_ids"] as string[];
    const removed = [...held].filter((id) => !asked.includes(id));
    for (const id of removed) held.delete(id);
    const consumers: Ack[] = [];
    for (const id of asked) {
      if (held.has(id)) continue;
      held.add(id);
      consumers.push(params(id, `c${++nextId.n}`));
    }
    return { consumers, removed };
  };
}

describe("MediaSession consumer recovery", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("puts the ids a failed subscribe asked for in doubt and recovers them in two steps", async () => {
    const { session, request, events } = build();
    const held = new Set<string>();
    const counter = { n: 0 };
    request.mockImplementation(answering(held, counter));
    await session.subscribe([T1]);
    expect(session.feeds().map((f) => f.consumerId)).toEqual(["c1"]);

    // The socket closes before the ack: the server may or may not have created T2's consumer.
    request.mockRejectedValueOnce(new RequestError("CLOSED", "socket closed"));
    await expect(session.subscribe([T1, T2])).rejects.toMatchObject({ code: "CLOSED" });
    expect(session.feeds().map((f) => f.trackId)).toEqual([T1]);

    // Say it did: a plain full-set subscribe would find the binding and return nothing.
    held.add(T2);
    await session.subscribe([T1, T2]);
    expect(subscribes(request)).toEqual([[T1], [T1, T2], [T1], [T1, T2]]);
    expect(session.feeds().map((f) => [f.trackId, f.consumerId])).toEqual([
      [T1, "c1"],
      [T2, "c2"],
    ]);
    expect(readyCalls(request)).toEqual([T1, T2]);
    expect(events.onFeedRemoved).not.toHaveBeenCalled();

    // Nothing is in doubt any more: the next subscribe is a single request.
    await session.subscribe([T1, T2]);
    expect(subscribes(request)).toHaveLength(5);
  });

  it("drops a consumer whose consumer_ready failed, marks it in doubt and recreates it next time", async () => {
    const { session, request, events } = build();
    const held = new Set<string>();
    const counter = { n: 0 };
    const answer = answering(held, counter);
    let failReady = true;
    request.mockImplementation(async (type, payload) => {
      if (type === "consumer_ready" && failReady) {
        failReady = false;
        throw new RequestError("INTERNAL", "sfu call failed");
      }
      return answer(type, payload);
    });
    await expect(session.subscribe([T1])).rejects.toMatchObject({ code: "INTERNAL" });
    expect(session.feeds()).toEqual([]);
    expect(events.onFeedRemoved).toHaveBeenCalledWith(T1);

    await session.subscribe([T1]);
    expect(subscribes(request)).toEqual([[T1], [], [T1]]);
    expect(session.feeds().map((f) => [f.trackId, f.consumerId])).toEqual([[T1, "c2"]]);
    expect(readyCalls(request)).toEqual([T1, T1]);
  });

  it("keeps a consumer whose consumer_ready answered NOT_FOUND and does not doubt it", async () => {
    const { session, request, events } = build();
    const held = new Set<string>();
    const answer = answering(held, { n: 0 });
    request.mockImplementation(async (type, payload) => {
      if (type === "consumer_ready") throw new RequestError("NOT_FOUND", "no consumer");
      return answer(type, payload);
    });
    await session.subscribe([T1]);
    expect(session.feeds().map((f) => f.consumerId)).toEqual(["c1"]);
    expect(events.onFeedRemoved).not.toHaveBeenCalled();

    await session.subscribe([T1]);
    expect(subscribes(request)).toEqual([[T1], [T1]]);
    expect(session.feeds().map((f) => f.consumerId)).toEqual(["c1"]);
  });
});

describe("MediaSession local media", () => {
  afterEach(() => vi.unstubAllGlobals());

  function producer(paused: boolean) {
    return {
      paused,
      pause() {
        this.paused = true;
      },
      resume() {
        this.paused = false;
      },
    };
  }

  it("reverts an optimistic mute when set_media_state fails", async () => {
    const { session, request } = build();
    const audio = producer(false);
    Object.assign(session, { producers: new Map([["audio", { producer: audio, trackId: "a" }]]) });
    request.mockRejectedValueOnce(new RequestError("CLOSED", "socket closed"));
    await expect(session.setMuted(true)).rejects.toMatchObject({ code: "CLOSED" });
    expect(audio.paused).toBe(false);
    expect((session as unknown as { state: { muted: boolean } }).state.muted).toBe(false);

    request.mockResolvedValueOnce({});
    await session.setMuted(true);
    expect(audio.paused).toBe(true);
    expect((session as unknown as { state: { muted: boolean } }).state.muted).toBe(true);
    expect(request).toHaveBeenLastCalledWith("set_media_state", { muted: true });
  });

  it("captures whichever of mic and camera the browser grants and fails only when neither is", async () => {
    const { session } = build();
    const videoTrack = { kind: "video" };
    const getUserMedia = vi.fn(async (constraints: { audio?: boolean; video?: unknown }) => {
      if (constraints.audio) throw new Error("Requested device not found");
      return { getAudioTracks: () => [], getVideoTracks: () => [videoTrack] };
    });
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    await expect(session.captureLocal()).resolves.toEqual({ audio: null, video: videoTrack });
    expect(getUserMedia).toHaveBeenCalledTimes(2);

    getUserMedia.mockRejectedValue(new Error("Permission denied"));
    await expect(session.captureLocal()).rejects.toThrow(/no microphone or camera/);
  });
});
