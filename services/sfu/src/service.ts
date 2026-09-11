import { Code, ConnectError, type ConnectRouter } from "@connectrpc/connect";
import type { MessageInitShape } from "@bufbuild/protobuf";
import {
  MediaKind,
  MediaSource,
  SfuService,
  StatsEventSchema,
  TransportDirection,
} from "@zoomclone/sfu-proto";
import type { types as ms } from "mediasoup";
import { SfuError, type SfuErrorCode } from "./errors";
import type { RoomEvent } from "./events";
import type { Direction, Kind, Room, RoomManager, RoomSnapshot, Source } from "./rooms";

const CODE_MAP: Record<SfuErrorCode, Code> = {
  NOT_FOUND: Code.NotFound,
  PERMISSION_DENIED: Code.PermissionDenied,
  FAILED_PRECONDITION: Code.FailedPrecondition,
  INVALID_ARGUMENT: Code.InvalidArgument,
  UNIMPLEMENTED: Code.Unimplemented,
  INTERNAL: Code.Internal,
};

export function toConnectError(error: unknown): ConnectError {
  if (error instanceof ConnectError) return error;
  if (error instanceof SfuError) return new ConnectError(error.message, CODE_MAP[error.code]);
  return new ConnectError(error instanceof Error ? error.message : String(error), Code.Internal);
}

export function parseJsonObject<T>(field: string, text: string): T {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ConnectError(`${field} is not valid JSON`, Code.InvalidArgument);
  }
  if (typeof value !== "object" || value === null) {
    throw new ConnectError(`${field} must be a JSON object`, Code.InvalidArgument);
  }
  return value as T;
}

export function kindFromProto(value: MediaKind): Kind {
  if (value === MediaKind.AUDIO) return "audio";
  if (value === MediaKind.VIDEO) return "video";
  throw new ConnectError("kind is required", Code.InvalidArgument);
}

export function kindToProto(kind: Kind): MediaKind {
  return kind === "audio" ? MediaKind.AUDIO : MediaKind.VIDEO;
}

const SOURCE_FROM_PROTO: Partial<Record<MediaSource, Source>> = {
  [MediaSource.MIC]: "mic",
  [MediaSource.CAMERA]: "camera",
  [MediaSource.SCREEN]: "screen",
  [MediaSource.SCREEN_AUDIO]: "screen_audio",
};
const SOURCE_TO_PROTO: Record<Source, MediaSource> = {
  mic: MediaSource.MIC,
  camera: MediaSource.CAMERA,
  screen: MediaSource.SCREEN,
  screen_audio: MediaSource.SCREEN_AUDIO,
};

export function sourceFromProto(value: MediaSource): Source {
  const source = SOURCE_FROM_PROTO[value];
  if (!source) throw new ConnectError("source is required", Code.InvalidArgument);
  return source;
}

export function sourceToProto(source: Source): MediaSource {
  return SOURCE_TO_PROTO[source];
}

export function directionFromProto(value: TransportDirection): Direction {
  if (value === TransportDirection.SEND) return "send";
  if (value === TransportDirection.RECV) return "recv";
  throw new ConnectError("direction is required", Code.InvalidArgument);
}

export function directionToProto(direction: Direction): TransportDirection {
  return direction === "send" ? TransportDirection.SEND : TransportDirection.RECV;
}

/**
 * connect-es handlers hand back MessageInitShape, not the branded Message type: plain object
 * literals satisfy it without a $typeName, so the proto mapping below can stay a plain function.
 */
type StatsEventInit = MessageInitShape<typeof StatsEventSchema>;

