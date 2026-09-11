import { expect, test } from "../src/fixtures";
import { helloCloseCode, openGallery } from "../src/gallery";

test("host mute, remove, lock and end", async ({ browser, api, services }) => {
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
    const annId = await ann.participantId();
    // Bob's copy of Ann's track arrives by fanout, a beat after his own welcome.
    const bobAudioTracks = () =>
      bob.harness((h) => h.view().tracks.filter((t) => t.kind === "audio"));
    await expect
      .poll(async () => (await bobAudioTracks()).some((t) => t.owner === annId), {
        timeout: 30_000,
      })
      .toBe(true);
    const annAudio = (await bobAudioTracks()).find((t) => t.owner === annId)!.track_id;
    await expect.poll(() => bob.packetsDelta(annAudio), { timeout: 30_000 }).toBeGreaterThan(0);

    // mute: Ann's mic goes quiet for Bob and her tile says so
    await host.click(`mute-${annId}`);
    await expect(ann.page.getByTestId("mic")).toHaveText("mic off");
    await expect.poll(() => bob.packetsDelta(annAudio, 2_000), { timeout: 30_000 }).toBe(0);

    // remove: Ann is closed 4002 and a fresh hello with her token is refused the same way
    const annToken = await ann.token();
    await host.click(`remove-${annId}`);
    await ann.waitClosed(4002);
    await expect(ann.page.getByTestId("error")).toContainText("removed you");
    const sessionId = (await host.harness((h) => h.sessionId()))!;
    const roomUrl = `${services.urls.signaling.replace("http", "ws")}/rooms/${sessionId}`;
    expect(await helloCloseCode(roomUrl, annToken)).toBe(4002);
    await expect(host.page.getByTestId(`roster-${annId}`)).toHaveCount(0);

    // lock: /join refuses newcomers, a token minted before the lock is refused at hello with 4009
    const early = await api.join(meeting.code, "Early");
    await host.click("lock");
    await expect(host.page.getByTestId("lock")).toHaveText("unlock room");
    // /join reads the lock from the Redis checkpoint, which lands a window (50 ms) after the
    // room.updated event; wait for it there rather than retrying /join, which is rate limited
    // per code and this scenario spends exactly its budget of six.
    await expect.poll(() => api.roomLocked(sessionId), { timeout: 5_000 }).toBe(true);
    expect(await api.joinError(meeting.code, "Late")).toMatchObject({
      status: 403,
      code: "LOCKED",
    });
    expect(await helloCloseCode(early.signaling_url, early.signaling_token)).toBe(4009);

    // end: everyone sees the room end, the session is closed in Postgres, /join answers 410
    await host.click("end");
    await host.waitEnded();
    await bob.waitEnded();
    await expect.poll(() => api.sessionEnded(sessionId), { timeout: 20_000 }).toBe(true);
    expect((await api.joinError(meeting.code, "Later")).status).toBe(410);
  } finally {
    for (const c of contexts) await c.close();
  }
});
