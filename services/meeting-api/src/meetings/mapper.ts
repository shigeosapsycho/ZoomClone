import type { MeetingRow } from "@zoomclone/db";
import type { MeetingResponse } from "@zoomclone/protocol";

export function toMeetingResponse(row: MeetingRow): MeetingResponse {
  return {
    id: row.id,
    code: row.code,
    org_id: row.orgId,
    organizer_id: row.organizerId,
    title: row.title,
    scheduled_start: row.scheduledStart?.toISOString() ?? null,
    scheduled_end: row.scheduledEnd?.toISOString() ?? null,
    region: row.region,
    settings: row.settings,
    status: row.status,
    created_at: row.createdAt.toISOString(),
    ended_at: row.endedAt?.toISOString() ?? null,
  };
}
