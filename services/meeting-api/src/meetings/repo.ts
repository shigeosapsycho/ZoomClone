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

/**
 * createDb's postgres.camel transform also recurses into JSONB values on the way out of
 * Postgres, so the stored snake_case settings object (max_participants) comes back with a
 * camelCased key (maxParticipants) even though nothing camelCased it going in. Undo that for
 * the one JSONB column this repo reads, so MeetingRow.settings matches its declared shape.
 */
function normalizeSettings(raw: MeetingSettings): MeetingSettings {
  const wire = raw as unknown as { lobby: boolean; maxParticipants: number };
  return { lobby: wire.lobby, max_participants: wire.maxParticipants };
}

function normalizeRow<T extends MeetingRow | undefined>(row: T): T {
  return row ? { ...row, settings: normalizeSettings(row.settings) } : row;
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
    return normalizeRow(row) as MeetingRow;
  }

  async byId(id: string): Promise<MeetingRow | null> {
    const [row] = await this.db<MeetingRow[]>`SELECT * FROM meetings WHERE id = ${id}`;
    return normalizeRow(row) ?? null;
  }

  async byCode(code: string): Promise<MeetingRow | null> {
    const [row] = await this.db<MeetingRow[]>`SELECT * FROM meetings WHERE code = ${code}`;
    return normalizeRow(row) ?? null;
  }

  async update(id: string, patch: MeetingPatch): Promise<MeetingRow | null> {
    const [row] = await this.db<MeetingRow[]>`
      UPDATE meetings
      SET title = ${patch.title}, scheduled_start = ${patch.scheduledStart},
          scheduled_end = ${patch.scheduledEnd}, settings = ${this.db.json(patch.settings)}
      WHERE id = ${id}
      RETURNING *`;
    return normalizeRow(row) ?? null;
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
