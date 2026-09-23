/** WebSocket close codes used by the signaling gateway (design doc, Contracts). */
export const CloseCode = {
  PING_TIMEOUT: 4000,
  AUTH_FAILED: 4001,
  REMOVED: 4002,
  LOBBY_DENIED: 4003,
  ROOM_ENDED: 4004,
  REPLACED: 4005,
  PROTOCOL_ERROR: 4006,
  CAPACITY: 4007,
  REJOIN_REQUIRED: 4008,
  LOCKED: 4009,
} as const;
export type CloseCode = (typeof CloseCode)[keyof typeof CloseCode];

export const PING_INTERVAL_MS = 10_000;
export const MISSED_PINGS_TO_CLOSE = 3;
