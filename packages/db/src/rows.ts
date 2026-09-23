import type { MeetingSettings, MeetingStatus, Role } from "@zoomclone/protocol";

export type MeetingRow = {
  id: string;
  code: string;
  orgId: string;
  organizerId: string;
  title: string | null;
  scheduledStart: Date | null;
  scheduledEnd: Date | null;
  region: string;
  settings: MeetingSettings;
  status: MeetingStatus;
  createdAt: Date;
  endedAt: Date | null;
};

export type SessionRow = {
  id: string;
  meetingId: string;
  startedAt: Date;
  endedAt: Date | null;
  homeSfuId: string | null;
  peakParticipants: number | null;
};

export type ParticipantRow = {
  id: string;
  sessionId: string;
  userId: string | null;
  displayName: string;
  role: Role;
  joinedAt: Date;
  leftAt: Date | null;
  leaveReason: string | null;
};
