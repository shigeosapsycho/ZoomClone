import { randomUUID } from "node:crypto";
import { endSession, type Db, type MeetingRow } from "@zoomclone/db";
import {
  ApiError,
  MeetingSettingsSchema,
  generateMeetingCode,
  type CodeRng,
  type CreateMeetingRequest,
  type UpdateMeetingRequest,
} from "@zoomclone/protocol";
import type { AuthUser } from "../auth/user-verifier";
import type { RoomControl } from "../room-control";
import { isUniqueViolation, MeetingsRepo } from "./repo";

const CODE_ATTEMPTS = 5;

export class MeetingsService {
  constructor(
    private readonly deps: {
      db: Db;
      repo: MeetingsRepo;
      roomControl: RoomControl;
      region: string;
      codeRng?: CodeRng;
    },
  ) {}

  async create(user: AuthUser, input: CreateMeetingRequest): Promise<MeetingRow> {
    const settings = MeetingSettingsSchema.parse(input.settings ?? {});
    const scheduledStart = input.scheduled_start ? new Date(input.scheduled_start) : null;
    const scheduledEnd = input.scheduled_end ? new Date(input.scheduled_end) : null;
    assertWindow(scheduledStart, scheduledEnd);
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.deps.repo.insert({
          id: randomUUID(),
          code: generateMeetingCode(this.deps.codeRng),
          orgId: user.orgId,
          organizerId: user.id,
          title: input.title ?? null,
          scheduledStart,
          scheduledEnd,
          region: this.deps.region,
          settings,
          status: "scheduled",
        });
      } catch (err) {
        if (!isUniqueViolation(err) || attempt >= CODE_ATTEMPTS) throw err;
      }
    }
  }

  /** Org-scoped read: meetings of other orgs look like they do not exist. */
  async get(user: AuthUser, id: string): Promise<MeetingRow> {
    const meeting = await this.deps.repo.byId(id);
    if (!meeting || meeting.orgId !== user.orgId) {
      throw new ApiError("MEETING_NOT_FOUND", "meeting not found");
    }
    return meeting;
  }

  async update(user: AuthUser, id: string, input: UpdateMeetingRequest): Promise<MeetingRow> {
    const current = await this.organizerOnly(user, id);
    const settings = MeetingSettingsSchema.parse({
      ...current.settings,
      ...(input.settings ?? {}),
    });
    const scheduledStart = resolveDate(input.scheduled_start, current.scheduledStart);
    const scheduledEnd = resolveDate(input.scheduled_end, current.scheduledEnd);
    assertWindow(scheduledStart, scheduledEnd);
    const title = input.title === undefined ? current.title : input.title;
    const updated = await this.deps.repo.update(id, {
      title,
      scheduledStart,
      scheduledEnd,
      settings,
    });
    if (!updated) throw new ApiError("MEETING_NOT_FOUND", "meeting not found");
    return updated;
  }

  async cancel(user: AuthUser, id: string): Promise<void> {
    const meeting = await this.organizerOnly(user, id);
    if (meeting.status === "live" || (await this.deps.repo.liveSession(id))) {
      throw new ApiError("CONFLICT", "meeting is live; end it first");
    }
    if (meeting.status === "ended") throw new ApiError("ENDED", "meeting has ended");
    await this.deps.repo.setStatus(id, "cancelled");
  }

  /** Spec 5.1 "Host ends for all". Writes Postgres first so it works with no controller alive. */
  async end(user: AuthUser, id: string): Promise<{ sessionId: string }> {
    await this.organizerOnly(user, id);
    const session = await this.deps.repo.liveSession(id);
    if (!session) throw new ApiError("NOT_LIVE", "meeting is not live");
    await endSession(this.deps.db, { sessionId: session.id, reason: "api_end" });
    await this.deps.roomControl.publishEnd(session.id, "api_end");
    return { sessionId: session.id };
  }

  private async organizerOnly(user: AuthUser, id: string): Promise<MeetingRow> {
    const meeting = await this.get(user, id);
    if (meeting.organizerId !== user.id) throw new ApiError("FORBIDDEN", "organizer only");
    return meeting;
  }
}

function resolveDate(input: string | null | undefined, current: Date | null): Date | null {
  if (input === undefined) return current;
  return input === null ? null : new Date(input);
}

function assertWindow(start: Date | null, end: Date | null): void {
  if (start && end && end.getTime() <= start.getTime()) {
    throw new ApiError("VALIDATION", "scheduled_end must be after scheduled_start");
  }
}
