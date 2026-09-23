import { z } from "zod";
import { RoleSchema } from "./roles";

export const SIGNALING_AUDIENCE = "signaling";
/** Spec 2.2: per-meeting tokens with 5 min TTL. */
export const SIGNALING_TOKEN_TTL_SECONDS = 300;

/**
 * Custom claims in the signaling JWT (spec 5.1: session_id, participant_id, role, sfu_hint, exp).
 * lobby_enabled and max_participants let the room controller seed room meta without a DB read.
 */
export const SignalingClaimsSchema = z.object({
  session_id: z.uuid(),
  participant_id: z.uuid(),
  role: RoleSchema,
  // The meeting API's decision for this participant (settings, role and org membership already
  // applied). lobby_enabled stays as the room-level setting the controller seeds into room meta.
  lobby: z.boolean(),
  sfu_hint: z.string().min(1),
  display_name: z.string().min(1).max(80),
  lobby_enabled: z.boolean(),
  max_participants: z.number().int().min(2).max(500),
});
export type SignalingClaims = z.infer<typeof SignalingClaimsSchema>;
