import { describe, expect, it } from "vitest";
import { SignalingClaimsSchema } from "./claims";
import {
  CreateMeetingRequestSchema,
  DEFAULT_MEETING_SETTINGS,
  JoinRequestSchema,
  JoinResponseSchema,
  MeetingResponseSchema,
  MeetingSettingsSchema,
  UpdateMeetingRequestSchema,
} from "./rest";

describe("MeetingSettingsSchema", () => {
  it("fills defaults: lobby on, 500 participants", () => {
    expect(MeetingSettingsSchema.parse({})).toEqual({ lobby: true, max_participants: 500 });
    expect(DEFAULT_MEETING_SETTINGS).toEqual({ lobby: true, max_participants: 500 });
  });

  it("caps max_participants at 500 and floors at 2", () => {
    expect(MeetingSettingsSchema.safeParse({ max_participants: 501 }).success).toBe(false);
    expect(MeetingSettingsSchema.safeParse({ max_participants: 1 }).success).toBe(false);
  });
});

describe("CreateMeetingRequestSchema", () => {
  it("accepts an empty body and ISO datetimes with offsets", () => {
    expect(CreateMeetingRequestSchema.parse({})).toEqual({});
    const parsed = CreateMeetingRequestSchema.parse({
      title: "  Standup ",
      scheduled_start: "2026-09-10T09:00:00Z",
      scheduled_end: "2026-09-10T09:30:00+02:00",
      settings: { lobby: false },
    });
    expect(parsed.title).toBe("Standup");
    expect(parsed.settings).toEqual({ lobby: false });
  });

  it("rejects non-ISO datetimes and empty titles", () => {
    expect(CreateMeetingRequestSchema.safeParse({ scheduled_start: "tomorrow" }).success).toBe(
      false,
    );
    expect(CreateMeetingRequestSchema.safeParse({ title: "   " }).success).toBe(false);
  });

  it("update allows explicit nulls", () => {
    expect(UpdateMeetingRequestSchema.parse({ title: null, scheduled_start: null })).toEqual({
      title: null,
      scheduled_start: null,
    });
  });
});

describe("JoinRequestSchema", () => {
  it("defaults client_caps", () => {
    const parsed = JoinRequestSchema.parse({ code: "abc-defg-hij", display_name: "Ana" });
    expect(parsed.client_caps).toEqual({ simulcast: true, av1: false });
  });

  it("requires a display name", () => {
    expect(JoinRequestSchema.safeParse({ code: "abc-defg-hij", display_name: " " }).success).toBe(
      false,
    );
  });
});

describe("response schemas", () => {
  it("MeetingResponseSchema accepts ISO strings with Z and nullable fields", () => {
    const ok = MeetingResponseSchema.safeParse({
      id: "2f6a2b6e-6f0b-4c1e-9a52-0c5d3f1a9b11",
      code: "abc-defg-hij",
      org_id: "2f6a2b6e-6f0b-4c1e-9a52-0c5d3f1a9b12",
      organizer_id: "2f6a2b6e-6f0b-4c1e-9a52-0c5d3f1a9b13",
      title: null,
      scheduled_start: null,
      scheduled_end: null,
      region: "local",
      settings: { lobby: true, max_participants: 500 },
      status: "scheduled",
      created_at: "2026-09-10T09:00:00.000Z",
      ended_at: null,
    });
    expect(ok.success).toBe(true);
  });

  it("JoinResponseSchema matches spec 5.1", () => {
    const ok = JoinResponseSchema.safeParse({
      session_id: "2f6a2b6e-6f0b-4c1e-9a52-0c5d3f1a9b11",
      participant_id: "2f6a2b6e-6f0b-4c1e-9a52-0c5d3f1a9b12",
      role: "attendee",
      lobby: false,
      signaling_url: "wss://sig.example.com/rooms/2f6a2b6e-6f0b-4c1e-9a52-0c5d3f1a9b11",
      signaling_token: "x.y.z",
      ice_servers: [
        { urls: "stun:stun.example.com:3478" },
        { urls: ["turn:turn.example.com:443?transport=tcp"], username: "u", credential: "c" },
      ],
      region: "us-west-2",
    });
    expect(ok.success).toBe(true);
  });
});

describe("SignalingClaimsSchema", () => {
  it("requires the spec claims plus room settings", () => {
    const ok = SignalingClaimsSchema.safeParse({
      session_id: "2f6a2b6e-6f0b-4c1e-9a52-0c5d3f1a9b11",
      participant_id: "2f6a2b6e-6f0b-4c1e-9a52-0c5d3f1a9b12",
      role: "host",
      sfu_hint: "sfu-local-1",
      display_name: "Ana",
      lobby_enabled: true,
      max_participants: 500,
    });
    expect(ok.success).toBe(true);
    expect(SignalingClaimsSchema.safeParse({ role: "admin" }).success).toBe(false);
  });
});