function snapshotToProto(snapshot: RoomSnapshot): StatsEventInit["event"] {
  return {
    case: "snapshot",
    value: {
      transports: snapshot.transports.map((t) => ({
        transportId: t.transportId,
        participantId: t.participantId,
        direction: directionToProto(t.direction),
        iceState: t.iceState,
        dtlsState: t.dtlsState,
      })),
      producers: snapshot.producers.map((p) => ({
        producerId: p.producerId,
        meta: {
          sfuId: p.meta.sfuId,
          sessionId: p.meta.sessionId,
          participantId: p.meta.participantId,
          trackId: p.meta.trackId,
          kind: kindToProto(p.meta.kind),
          source: sourceToProto(p.meta.source),
          origin: p.meta.origin,
        },
        paused: p.paused,
        layerCount: p.layerCount,
        transportId: p.transportId,
      })),
      consumers: snapshot.consumers.map((c) => ({
        consumerId: c.consumerId,
        producerId: c.producerId,
        participantId: c.participantId,
        transportId: c.transportId,
        paused: c.paused,
        producerPaused: c.producerPaused,
        preferredSpatialLayer: c.preferredLayers?.spatialLayer,
        preferredTemporalLayer: c.preferredLayers?.temporalLayer,
        currentSpatialLayer: c.currentLayers?.spatialLayer,
        currentTemporalLayer: c.currentLayers?.temporalLayer,
        priority: c.priority,
      })),
    },
  };
}

/** Room events become StatsEvent oneof cases; room_closed ends the stream and is not sent. */
function eventToProto(event: RoomEvent): StatsEventInit["event"] | undefined {
  switch (event.type) {
    case "dominant_speakers":
      return { case: "dominantSpeakers", value: { speakers: event.speakers } };
    case "silence":
      return { case: "silence", value: {} };
    case "consumer_layers":
      return {
        case: "consumerLayers",
        value: {
          consumerId: event.consumerId,
          active: event.active,
          spatialLayer: event.spatialLayer,
          temporalLayer: event.temporalLayer,
        },
      };
    case "producer_score":
      return { case: "producerScore", value: { producerId: event.producerId, score: event.score } };
    case "producer_closed":
      return {
        case: "producerClosed",
        value: {
          producerId: event.producerId,
          trackId: event.trackId,
          participantId: event.participantId,
        },
      };
    case "consumer_closed":
      return {
        case: "consumerClosed",
        value: { consumerId: event.consumerId, reason: event.reason },
      };
    case "ice_state":
      return {
        case: "iceState",
        value: {
          transportId: event.transportId,
          participantId: event.participantId,
          state: event.state,
        },
      };
    case "transport_closed":
      return {
        case: "transportClosed",
        value: {
          transportId: event.transportId,
          participantId: event.participantId,
          reason: event.reason,
        },
      };
    case "qos":
      return {
        case: "qos",
        value: {
          transportId: event.transportId,
          participantId: event.participantId,
          bytesSent: BigInt(Math.round(event.bytesSent)),
          bytesReceived: BigInt(Math.round(event.bytesReceived)),
          sendBitrate: event.sendBitrate,
          recvBitrate: event.recvBitrate,
          availableOutgoingBitrate: event.availableOutgoingBitrate,
          rtpPacketLossSent: event.rtpPacketLossSent,
          rtpPacketLossReceived: event.rtpPacketLossReceived,
        },
      };
    case "room_closed":
      return undefined;
  }
}

function unary<I, O>(fn: (req: I) => Promise<O>): (req: I) => Promise<O> {
  return async (req) => {
    try {
      return await fn(req);
    } catch (error) {
      throw toConnectError(error);
    }
  };
}

/** The streaming handler has no unary() wrapper, so its room lookup maps the error itself. */
function requireRoom(manager: RoomManager, sessionId: string): Room {
  try {
    return manager.require(sessionId);
  } catch (error) {
    throw toConnectError(error);
  }
}

