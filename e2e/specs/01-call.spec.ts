import { expect, test } from "../src/fixtures";
import { openGallery } from "../src/gallery";

test("three participants see and hear each other", async ({ browser, api }) => {
  const token = await api.hostToken();
  const meeting = await api.createMeeting(token, { lobby: false });
  const contexts = await Promise.all([
    browser.newContext(),
    browser.newContext(),
    browser.newContext(),
  ]);
  try {
    const [host, ann, bob] = await Promise.all([
      openGallery(contexts[0]!, { code: meeting.code, name: "Host", token }),
      openGallery(contexts[1]!, { code: meeting.code, name: "Ann" }),
      openGallery(contexts[2]!, { code: meeting.code, name: "Bob" }),
    ]);
    for (const g of [host, ann, bob]) await g.waitJoined();
    for (const g of [host, ann, bob]) {
      await expect.poll(() => g.remoteTracks("video"), { timeout: 30_000 }).toHaveLength(2);
      await expect.poll(() => g.remoteTracks("audio"), { timeout: 30_000 }).toHaveLength(2);
      for (const trackId of await g.remoteTracks("video")) {
        await expect.poll(() => g.framesAdvancing(trackId), { timeout: 30_000 }).toBe(true);
      }
      for (const trackId of await g.remoteTracks("audio")) {
        await expect.poll(() => g.packetsDelta(trackId), { timeout: 30_000 }).toBeGreaterThan(0);
      }
      await expect(g.page.locator(".monitor")).toHaveCount(3);
    }
  } finally {
    for (const c of contexts) await c.close();
  }
});
