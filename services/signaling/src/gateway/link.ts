import type { ServerMessage } from "@zoomclone/protocol";

/**
 * The controller's view of one socket (design doc: the seam for the later gateway split).
 * send never throws and drops frames once the socket is gone; close is idempotent.
 */
export interface ParticipantLink {
  readonly id: string;
  send(message: ServerMessage): void;
  close(code: number, reason?: string): void;
}