export function sfuRoutes(manager: RoomManager): (router: ConnectRouter) => void {
  return (router) => {
    router.service(SfuService, {
      allocateRoom: unary(async (req) => {
        const room = await manager.allocate(req.sessionId);
        return {
          rtpCapabilitiesJson: JSON.stringify(room.router.rtpCapabilities),
          sfuId: manager.sfuId,
        };
      }),
      closeRoom: unary(async (req) => {
        await manager.close(req.sessionId);
        return {};
      }),
      createTransport: unary(async (req) => {
        const room = manager.require(req.sessionId);
        const params = await room.createTransport(
          req.participantId,
          directionFromProto(req.direction),
        );
        return {
          transportId: params.transportId,
          iceParametersJson: JSON.stringify(params.iceParameters),
          iceCandidatesJson: JSON.stringify(params.iceCandidates),
          dtlsParametersJson: JSON.stringify(params.dtlsParameters),
        };
      }),
      connectTransport: unary(async (req) => {
        const room = manager.requireRoomByTransport(req.transportId);
        const dtls = parseJsonObject<ms.DtlsParameters>(
          "dtls_parameters_json",
          req.dtlsParametersJson,
        );
        await room.connectTransport(req.transportId, dtls);
        return {};
      }),
      closeTransport: unary(async (req) => {
        const room = manager.requireRoomByTransport(req.transportId);
        await room.closeTransport(req.transportId);
        return {};
      }),
      restartIce: unary(async (req) => {
        const room = manager.requireRoomByTransport(req.transportId);
        const ice = await room.restartIce(req.transportId);
        return { iceParametersJson: JSON.stringify(ice) };
      }),
      publish: unary(async (req) => {
        const room = manager.require(req.sessionId);
        const kind = kindFromProto(req.kind);
        const source = sourceFromProto(req.source);
        const rtp = parseJsonObject<ms.RtpParameters>("rtp_parameters_json", req.rtpParametersJson);
        const result = await room.publish(
          req.participantId,
          req.transportId,
          kind,
          source,
          rtp,
          req.paused,
        );
        return {
          producerId: result.producerId,
          trackId: result.trackId,
          layerCount: result.layerCount,
        };
      }),
      unpublish: unary(async (req) => {
        const room = manager.requireRoomByProducer(req.producerId);
        await room.unpublish(req.producerId);
        return {};
      }),
      setProducerPaused: unary(async (req) => {
        const room = manager.requireRoomByProducer(req.producerId);
        await room.setProducerPaused(req.producerId, req.paused);
        return {};
      }),
      subscribe: unary(async (req) => {
        const caps = parseJsonObject<ms.RtpCapabilities>(
          "rtp_capabilities_json",
          req.rtpCapabilitiesJson,
        );
        const result = await manager.subscribe(
          req.sessionId,
          req.participantId,
          req.transportId,
          req.producerId,
          caps,
          req.maxSpatialLayer,
          req.priority,
        );
        return {
          consumerId: result.consumerId,
          kind: kindToProto(result.kind),
          rtpParametersJson: JSON.stringify(result.rtpParameters),
          producerPaused: result.producerPaused,
        };
      }),
      setConsumerPaused: unary(async (req) => {
        const room = manager.requireRoomByConsumer(req.consumerId);
        await room.setConsumerPaused(req.consumerId, req.paused);
        return {};
      }),
      unsubscribe: unary(async (req) => {
        const room = manager.requireRoomByConsumer(req.consumerId);
        await room.unsubscribe(req.consumerId);
        return {};
      }),
      setLayer: unary(async (req) => {
        const room = manager.requireRoomByConsumer(req.consumerId);
        await room.setLayer(req.consumerId, req.spatialLayer, req.temporalLayer, req.priority);
        return {};
      }),
      cascade: unary(async () => {
        throw new SfuError("UNIMPLEMENTED", "cascade arrives with the cross-region slice");
      }),
      async *stats(req, context) {
        const room = requireRoom(manager, req.sessionId);
        const { snapshot, events } = room.openStats(context.signal);
        yield { event: snapshotToProto(snapshot) };
        for await (const event of events) {
          if (event.type === "room_closed") return;
          const mapped = eventToProto(event);
          if (mapped) yield { event: mapped };
        }
      },
    });
  };
}
