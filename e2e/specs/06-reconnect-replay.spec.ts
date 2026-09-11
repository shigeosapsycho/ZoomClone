import { expect, test } from "../src/fixtures";
import { openGallery } from "../src/gallery";

test("a dropped socket comes back with a replay and the video keeps flowing", async ({
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
    const snapshotsBefore = await ann.harness((h) => h.snapshots.length);

    await ann.harness((h) => h.dropSocket());
    await host.page.getByTestId("chat-input").fill("still here?");
    await host.click("chat-send");
    await ann.waitEvent(
      "chat",
      (e) => e.type === "chat" && e.payload.body === "still here?",
      30_000,
    );
    await expect
      .poll(() => ann.harness((h) => h.lastAck()?.mode), { timeout: 30_000 })
      .toBe("replay");
    expect(await ann.harness((h) => h.snapshots.length)).toBe(snapshotsBefore);
    expect(await ann.harness((h) => h.closes.some((c) => c.code === 4900 && !c.terminal))).toBe(
      true,
    );
    await expect.poll(() => ann.framesAdvancing(hostCam!), { timeout: 30_000 }).toBe(true);
    await expect(ann.page.getByTestId("air-status")).toContainText("on air");
  } finally {
    for (const c of contexts) await c.close();
  }
});
