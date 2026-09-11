import { expect, test } from "../src/fixtures";
import { openGallery } from "../src/gallery";

test("an empty room ends by itself and the next join starts a new session", async ({
  browser,
  api,
}) => {
  const token = await api.hostToken();
  const meeting = await api.createMeeting(token, { lobby: false });
  const context = await browser.newContext();
  try {
    const host = await openGallery(context, { code: meeting.code, name: "Host", token });
    await host.waitJoined();
    const first = await host.harness((h) => h.sessionId());
    await host.click("leave");
    await expect(host.page.getByTestId("ended-panel")).toBeVisible();
    // grace (10 s) then idle (3 s): the controller ends the session with reason idle
    await expect.poll(() => api.sessionEnded(first!), { timeout: 40_000 }).toBe(true);
    const again = await api.join(meeting.code, "Host again", token);
    expect(again.session_id).not.toBe(first);
  } finally {
    await context.close();
  }
});
