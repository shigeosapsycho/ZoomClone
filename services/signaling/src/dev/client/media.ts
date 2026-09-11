import { Device, type types as msc } from "mediasoup-client";
import type { ConsumerParams, MediaKind, MediaParams, SubscriptionPref } from "@zoomclone/protocol";
import { RequestError, type SignalingClient } from "./signaling";

export type LocalTracks = { audio: MediaStreamTrack | null; video: MediaStreamTrack | null };
export type RemoteFeed = {
  trackId: string;
  kind: MediaKind;
  consumerId: string;
  track: MediaStreamTrack;
};
export type FeedStats = { packetsReceived: number; framesDecoded: number; bytesReceived: number };
export type MediaEvents = {
  onFeed: (feed: RemoteFeed) => void;
  onFeedRemoved: (trackId: string) => void;
  log?: (line: string) => void;
};

/** Design doc: 180p/150k, 360p/500k, 720p/1.5M. */
export const SIMULCAST_ENCODINGS: RTCRtpEncodingParameters[] = [
  { scaleResolutionDownBy: 4, maxBitrate: 150_000 },
  { scaleResolutionDownBy: 2, maxBitrate: 500_000 },
  { scaleResolutionDownBy: 1, maxBitrate: 1_500_000 },
];

type Opaque = Record<string, unknown>;

/**
 * mediasoup-client glue: transports from welcome.media, local producers, declarative consumers.
 * Transports survive signaling reconnects; a resync whose transport ids differ rebuilds them and
 * republishes / resubscribes (design doc "Reconnect").
 */
export class MediaSession {
  private device: Device | null = null;
  private send: msc.Transport | null = null;
  private recv: msc.Transport | null = null;
  private transportIds: { send: string; recv: string } | null = null;
  private producers = new Map<MediaKind, { producer: msc.Producer; trackId: string }>();
  private consumers = new Map<string, msc.Consumer>();
  private desired: string[] = [];
  private prefs: Record<string, SubscriptionPref> = {};
  private local: LocalTracks = { audio: null, video: null };
  private state = { muted: false, videoOff: false };
  private published = false;

  constructor(
    private readonly signaling: SignalingClient,
    private readonly events: MediaEvents,
  ) {}

  /** Creates the transports on the first snapshot; on a resync keeps them unless the ids changed. */
  async applyMedia(
    media: MediaParams,
    iceServers: RTCIceServer[],
  ): Promise<"created" | "kept" | "rebuilt"> {
    const ids = { send: media.send_transport.id, recv: media.recv_transport.id };
    if (
      this.transportIds &&
      this.transportIds.send === ids.send &&
      this.transportIds.recv === ids.recv
    ) {
      return "kept";
    }
    const rebuilt = this.transportIds !== null;
    this.teardownTransports();
    if (!this.device) {
      this.device = new Device();
      await this.device.load({
        routerRtpCapabilities: media.rtp_capabilities as msc.RtpCapabilities,
      });
    }
    this.send = this.device.createSendTransport({
      ...transportOptions(media.send_transport),
      iceServers,
    });
    this.recv = this.device.createRecvTransport({
      ...transportOptions(media.recv_transport),
      iceServers,
    });
    this.wireTransport(this.send, "send");
    this.wireTransport(this.recv, "recv");
    this.transportIds = ids;
    if (rebuilt) {
      this.events.log?.("transports rebuilt, republishing and resubscribing");
      if (this.published) await this.publishLocal(this.state);
      await this.subscribe(this.desired, this.prefs);
      return "rebuilt";
    }
    return "created";
  }

