import { Code, ConnectError } from "@connectrpc/connect";
import type { MediaKind, MediaSource } from "@zoomclone/protocol";
import { MediaKind as PbKind, MediaSource as PbSource } from "@zoomclone/sfu-proto";

/** A blob from the SFU that is not the JSON shape the contract promises. */
export class SfuPayloadError extends Error {
  constructor(what: string) {
    super(`SFU returned malformed ${what}`);
    this.name = "SfuPayloadError";
  }
}

export function parseObject(json: string, what: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new SfuPayloadError(what);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SfuPayloadError(what);
  }
  return value as Record<string, unknown>;
}

export function parseArray(json: string, what: string): Record<string, unknown>[] {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new SfuPayloadError(what);
  }
  if (!Array.isArray(value)) throw new SfuPayloadError(what);
  return value as Record<string, unknown>[];
}

export function kindToPb(kind: MediaKind): PbKind {
  return kind === "audio" ? PbKind.AUDIO : PbKind.VIDEO;
}

export function kindFromPb(kind: PbKind): MediaKind {
  if (kind === PbKind.AUDIO) return "audio";
  if (kind === PbKind.VIDEO) return "video";
  throw new SfuPayloadError("media kind");
}

const SOURCE_TO_PB: Record<MediaSource, PbSource> = {
  mic: PbSource.MIC,
  camera: PbSource.CAMERA,
  screen: PbSource.SCREEN,
  screen_audio: PbSource.SCREEN_AUDIO,
};

export function sourceToPb(source: MediaSource): PbSource {
  return SOURCE_TO_PB[source];
}

export function sourceFromPb(source: PbSource): MediaSource {
  for (const [name, value] of Object.entries(SOURCE_TO_PB)) {
    if (value === source) return name as MediaSource;
  }
  throw new SfuPayloadError("media source");
}

export function isNotFound(error: unknown): boolean {
  return error instanceof ConnectError && error.code === Code.NotFound;
}

/** Short human-readable form for error frames and logs. */
export function describeSfuError(error: unknown): string {
  if (error instanceof ConnectError) return `${Code[error.code]}: ${error.rawMessage}`;
  if (error instanceof Error) return error.message;
  return String(error);
}
