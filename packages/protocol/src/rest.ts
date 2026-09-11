import { z } from "zod";
import { RoleSchema } from "./roles";

const isoDate = z.iso.datetime({ offset: true });

export const MeetingStatusSchema = z.enum(["scheduled", "live", "ended", "cancelled"]);
export type MeetingStatus = z.infer<typeof MeetingStatusSchema>;

export const MeetingSettingsSchema = z.object({
  lobby: z.boolean().default(true),
  max_participants: z.number().int().min(2).max(500).default(500),
});
export type MeetingSettings = z.infer<typeof MeetingSettingsSchema>;
export const DEFAULT_MEETING_SETTINGS: MeetingSettings = MeetingSettingsSchema.parse({});

const title = z.string().trim().min(1).max(200);

// zod 4's `.partial()` keeps `.default()` values, so a PATCH with `{ lobby: false }` would
// silently reset `max_participants`; this schema has no defaults.
const MeetingSettingsPartial = z.object({
  lobby: z.boolean().optional(),
  max_participants: z.number().int().min(2).max(500).optional(),
});

export const CreateMeetingRequestSchema = z.object({
  title: title.optional(),
  scheduled_start: isoDate.optional(),
  scheduled_end: isoDate.optional(),
  settings: MeetingSettingsPartial.optional(),
});
export type CreateMeetingRequest = z.infer<typeof CreateMeetingRequestSchema>;

export const UpdateMeetingRequestSchema = z.object({
  title: title.nullable().optional(),
  scheduled_start: isoDate.nullable().optional(),
  scheduled_end: isoDate.nullable().optional(),
  settings: MeetingSettingsPartial.optional(),
});
export type UpdateMeetingRequest = z.infer<typeof UpdateMeetingRequestSchema>;

export const MeetingResponseSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  org_id: z.uuid(),
  organizer_id: z.uuid(),
  title: z.string().nullable(),
  scheduled_start: isoDate.nullable(),
  scheduled_end: isoDate.nullable(),
  region: z.string(),
  settings: MeetingSettingsSchema,
  status: MeetingStatusSchema,
  created_at: isoDate,
  ended_at: isoDate.nullable(),
});
export type MeetingResponse = z.infer<typeof MeetingResponseSchema>;

export const EndMeetingResponseSchema = z.object({ session_id: z.uuid() });

export const IdParamsSchema = z.object({ id: z.uuid() });

export const MeResponseSchema = z.object({ id: z.uuid(), org_id: z.uuid(), name: z.string() });

export const JoinRequestSchema = z.object({
  code: z.string().min(1).max(32),
  display_name: z.string().trim().min(1).max(80),
  client_caps: z
    .object({
      simulcast: z.boolean().default(true),
      av1: z.boolean().default(false),
    })
    .prefault({}),
});
export type JoinRequest = z.infer<typeof JoinRequestSchema>;

export const IceServerSchema = z.object({
  urls: z.union([z.string(), z.array(z.string())]),
  username: z.string().optional(),
  credential: z.string().optional(),
});
export type IceServer = z.infer<typeof IceServerSchema>;

export const JoinResponseSchema = z.object({
  session_id: z.uuid(),
  participant_id: z.uuid(),
  role: RoleSchema,
  lobby: z.boolean(),
  signaling_url: z.string(),
  signaling_token: z.string(),
  ice_servers: z.array(IceServerSchema),
  region: z.string(),
});
export type JoinResponse = z.infer<typeof JoinResponseSchema>;
