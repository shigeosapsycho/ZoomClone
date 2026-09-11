import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
  MediaKind,
  MediaSource,
  PublishRequestSchema,
  SfuService,
  StatsEventSchema,
  TransportDirection,
} from "./index";

describe("sfu proto", () => {
  it("exposes the fifteen RPCs of the contract", () => {
    const names = Object.keys(SfuService.method).sort();
    expect(names).toEqual(
      [
        "allocateRoom",
        "cascade",
        "closeRoom",
        "closeTransport",
        "connectTransport",
        "createTransport",
        "publish",
        "restartIce",
        "setConsumerPaused",
        "setLayer",
        "setProducerPaused",
        "stats",
        "subscribe",
        "unpublish",
        "unsubscribe",
      ].sort(),
    );
    expect(SfuService.method.stats.methodKind).toBe("server_streaming");
  });

  it("round-trips a publish request and the stats oneof", () => {
    const req = create(PublishRequestSchema, {
      sessionId: "s",
      participantId: "p",
      transportId: "t",
      kind: MediaKind.VIDEO,
      source: MediaSource.CAMERA,
      rtpParametersJson: "{}",
      paused: true,
    });
    const back = fromBinary(PublishRequestSchema, toBinary(PublishRequestSchema, req));
    expect(back.kind).toBe(MediaKind.VIDEO);
    expect(back.paused).toBe(true);

    const ev = create(StatsEventSchema, {
      event: {
        case: "consumerLayers",
        value: { consumerId: "c", active: true, spatialLayer: 1, temporalLayer: 2 },
      },
    });
    const evBack = fromBinary(StatsEventSchema, toBinary(StatsEventSchema, ev));
    expect(evBack.event.case).toBe("consumerLayers");
    expect(TransportDirection.RECV).toBe(2);
  });
});
