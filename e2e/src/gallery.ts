import { expect, type BrowserContext, type Page } from "@playwright/test";
import type { JoinResponse, RoomEvent } from "@zoomclone/protocol";
import { SIGNALING_URL } from "./services";

/** The subset of window.__harness the tests read (structural copy of the client's Harness type). */
export type HarnessShape = {
  view: () => {
    participantId: string | null;
    role: string | null;
    epoch: number;
    seq: number;
    state: string;
    roster: Array<{
      participant_id: string;
      name: string;
      muted: boolean;
      hand: boolean;
      connected: boolean;
    }>;
    tracks: Array<{
      track_id: string;
      owner: string;
      kind: string;
      source: string;
      paused: boolean;
      layers: number;
    }>;
    lobby: Array<{ participant_id: string }>;
    activeSpeakers: string[];
    layers: Record<string, number>;
  };
  status: () => string;
  sessionId: () => string | null;
  participantId: () => string | null;
  epoch: () => number | null;
  seq: () => number;
  events: RoomEvent[];
  closes: Array<{ code: number; reason: string; terminal: boolean }>;
  snapshots: Array<{ kind: string; seq: number; epoch: number }>;
  lastAck: () => { mode: string; epoch: number; seq: number } | null;
  consumers: () => Array<{ track_id: string; consumer_id: string; kind: string }>;
  localTracks: () => { audio: string | null; video: string | null };
  stats: (trackId: string) => Promise<{
    packetsReceived: number;
    framesDecoded: number;
    bytesReceived: number;
  }>;
  frames: (trackId: string) => number;
  dropSocket: () => void;
  setLayer: (trackId: string, maxLayer: number) => Promise<void>;
  joinResponse: () => JoinResponse | null;
  lastError: () => string | null;
  joinError: () => { status: number; code: string } | null;
};

export type Gallery = {
  page: Page;
  harness: <T>(fn: (h: HarnessShape) => T | Promise<T>) => Promise<T>;
  waitJoined: () => Promise<void>;
  waitWaiting: () => Promise<void>;
  waitEnded: () => Promise<void>;
  waitClosed: (code: number) => Promise<void>;
  remoteTracks: (kind: "audio" | "video") => Promise<string[]>;
  framesAdvancing: (trackId: string, ms?: number) => Promise<boolean>;
  packetsDelta: (trackId: string, ms?: number) => Promise<number>;
  waitEvent: (
    type: RoomEvent["type"],
    predicate?: (e: RoomEvent) => boolean,
    timeoutMs?: number,
  ) => Promise<RoomEvent>;
  click: (testId: string) => Promise<void>;
  participantId: () => Promise<string>;
  token: () => Promise<string>;
};

type HarnessWindow = { __harness: HarnessShape };

export async function openGallery(
  context: BrowserContext,
  input: { code: string; name: string; token?: string },
): Promise<Gallery> {
  const page = await context.newPage();
  await page.goto(`${SIGNALING_URL}/dev/`);
  await page.getByTestId("input-code").fill(input.code);
  await page.getByTestId("input-name").fill(input.name);
  if (input.token) await page.getByTestId("input-token").fill(input.token);
  await page.getByTestId("join").click();
  const gallery: Gallery = {
    page,
    // The arrow's source runs in the page against window.__harness; keep the arrows self-contained
    // (no closures over test variables: pass values through page.evaluate instead).
    harness: <T>(fn: (h: HarnessShape) => T | Promise<T>) =>
      page.evaluate(
        ({ src }) =>
          (new Function("h", `return (${src})(h)`) as (h: unknown) => unknown)(
            (window as unknown as HarnessWindow).__harness,
          ),
        { src: fn.toString() },
      ) as Promise<T>,
    waitJoined: async () => {
      await expect
        .poll(() => page.evaluate(() => (window as unknown as HarnessWindow).__harness.status()), {
          timeout: 30_000,
        })
        .toBe("joined");
    },
    waitWaiting: async () => {
      await expect(page.getByTestId("air-status")).toHaveText("waiting for the host");
    },
    waitEnded: async () => {
      await expect(page.getByTestId("ended-panel")).toBeVisible();
    },
    waitClosed: async (code) => {
      await expect
        .poll(
          () =>
            page.evaluate(() =>
              (window as unknown as HarnessWindow).__harness.closes.map((c) => c.code),
            ),
          { timeout: 30_000 },
        )
        .toContain(code);
    },
    remoteTracks: async (kind) =>
      page.evaluate((k) => {
        const h = (window as unknown as HarnessWindow).__harness;
        const me = h.participantId();
        return h
          .view()
          .tracks.filter((t) => t.owner !== me && t.kind === k)
          .map((t) => t.track_id);
      }, kind),
    framesAdvancing: async (trackId, ms = 1_500) => {
      const before = await page.evaluate(
        (id) => (window as unknown as HarnessWindow).__harness.frames(id),
        trackId,
      );
      await page.waitForTimeout(ms);
      const after = await page.evaluate(
        (id) => (window as unknown as HarnessWindow).__harness.frames(id),
        trackId,
      );
      return after > before;
    },
    packetsDelta: async (trackId, ms = 1_500) => {
      const before = await page.evaluate(
        (id) => (window as unknown as HarnessWindow).__harness.stats(id),
        trackId,
      );
      await page.waitForTimeout(ms);
      const after = await page.evaluate(
        (id) => (window as unknown as HarnessWindow).__harness.stats(id),
        trackId,
      );
      return after.packetsReceived - before.packetsReceived;
    },
    waitEvent: async (type, predicate = () => true, timeoutMs = 20_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const events = await page.evaluate(
          () => (window as unknown as HarnessWindow).__harness.events,
        );
        const found = events.find((e) => e.type === type && predicate(e));
        if (found) return found;
        await page.waitForTimeout(150);
      }
      throw new Error(`no ${type} event within ${timeoutMs} ms`);
    },
    click: (testId) => page.getByTestId(testId).click(),
    participantId: async () =>
      (await page.evaluate(() => (window as unknown as HarnessWindow).__harness.participantId())) ??
      "",
    token: async () =>
      (await page.evaluate(
        () => (window as unknown as HarnessWindow).__harness.joinResponse()?.signaling_token,
      )) ?? "",
  };
  return gallery;
}

/** Opens a raw socket from the test runner and returns the close code the server answers a hello with. */
export async function helloCloseCode(signalingUrl: string, token: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(signalingUrl);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("no close within 10 s"));
    }, 10_000);
    ws.addEventListener("open", () =>
      ws.send(JSON.stringify({ type: "hello", id: "h", payload: { token } })),
    );
    ws.addEventListener("close", (event) => {
      clearTimeout(timer);
      resolve(event.code);
    });
    ws.addEventListener("error", () => undefined);
  });
}
