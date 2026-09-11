import { z } from "zod";
import { RoleSchema } from "../roles";

const isoDate = z.iso.datetime({ offset: true });

export const ParticipantIdSchema = z.uuid();
export const TrackIdSchema = z.string().min(1).max(64);
/** mediasoup parameter blobs travel opaque; the SFU validates them. */
export const OpaqueSchema = z.record(z.string(), z.unknown());

export const MediaKindSchema = z.enum(["audio", "video"]);
export type MediaKind = z.infer<typeof MediaKindSchema>;
export const MediaSourceSchema = z.enum(["mic", "camera", "screen", "screen_audio"]);
export type MediaSource = z.infer<typeof MediaSourceSchema>;

export const MAX_CHAT_BYTES = 4096;
export const REACTION_RATE_PER_SECOND = 2;

export const RosterEntrySchema = z.object({
  participant_id: ParticipantIdSchema,
  name: z.string(),
  role: RoleSchema,
  muted: z.boolean(),
  video_off: z.boolean(),
  hand: z.boolean(),
  connected: z.boolean(),
  joined_at: isoDate,
});
export type RosterEntry = z.infer<typeof RosterEntrySchema>;

export const TrackInfoSchema = z.object({
  track_id: TrackIdSchema,
  owner: ParticipantIdSchema,
  kind: MediaKindSchema,
  source: MediaSourceSchema,
  paused: z.boolean(),
  layers: z.number().int().min(0),
});
export type TrackInfo = z.infer<typeof TrackInfoSchema>;

export const LobbyEntrySchema = z.object({
  participant_id: ParticipantIdSchema,
  name: z.string(),
  requested_at: isoDate,
});
export type LobbyEntry = z.infer<typeof LobbyEntrySchema>;

export const RoomMetaSchema = z.object({
  session_id: z.uuid(),
  locked: z.boolean(),
  lobby_enabled: z.boolean(),
  recording: z.boolean(),
  host_ids: z.array(ParticipantIdSchema),
  max_participants: z.number().int(),
});
export type RoomMeta = z.infer<typeof RoomMetaSchema>;

export const TransportParamsSchema = z.object({
  id: z.string(),
  ice_parameters: OpaqueSchema,
  ice_candidates: z.array(OpaqueSchema),
  dtls_parameters: OpaqueSchema,
});
export type TransportParams = z.infer<typeof TransportParamsSchema>;

export const MediaParamsSchema = z.object({
  rtp_capabilities: OpaqueSchema,
  send_transport: TransportParamsSchema,
  recv_transport: TransportParamsSchema,
});
export type MediaParams = z.infer<typeof MediaParamsSchema>;

export const SubscriptionPrefSchema = z.object({
  max_layer: z.number().int().min(0).max(2).optional(),
  priority: z.number().int().min(1).max(255).optional(),
  paused: z.boolean().optional(),
});
export type SubscriptionPref = z.infer<typeof SubscriptionPrefSchema>;

export const ConsumerParamsSchema = z.object({
  track_id: TrackIdSchema,
  consumer_id: z.string(),
  kind: MediaKindSchema,
  rtp_parameters: OpaqueSchema,
  producer_paused: z.boolean(),
});
export type ConsumerParams = z.infer<typeof ConsumerParamsSchema>;

export const PublishAckSchema = z.object({ track_id: TrackIdSchema });
export const SubscribeAckSchema = z.object({
  consumers: z.array(ConsumerParamsSchema),
  removed: z.array(TrackIdSchema),
});

export const WsErrorCodeSchema = z.enum([
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "INVALID",
  "RATE_LIMITED",
  "CAPACITY",
  "LOCKED",
  "NOT_IMPLEMENTED",
  "CONTROLLER_BUSY",
  "SFU_ERROR",
  "INTERNAL",
]);
export type WsErrorCode = z.infer<typeof WsErrorCodeSchema>;
