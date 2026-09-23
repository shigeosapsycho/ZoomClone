import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CLIENT_DTLS_PARAMETERS,
  audioRtpParameters,
  startTestSfu,
  type TestSfu,
} from "@zoomclone/sfu/testing";
import {
  TestClient,
  createTestInfra,
  mintClaims,
  mintToken,
  seedSession,
  startTestSignaling,
  waitFor,
  type TestInfra,
  type TestSignaling,
} from "../test/helpers";

const HOST = "11111111-1111-4111-8111-111111111111";
const A = "22222222-2222-4222-8222-222222222222";

let infra: TestInfra;
let sfu: TestSfu;
let signaling: TestSignaling;

beforeAll(async () => {
  infra = await createTestInfra();
  sfu = await startTestSfu();
  signaling = await startTestSignaling(infra, sfu.baseUrl);
});
afterAll(async () => {
  await signaling.close();
  await sfu.stop();
  await infra.close();
});

describe("signaling against the real SFU", () => {
  it("hands out real transport parameters, publishes and subscribes with mediasoup shapes, and closes the SFU room on end", async () => {
    const { sessionId } = await seedSession(infra.db);
    const host = await TestClient.connect(`${signaling.url}/rooms/${sessionId}`);
    const ann = await TestClient.connect(`${signaling.url}/rooms/${sessionId}`);
    await host.request("hello", {
      token: await mintToken(
        infra,
        mintClaims({ session_id: sessionId, participant_id: HOST, role: "host" }),
      ),
    });
    const welcome = await host.waitFor("welcome");
    const media = welcome.payload.media;
    if (!media) throw new Error("expected media");
    expect(media.rtp_capabilities["codecs"]).toBeInstanceOf(Array);
    expect(media.send_transport.ice_parameters["usernameFragment"]).toBeTypeOf("string");
    expect(media.send_transport.ice_candidates.length).toBeGreaterThan(0);
    expect(media.send_transport.dtls_parameters["fingerprints"]).toBeInstanceOf(Array);
    expect(media.recv_transport.id).not.toBe(media.send_transport.id);

    await ann.request("hello", {
      token: await mintToken(infra, mintClaims({ session_id: sessionId, participant_id: A })),
    });
    const annWelcome = await ann.waitFor("welcome");

    expect(
      await host.request("connect_transport", {
        transport: "send",
        dtls_parameters: CLIENT_DTLS_PARAMETERS as unknown as Record<string, unknown>,
      }),
    ).toMatchObject({ type: "ack" });
    const publish = await host.request("publish", {
      kind: "audio",
      source: "mic",
      rtp_parameters: audioRtpParameters() as unknown as Record<string, unknown>,
      paused: false,
    });
    expect(publish.type).toBe("ack");
    const trackId = (publish.payload as { track_id: string }).track_id;
    await ann.waitFor("track.added", (m) => m.payload.track.track_id === trackId);

    const subscribe = await ann.request("subscribe", {
      rtp_capabilities: annWelcome.payload.media!.rtp_capabilities,
      track_ids: [trackId],
      prefs: {},
    });
    expect(subscribe.type).toBe("ack");
    const consumers = (
      subscribe.payload as {
        consumers: Array<{
          consumer_id: string;
          kind: string;
          rtp_parameters: Record<string, unknown>;
        }>;
      }
    ).consumers;
    expect(consumers).toHaveLength(1);
    expect(consumers[0]?.kind).toBe("audio");
    expect(consumers[0]?.rtp_parameters["codecs"]).toBeInstanceOf(Array);
    expect(await ann.request("consumer_ready", { track_id: trackId })).toMatchObject({
      type: "ack",
    });
    expect(sfu.manager.size).toBe(1);

    await host.request("host.end", {});
    expect((await ann.waitForClose()).code).toBe(4004);
    expect((await host.waitForClose()).code).toBe(4004);
    // CloseRoom runs after the sockets close; poll instead of guessing the gap.
    await waitFor(() => sfu.manager.size === 0);
    expect(sfu.manager.size).toBe(0);
  });
});
