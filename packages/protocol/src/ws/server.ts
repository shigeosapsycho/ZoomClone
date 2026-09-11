import { z } from "zod";
import { RoleSchema } from "../roles";
import {
  LobbyEntrySchema,
  MediaParamsSchema,
  ParticipantIdSchema,
  RoomMetaSchema,
  RosterEntrySchema,
  TrackIdSchema,
  TrackInfoSchema,
  WsErrorCodeSchema,
} from "./common";

const isoDate = z.iso.datetime({ offset: true });

/** Full snapshot. state "lobby" carries only the ids; hosts also receive the lobby list. */
export const WelcomeSchema = z.object({
  participant_id: ParticipantIdSchema,
  role: RoleSchema,
  epoch: z.number().int().positive(),
  seq: z.number().int().nonnegative(),
  state: z.enum(["joined", "lobby"]),
  roster: z.array(RosterEntrySchema).optional(),
  tracks: z.array(TrackInfoSchema).optional(),
  lobby: z.array(LobbyEntrySchema).optional(),
  room_meta: RoomMetaSchema.optional(),
  media: MediaParamsSchema.optional(),
});
export type Welcome = z.infer<typeof WelcomeSchema>;

function event<T extends string, P extends z.ZodType>(type: T, payload: P) {
  return z.object({ type: z.literal(type), seq: z.number().int().positive(), payload });
}

function snapshot<T extends string>(type: T) {
  return z.object({ type: z.literal(type), payload: WelcomeSchema });
}

export const ServerMessageSchema = z.discriminatedUnion("type", [
  snapshot("welcome"),
  snapshot("resync"),
  z.object({ type: z.literal("ack"), id: z.string(), payload: z.record(z.string(), z.unknown()) }),
  z.object({
    type: z.literal("error"),
    id: z.string().optional(),
    payload: z.object({ code: WsErrorCodeSchema, message: z.string() }),
  }),
  z.object({ type: z.literal("pong"), payload: z.object({ ts: z.number() }) }),
  event("participant.joined", z.object({ participant: RosterEntrySchema })),
  event("participant.left", z.object({ participant_id: ParticipantIdSchema, reason: z.string() })),
  event(
    "participant.updated",
    z.object({
      participant_id: ParticipantIdSchema,
      patch: RosterEntrySchema.pick({
        name: true,
        role: true,
        muted: true,
        video_off: true,
        hand: true,
        connected: true,
      }).partial(),
    }),
  ),
  event("track.added", z.object({ track: TrackInfoSchema })),
  event("track.removed", z.object({ track_id: TrackIdSchema })),
  event(
    "track.updated",
    z.object({
      track_id: TrackIdSchema,
      patch: z.object({
        paused: z.boolean().optional(),
        layers: z.number().int().min(0).optional(),
      }),
    }),
  ),
  event("active_speakers", z.object({ participant_ids: z.array(ParticipantIdSchema) })),
  event("lobby.request", z.object({ participant_id: ParticipantIdSchema, name: z.string() })),
  event("lobby.result", z.object({ admitted: z.boolean() })),
  event(
    "chat",
    z.object({
      from: ParticipantIdSchema,
      to: ParticipantIdSchema.optional(),
      body: z.string(),
      sent_at: isoDate,
    }),
  ),
  event("reaction", z.object({ from: ParticipantIdSchema, emoji: z.string() })),
  event("hand", z.object({ participant_id: ParticipantIdSchema, raised: z.boolean() })),
  event(
    "room.updated",
    z.object({ locked: z.boolean().optional(), recording: z.boolean().optional() }),
  ),
  event("room.ended", z.object({ reason: z.string() })),
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
export type ServerMessageType = ServerMessage["type"];
/** Room events: everything with a seq (replayable from the ring buffer). */
export type RoomEvent = Extract<ServerMessage, { seq: number }>;