  async captureLocal(): Promise<LocalTracks> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    this.local = {
      audio: stream.getAudioTracks()[0] ?? null,
      video: stream.getVideoTracks()[0] ?? null,
    };
    return this.local;
  }

  get localTracks(): LocalTracks {
    return this.local;
  }

  /** Produces mic and camera; paused flags travel with the publish so a muted join stays muted. */
  async publishLocal(state: { muted: boolean; videoOff: boolean }): Promise<void> {
    const send = this.requireTransport(this.send, "send");
    this.state = { ...state };
    this.published = true;
    for (const p of this.producers.values()) p.producer.close();
    this.producers.clear();
    if (this.local.audio) {
      const producer = await send.produce({
        track: this.local.audio,
        appData: { source: "mic", paused: state.muted },
      });
      if (state.muted) producer.pause();
      this.producers.set("audio", { producer, trackId: producer.id });
    }
    if (this.local.video) {
      const producer = await send.produce({
        track: this.local.video,
        encodings: SIMULCAST_ENCODINGS,
        codecOptions: { videoGoogleStartBitrate: 1000 },
        appData: { source: "camera", paused: state.videoOff },
      });
      if (state.videoOff) producer.pause();
      this.producers.set("video", { producer, trackId: producer.id });
    }
  }

  async setMuted(muted: boolean): Promise<void> {
    this.state.muted = muted;
    const audio = this.producers.get("audio");
    if (audio) muted ? audio.producer.pause() : audio.producer.resume();
    await this.signaling.request("set_media_state", { muted });
  }

  async setVideoOff(videoOff: boolean): Promise<void> {
    this.state.videoOff = videoOff;
    const video = this.producers.get("video");
    if (video) videoOff ? video.producer.pause() : video.producer.resume();
    await this.signaling.request("set_media_state", { video_off: videoOff });
  }

  /** The roster is the truth (a host mute pauses the producer server side): mirror it locally. */
  syncPaused(state: { muted: boolean; videoOff: boolean }): void {
    this.state = { ...state };
    const audio = this.producers.get("audio");
    if (audio && audio.producer.paused !== state.muted)
      state.muted ? audio.producer.pause() : audio.producer.resume();
    const video = this.producers.get("video");
    if (video && video.producer.paused !== state.videoOff)
      state.videoOff ? video.producer.pause() : video.producer.resume();
  }

  /** Declarative: the full set of remote tracks to receive, with optional per-track prefs. */
  async subscribe(trackIds: string[], prefs: Record<string, SubscriptionPref> = {}): Promise<void> {
    this.desired = [...trackIds];
    this.prefs = { ...prefs };
    const recv = this.recv;
    const device = this.device;
    if (!recv || !device) return;
    const ack = (await this.signaling.request("subscribe", {
      rtp_capabilities: device.rtpCapabilities as Opaque,
      track_ids: trackIds,
      prefs,
    })) as { consumers: ConsumerParams[]; removed: string[] };
    for (const trackId of ack.removed) this.dropConsumer(trackId);
    for (const params of ack.consumers) {
      const consumer = await recv.consume({
        id: params.consumer_id,
        producerId: params.producer_id,
        kind: params.kind,
        rtpParameters: params.rtp_parameters as unknown as msc.RtpParameters,
        appData: { trackId: params.track_id },
      });
      this.consumers.set(params.track_id, consumer);
      consumer.on("transportclose", () => this.dropConsumer(params.track_id));
      this.events.onFeed({
        trackId: params.track_id,
        kind: params.kind,
        consumerId: consumer.id,
        track: consumer.track,
      });
      try {
        await this.signaling.request("consumer_ready", { track_id: params.track_id });
      } catch (error) {
        if (!(error instanceof RequestError && error.code === "NOT_FOUND")) throw error;
      }
    }
    // Tracks the server no longer knows (removed while we were away) get no consumer; drop stale ones.
    for (const trackId of [...this.consumers.keys()]) {
      if (!this.desired.includes(trackId)) this.dropConsumer(trackId);
    }
  }

  consumerFor(trackId: string): msc.Consumer | undefined {
    return this.consumers.get(trackId);
  }

  feeds(): RemoteFeed[] {
    return [...this.consumers].map(([trackId, c]) => ({
      trackId,
      kind: c.kind as MediaKind,
      consumerId: c.id,
      track: c.track,
    }));
  }

  localTrackIds(): { audio: string | null; video: string | null } {
    return {
      audio: this.producers.get("audio")?.trackId ?? null,
      video: this.producers.get("video")?.trackId ?? null,
    };
  }

  async stats(trackId: string): Promise<FeedStats> {
    const consumer = this.consumers.get(trackId);
    const out: FeedStats = { packetsReceived: 0, framesDecoded: 0, bytesReceived: 0 };
    if (!consumer) return out;
    const report = await consumer.getStats();
    report.forEach(
      (entry: {
        type?: string;
        packetsReceived?: number;
        framesDecoded?: number;
        bytesReceived?: number;
      }) => {
        if (entry.type !== "inbound-rtp") return;
        out.packetsReceived += entry.packetsReceived ?? 0;
        out.framesDecoded += entry.framesDecoded ?? 0;
        out.bytesReceived += entry.bytesReceived ?? 0;
      },
    );
    return out;
  }

  close(): void {
    this.teardownTransports();
    for (const track of [this.local.audio, this.local.video]) track?.stop();
    this.local = { audio: null, video: null };
    this.published = false;
  }

  private wireTransport(transport: msc.Transport, direction: "send" | "recv"): void {
    transport.on("connect", ({ dtlsParameters }, callback, errback) => {
      this.signaling
        .request("connect_transport", {
          transport: direction,
          dtls_parameters: dtlsParameters as unknown as Opaque,
        })
        .then(() => callback())
        .catch((error: unknown) =>
          errback(error instanceof Error ? error : new Error(String(error))),
        );
    });
    if (direction === "send") {
      transport.on("produce", ({ kind, rtpParameters, appData }, callback, errback) => {
        const data = appData as { source: "mic" | "camera"; paused: boolean };
        this.signaling
          .request("publish", {
            kind,
            source: data.source,
            rtp_parameters: rtpParameters as unknown as Opaque,
            paused: data.paused,
          })
          .then((ack) => callback({ id: String(ack["track_id"]) }))
          .catch((error: unknown) =>
            errback(error instanceof Error ? error : new Error(String(error))),
          );
      });
    }
    transport.on("connectionstatechange", (state) =>
      this.events.log?.(`${direction} transport ${state}`),
    );
  }

  private dropConsumer(trackId: string): void {
    const consumer = this.consumers.get(trackId);
    if (!consumer) return;
    this.consumers.delete(trackId);
    consumer.close();
    this.events.onFeedRemoved(trackId);
  }

  private teardownTransports(): void {
    for (const trackId of [...this.consumers.keys()]) this.dropConsumer(trackId);
    for (const p of this.producers.values()) p.producer.close();
    this.producers.clear();
    this.send?.close();
    this.recv?.close();
    this.send = null;
    this.recv = null;
    this.transportIds = null;
  }

  private requireTransport(transport: msc.Transport | null, direction: string): msc.Transport {
    if (!transport) throw new Error(`no ${direction} transport yet (waiting for welcome)`);
    return transport;
  }
}

function transportOptions(params: MediaParams["send_transport"]): msc.TransportOptions {
  return {
    id: params.id,
    iceParameters: params.ice_parameters as unknown as msc.IceParameters,
    iceCandidates: params.ice_candidates as unknown as msc.IceCandidate[],
    dtlsParameters: params.dtls_parameters as unknown as msc.DtlsParameters,
  };
}
