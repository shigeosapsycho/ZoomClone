import { setTimeout as sleep } from "node:timers/promises";
import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { SfuService, type Snapshot, type StatsEvent } from "@zoomclone/sfu-proto";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeSfu } from "../../test/fake-sfu";
import { StatsConsumer } from "./stats-consumer";
import { SfuDirectory, UnknownSfuError } from "./directory";

const S = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const log = pino({ level: "silent" });

let fake: FakeSfu;
beforeEach(async () => {
  fake = new FakeSfu();
  await fake.start();
});
afterEach(async () => {
  await fake.stop();
});

describe("SfuDirectory", () => {
  it("caches one client per sfu id and rejects unknown ids", () => {
    const directory = new SfuDirectory({ "sfu-a": fake.baseUrl });
    expect(directory.ids()).toEqual(["sfu-a"]);
    expect(directory.get("sfu-a")).toBe(directory.get("sfu-a"));
    expect(directory.has("sfu-b")).toBe(false);
    expect(() => directory.get("sfu-b")).toThrow(UnknownSfuError);
  });
});

describe("StatsConsumer", () => {
  it("opens after beforeOpen, delivers the snapshot first, then events, and reopens after a drop", async () => {
    const client = createClient(SfuService, createGrpcTransport({ baseUrl: fake.baseUrl }));
    const snapshots: Snapshot[] = [];
    const events: StatsEvent[] = [];
    let opens = 0;
    const consumer = new StatsConsumer(
      client,
      S,
      {
        beforeOpen: async () => {
          opens++;
          await client.allocateRoom({ sessionId: S });
        },
        onSnapshot: (s) => snapshots.push(s),
        onEvent: (e) => events.push(e),
      },
      log,
      50,
    );
    await consumer.start();
    expect(opens).toBe(1);
    expect(snapshots).toHaveLength(1);
    fake.emit(S, { case: "silence", value: {} });
    await sleep(50);
    expect(events.map((e) => e.event.case)).toEqual(["silence"]);

    fake.dropStreams(S);
    await sleep(300);
    expect(opens).toBe(2);
    expect(snapshots).toHaveLength(2);
    fake.emit(S, { case: "silence", value: {} });
    await sleep(50);
    expect(events).toHaveLength(2);

    consumer.stop();
    await consumer.done;
    expect(fake.callsTo("stats")).toHaveLength(2);
  });

  it("start rejects when no snapshot arrives in time and stops cleanly", async () => {
    const client = createClient(SfuService, createGrpcTransport({ baseUrl: fake.baseUrl }));
    const consumer = new StatsConsumer(
      client,
      S,
      { onSnapshot: () => undefined, onEvent: () => undefined },
      log,
      50,
    );
    // No allocateRoom: the fake answers NOT_FOUND and the consumer keeps retrying.
    await expect(consumer.start(200)).rejects.toThrow(/no stats snapshot/);
    consumer.stop();
    await consumer.done;
    expect(fake.callsTo("stats").length).toBeGreaterThanOrEqual(2);
  });
});
