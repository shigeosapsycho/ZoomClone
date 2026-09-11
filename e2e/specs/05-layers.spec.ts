import { expect, test } from "../src/fixtures";
import { openGallery } from "../src/gallery";

test("a subscriber asking for the lowest layer is told which layer it gets", async ({
  browser,
  api,
}) => {
  const token = await api.hostToken();
  const meeting = await api.createMeeting(token, { lobby: false });
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  try {
    const [host, ann] = await Promise.all([
      openGallery(contexts[0]!, { code: meeting.code, name: "Host", token }),
      openGallery(contexts[1]!, { code: meeting.code, name: "Ann" }),
    ]);
    await host.waitJoined();
    await ann.waitJoined();
    await expect.poll(() => ann.remoteTracks("video"), { timeout: 30_000 }).toHaveLength(1);
    const [hostCam] = await ann.remoteTracks("video");
    await expect.poll(() => ann.framesAdvancing(hostCam!), { timeout: 30_000 }).toBe(true);
    // The consumer's first track.updated {layers} arrived when it went active; only an update
    // sequenced after the request says which layer the lowest preference gets.
    const seqBefore = await ann.harness((h) => h.seq());
    await ann.page.evaluate(
      (id) =>
        (
          window as unknown as {
            __harness: { setLayer: (t: string, l: number) => Promise<void> };
          }
        ).__harness.setLayer(id, 0),
      hostCam!,
    );
    const updated = await ann.waitEvent(
      "track.updated",
      (e) =>
        e.type === "track.updated" &&
        e.seq > seqBefore &&
        e.payload.track_id === hostCam &&
        e.payload.patch.layers !== undefined,
      30_000,
    );
    if (updated.type !== "track.updated") throw new Error("unreachable");
    expect(updated.payload.patch.layers).toBeLessThanOrEqual(1);
    await expect(ann.page.getByTestId(`tile-${await host.participantId()}`)).toContainText("L1");
  } finally {
    for (const c of contexts) await c.close();
  }
});
