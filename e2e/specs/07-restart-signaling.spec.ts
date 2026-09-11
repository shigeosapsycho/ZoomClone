import { expect, test } from "../src/fixtures";
import { openGallery } from "../src/gallery";

test("a restarted signaling process rehydrates the room and the clients resync", async ({
  browser,
  api,
  services,
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
    const before = await ann.harness((h) => ({
      roster: h
        .view()
        .roster.map((r) => r.participant_id)
        .sort(),
      tracks: h
        .view()
        .tracks.map((t) => t.track_id)
        .sort(),
      epoch: h.epoch(),
    }));

    await services.restartSignaling();
    await expect
      .poll(() => ann.harness((h) => h.epoch()), { timeout: 60_000 })
      .toBe((before.epoch ?? 1) + 1);
    await expect.poll(() => host.harness((h) => h.status()), { timeout: 60_000 }).toBe("joined");
    const after = await ann.harness((h) => ({
      roster: h
        .view()
        .roster.map((r) => r.participant_id)
        .sort(),
      tracks: h
        .view()
        .tracks.map((t) => t.track_id)
        .sort(),
      lastSnapshot: h.snapshots.at(-1)?.kind,
    }));
    expect(after.lastSnapshot).toBe("resync");
    expect(after.roster).toEqual(before.roster);
    expect(after.tracks).toEqual(before.tracks);
    await expect.poll(() => ann.framesAdvancing(hostCam!), { timeout: 30_000 }).toBe(true);
    await expect(host.page.getByTestId("counter-epoch")).toHaveText(
      String((before.epoch ?? 1) + 1),
    );
  } finally {
    for (const c of contexts) await c.close();
  }
});
