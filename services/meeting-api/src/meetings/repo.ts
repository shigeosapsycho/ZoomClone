import type { Db, MeetingRow, SessionRow } from "@zoomclone/db";
import type { MeetingSettings, MeetingStatus } from "@zoomclone/protocol";

export type NewMeeting = Omit<MeetingRow, "createdAt" | "endedAt">;

export type MeetingPatch = {
  title: string | null;
  scheduledStart: Date | null;
  scheduledEnd: Date | null;
  settings: MeetingSettings;
};

export function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "23505";
}

export class MeetingsRepo {
  constructor(private readonly db: Db) {}

  async insert(m: NewMeeting): Promise<MeetingRow> {
    const [row] = await this.db<MeetingRow[]>`
      INSERT INTO meetings (id, code, org_id, organizer_id, title, scheduled_start, scheduled_end,
                            region, settings, status)
      VALUES (${m.id}, ${m.code}, ${m.orgId}, ${m.organizerId}, ${m.title}, ${m.scheduledStart},
              ${m.scheduledEnd}, ${m.region}, ${this.db.json(m.settings)}, ${m.status})
      RETURNING *`;
    return row as MeetingRow;
  }

  async byId(id: string): Promise<MeetingRow | null> {
    const [row] = await this.db<MeetingRow[]>`SELECT * FROM meetings WHERE id = ${id}`;
    return row ?? null;
  }

  async byCode(code: string): Promise<MeetingRow | null> {
    const [row] = await this.db<MeetingRow[]>`SELECT * FROM meetings WHERE code = ${code}`;
    return row ?? null;
  }

  async update(id: string, patch: MeetingPatch): Promise<MeetingRow | null> {
    const [row] = await this.db<MeetingRow[]>`
      UPDATE meetings
      SET title = ${patch.title}, scheduled_start = ${patch.scheduledStart},
          scheduled_end = ${patch.scheduledEnd}, settings = ${this.db.json(patch.settings)}
      WHERE id = ${id}
      RETURNING *`;
    return row ?? null;
  }

  async setStatus(id: string, status: MeetingStatus): Promise<void> {
    await this.db`UPDATE meetings SET status = ${status} WHERE id = ${id}`;
  }

  async liveSession(meetingId: string): Promise<SessionRow | null> {
    const [row] = await this.db<SessionRow[]>`
      SELECT * FROM meeting_sessions WHERE meeting_id = ${meetingId} AND ended_at IS NULL`;
    return row ?? null;
  }
}
