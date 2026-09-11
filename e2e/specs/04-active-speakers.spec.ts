import { expect, test } from "../src/fixtures";
import { openGallery } from "../src/gallery";

test("active speakers follow the tone and clear when everyone mutes", async ({ browser, api }) => {
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
    const ids = [await host.participantId(), await ann.participantId()];
    const speaking = await host.waitEvent(
      "active_speakers",
      (e) => e.type === "active_speakers" && e.payload.participant_ids.length > 0,
      30_000,
    );
    if (speaking.type !== "active_speakers") throw new Error("unreachable");
    for (const id of speaking.payload.participant_ids) expect(ids).toContain(id);
    await expect(host.page.locator('.monitor[data-speaking="true"]').first()).toBeVisible();

    await host.click("mic");
    await ann.click("mic");
    await host.waitEvent(
      "active_speakers",
      (e) => e.type === "active_speakers" && e.payload.participant_ids.length === 0,
      30_000,
    );
    await expect(host.page.locator('.monitor[data-speaking="true"]')).toHaveCount(0);
  } finally {
    for (const c of contexts) await c.close();
  }
});
