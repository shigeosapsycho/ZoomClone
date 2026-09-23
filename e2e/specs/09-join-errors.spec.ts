import { expect, test } from "../src/fixtures";

test("join answers 404, 410 and 429 the way the spec says", async ({ api }) => {
  expect(await api.joinError("zzz-zzzz-zzz", "Nobody")).toMatchObject({
    status: 404,
    code: "MEETING_NOT_FOUND",
  });

  const token = await api.hostToken();
  const ended = await api.createMeeting(token, { lobby: false });
  await api.join(ended.code, "Host", token);
  expect(await api.endMeeting(token, ended.id)).toBe(200);
  expect(await api.joinError(ended.code, "Late")).toMatchObject({ status: 410, code: "ENDED" });

  const busy = await api.createMeeting(token, { lobby: false });
  for (let i = 0; i < 6; i++) await api.join(busy.code, `Guest ${i}`);
  expect(await api.joinError(busy.code, "Guest 7")).toMatchObject({
    status: 429,
    code: "RATE_LIMITED",
  });
});
