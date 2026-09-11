import { randomUUID } from "node:crypto";
import { endSession, isEndReason, type Db, type MeetingRow, type SessionRow } from "@zoomclone/db";
import {
  ApiError,
  normalizeMeetingCode,
  type JoinRequest,
  type JoinResponse,
  type Role,
} from "@zoomclone/protocol";
import { signSignalingToken, type SigningKeys } from "@zoomclone/tokens";
import type { AuthUser } from "../auth/user-verifier";
import type { Env } from "../env";
import { buildIceServers } from "../ice-servers";
import type { MeetingsRepo } from "../meetings/repo";
import type { RoomStateReader } from "../room-state";
import type { Scheduler } from "../scheduler";

export type JoinDeps = {
  db: Db;
  repo: MeetingsRepo;
  scheduler: Scheduler;
  roomState: RoomStateReader;
  keys: SigningKeys;
  env: Env;
  clock: () => Date;
};

/** Spec 5.1 POST /join, the critical path: lookup, org policy, session, token. */
export class JoinService {
  constructor(private readonly deps: JoinDeps) {}

  async join(input: JoinRequest, user: AuthUser | null): Promise<JoinResponse> {
    const { repo, env } = this.deps;
    const code = normalizeMeetingCode(input.code);
    if (!code) throw new ApiError("MEETING_NOT_FOUND", "meeting not found");
    let meeting = await repo.byCode(code);
    if (!meeting) throw new ApiError("MEETING_NOT_FOUND", "meeting not found");
    assertJoinable(meeting);
    const role: Role = user !== null && user.id === meeting.organizerId ? "host" : "attendee";

    let { session, created } = await this.getOrCreateLiveSession(meeting);
    if (!created) {
      const state = await this.deps.roomState.read(session.id);
      if (state?.status === "ended") {
        // The controller ended the room; Postgres may still be catching up. Finish it here.
        await endSession(this.deps.db, {
          sessionId: session.id,
          reason: isEndReason(state.endReason) ? state.endReason : "idle",
        });
        meeting = (await repo.byId(meeting.id)) ?? meeting;
        assertJoinable(meeting);
        ({ session, created } = await this.getOrCreateLiveSession(meeting));
      } else if (state) {
        if (state.locked && role !== "host") throw new ApiError("LOCKED", "meeting is locked");
        if (state.rosterSize >= meeting.settings.max_participants) {
          throw new ApiError("CAPACITY", "meeting is full");
        }
      }
    }

    const participantId = randomUUID();
    const orgMember = user !== null && user.orgId === meeting.orgId;
    const lobby = meeting.settings.lobby && role !== "host" && !orgMember;
    const now = this.deps.clock();
    const token = await signSignalingToken(
      this.deps.keys,
      env.TOKEN_ISSUER,
      {
        session_id: session.id,
        participant_id: participantId,
        role,
        lobby,
        sfu_hint: session.homeSfuId ?? env.SFU_ID,
        display_name: input.display_name,
        lobby_enabled: meeting.settings.lobby,
        max_participants: meeting.settings.max_participants,
      },
      now,
    );
    return {
      session_id: session.id,
      participant_id: participantId,
      role,
      lobby,
      signaling_url: `${env.SIGNALING_PUBLIC_URL}/rooms/${session.id}`,
      signaling_token: token,
      ice_servers: buildIceServers(
        {
          stunUrls: env.STUN_URLS,
          turnUrls: env.TURN_URLS,
          turnSecret: env.TURN_SECRET,
          turnTtlSeconds: env.TURN_TTL_SECONDS,
        },
        participantId,
        now,
      ),
      region: meeting.region,
    };
  }

  /**
   * One transaction. The partial unique index (meeting_id WHERE ended_at IS NULL) makes the
   * insert race-safe: a losing writer gets no row back and re-reads the winner's session.
   */
  private async getOrCreateLiveSession(
    meeting: MeetingRow,
  ): Promise<{ session: SessionRow; created: boolean }> {
    return this.deps.db.begin(async (tx) => {
      const [existing] = await tx<SessionRow[]>`
        SELECT * FROM meeting_sessions WHERE meeting_id = ${meeting.id} AND ended_at IS NULL`;
      if (existing) return { session: existing, created: false };
      const placement = await this.deps.scheduler.place({
        meetingId: meeting.id,
        region: meeting.region,
        expectedSize: meeting.settings.max_participants,
      });
      const [inserted] = await tx<SessionRow[]>`
        INSERT INTO meeting_sessions (id, meeting_id, started_at, home_sfu_id)
        VALUES (${randomUUID()}, ${meeting.id}, now(), ${placement.sfuId})
        ON CONFLICT (meeting_id) WHERE ended_at IS NULL DO NOTHING
        RETURNING *`;
      if (inserted) {
        await tx`UPDATE meetings SET status = 'live' WHERE id = ${meeting.id} AND status = 'scheduled'`;
        return { session: inserted, created: true };
      }
      const [raced] = await tx<SessionRow[]>`
        SELECT * FROM meeting_sessions WHERE meeting_id = ${meeting.id} AND ended_at IS NULL`;
      if (!raced) throw new Error("live session disappeared during join");
      return { session: raced, created: false };
    });
  }
}

function assertJoinable(meeting: MeetingRow): void {
  if (meeting.status === "ended" || meeting.status === "cancelled") {
    throw new ApiError("ENDED", "meeting has ended");
  }
}
