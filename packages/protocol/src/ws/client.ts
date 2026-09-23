import { z } from "zod";
import {
  MAX_CHAT_BYTES,
  MediaKindSchema,
  MediaSourceSchema,
  OpaqueSchema,
  ParticipantIdSchema,
  SubscriptionPrefSchema,
  TrackIdSchema,
} from "./common";

const encoder = new TextEncoder();

function request<T extends string, P extends z.ZodType>(type: T, payload: P) {
  return z.object({ type: z.literal(type), id: z.string().min(1).max(64), payload });
}

const transportSchema = z.enum(["send", "recv"]);
const targetSchema = z.object({ participant_id: ParticipantIdSchema });

/** Client to server messages (spec 5.2, mediasoup payloads). Every request carries an id. */
export const ClientMessageSchema = z.discriminatedUnion("type", [
  request(
    "hello",
    z.object({
      token: z.string().min(1),
      resume_seq: z.number().int().nonnegative().optional(),
      epoch: z.number().int().positive().optional(),
    }),
  ),
  request(
    "connect_transport",
    z.object({ transport: transportSchema, dtls_parameters: OpaqueSchema }),
  ),
  request(
    "publish",
    z.object({
      kind: MediaKindSchema,
      source: MediaSourceSchema,
      rtp_parameters: OpaqueSchema,
      paused: z.boolean().default(false),
    }),
  ),
  request("unpublish", z.object({ track_id: TrackIdSchema })),
  request(
    "subscribe",
    z.object({
      rtp_capabilities: OpaqueSchema.optional(),
      track_ids: z.array(TrackIdSchema).max(500),
      prefs: z.record(TrackIdSchema, SubscriptionPrefSchema).default({}),
    }),
  ),
  request("consumer_ready", z.object({ track_id: TrackIdSchema })),
  request(
    "set_media_state",
    z.object({ muted: z.boolean().optional(), video_off: z.boolean().optional() }),
  ),
  request("raise_hand", z.object({})),
  request("lower_hand", z.object({})),
  request("reaction", z.object({ emoji: z.string().min(1).max(16) })),
  request(
    "chat",
    z.object({
      body: z
        .string()
        .min(1)
        .refine((s) => encoder.encode(s).length <= MAX_CHAT_BYTES, "chat body over 4 KB"),
      to: ParticipantIdSchema.optional(),
    }),
  ),
  request("host.admit", targetSchema),
  request("host.deny", targetSchema),
  request("host.mute", targetSchema),
  request("host.remove", targetSchema),
  request("host.lock", z.object({ locked: z.boolean() })),
  request("host.end", z.object({})),
  request("restart_ice", z.object({ transport: transportSchema })),
  request("ping", z.object({ ts: z.number() })),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export type ClientMessageType = ClientMessage["type"];
