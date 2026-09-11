-- Spec 4.1 tables used by the MVP slice. Additions to the spec: NOT NULL on foreign keys,
-- CHECK constraints on enums, and a partial unique index so a meeting has at most one live session.

CREATE TABLE meetings (
  id              UUID PRIMARY KEY,
  code            TEXT UNIQUE NOT NULL,
  org_id          UUID NOT NULL,
  organizer_id    UUID NOT NULL,
  title           TEXT,
  scheduled_start TIMESTAMPTZ,
  scheduled_end   TIMESTAMPTZ,
  region          TEXT NOT NULL,
  settings        JSONB NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('scheduled', 'live', 'ended', 'cancelled')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at        TIMESTAMPTZ
);
CREATE INDEX meetings_org_scheduled_idx ON meetings (org_id, scheduled_start);

CREATE TABLE meeting_sessions (
  id                UUID PRIMARY KEY,
  meeting_id        UUID NOT NULL REFERENCES meetings(id),
  started_at        TIMESTAMPTZ NOT NULL,
  ended_at          TIMESTAMPTZ,
  home_sfu_id       TEXT,
  peak_participants INT
);
CREATE UNIQUE INDEX meeting_sessions_live_idx ON meeting_sessions (meeting_id) WHERE ended_at IS NULL;

CREATE TABLE participants (
  id           UUID PRIMARY KEY,
  session_id   UUID NOT NULL REFERENCES meeting_sessions(id),
  user_id      UUID,
  display_name TEXT NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('host', 'cohost', 'attendee')),
  joined_at    TIMESTAMPTZ NOT NULL,
  left_at      TIMESTAMPTZ,
  leave_reason TEXT
);
CREATE INDEX participants_session_idx ON participants (session_id);
