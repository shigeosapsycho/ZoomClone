import { expect, test } from "../src/fixtures";
import { openGallery } from "../src/gallery";

test("guests wait in the green room until the host lets them in or turns them away", async ({
  browser,
  api,
}) => {
  const token = await api.hostToken();
  const meeting = await api.createMeeting(token, { lobby: true });
  const contexts = await Promise.all([
    browser.newContext(),
    browser.newContext(),
    browser.newContext(),
  ]);
  try {
    const ann = await openGallery(contexts[1]!, { code: meeting.code, name: "Ann" });
    await ann.waitWaiting();
    const host = await openGallery(contexts[0]!, { code: meeting.code, name: "Host", token });
    await host.waitJoined();
    const annId = await ann.participantId();
    await expect(host.page.getByTestId(`waiter-${annId}`)).toBeVisible();
    await host.click(`admit-${annId}`);
    await ann.waitJoined();
    await expect(host.page.getByTestId(`roster-${annId}`)).toBeVisible();
    await expect.poll(() => ann.remoteTracks("video"), { timeout: 30_000 }).toHaveLength(1);

    const bob = await openGallery(contexts[2]!, { code: meeting.code, name: "Bob" });
    await bob.waitWaiting();
    const bobId = await bob.participantId();
    await host.click(`deny-${bobId}`);
    await bob.waitClosed(4003);
    await expect(bob.page.getByTestId("error")).toContainText("did not let you in");
    await expect(host.page.getByTestId(`waiter-${bobId}`)).toHaveCount(0);
  } finally {
    for (const c of contexts) await c.close();
  }
});
