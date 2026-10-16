CREATE TABLE scheduled_meetings (
  id uuid PRIMARY KEY,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  description text NOT NULL DEFAULT '' CHECK (length(description)<=3000),
  language text NOT NULL CHECK (language IN ('ru','en')),
  organizer_id uuid NOT NULL REFERENCES users(id),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  time_zone text NOT NULL,
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','live','completed','cancelled')),
  revision integer NOT NULL DEFAULT 1,
  room_name text NOT NULL UNIQUE,
  lobby_enabled boolean NOT NULL DEFAULT true,
  locked boolean NOT NULL DEFAULT false,
  started_at timestamptz,
  ended_at timestamptz,
  summary_comment text,
  summary_revision integer NOT NULL DEFAULT 0,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (ends_at>starts_at AND ends_at<=starts_at+interval '8 hours')
);
CREATE INDEX meeting_calendar ON scheduled_meetings(starts_at,id);
CREATE TABLE meeting_members (
  meeting_id uuid NOT NULL REFERENCES scheduled_meetings(id),
  user_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL CHECK (role IN ('organizer','student')),
  blocked_at timestamptz,
  audio_allowed boolean NOT NULL DEFAULT true,
  video_allowed boolean NOT NULL DEFAULT true,
  screen_allowed boolean NOT NULL DEFAULT true,
  PRIMARY KEY (meeting_id,user_id)
);
CREATE INDEX member_calendar ON meeting_members(user_id,meeting_id);
CREATE TABLE meeting_sessions (
  id uuid PRIMARY KEY,
  meeting_id uuid NOT NULL REFERENCES scheduled_meetings(id),
  user_id uuid NOT NULL REFERENCES users(id),
  state text NOT NULL CHECK (state IN ('waiting','admitted','left','removed')),
  hand_raised_at timestamptz,
  first_connected_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL,
  ended_at timestamptz
);
CREATE UNIQUE INDEX one_active_meeting_session ON meeting_sessions(meeting_id,user_id) WHERE state IN ('waiting','admitted');
CREATE INDEX meeting_session_roster ON meeting_sessions(meeting_id,created_at,id);
CREATE TABLE meeting_operations (
  id uuid PRIMARY KEY,
  meeting_id uuid NOT NULL REFERENCES scheduled_meetings(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  operation_id uuid NOT NULL,
  kind text NOT NULL,
  request jsonb NOT NULL,
  before_state jsonb,
  result_id uuid,
  created_at timestamptz NOT NULL,
  UNIQUE(actor_id,operation_id)
);
CREATE TABLE meeting_commands (
  sequence bigserial PRIMARY KEY,
  id uuid NOT NULL UNIQUE,
  meeting_id uuid NOT NULL REFERENCES scheduled_meetings(id),
  kind text NOT NULL CHECK (kind IN ('permissions','remove','delete_room')),
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied')),
  attempts integer NOT NULL DEFAULT 0,
  retry_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  applied_at timestamptz
);
CREATE INDEX pending_meeting_commands ON meeting_commands(sequence) WHERE status='pending';
CREATE TABLE meeting_device_reports (
  session_id uuid PRIMARY KEY REFERENCES meeting_sessions(id),
  revision integer NOT NULL CHECK (revision>0),
  request jsonb NOT NULL,
  camera jsonb,
  microphone jsonb,
  reported_at timestamptz NOT NULL
);
CREATE TABLE meeting_messages (
  id uuid PRIMARY KEY,
  meeting_id uuid NOT NULL REFERENCES scheduled_meetings(id),
  user_id uuid NOT NULL REFERENCES users(id),
  operation_id uuid NOT NULL,
  text text NOT NULL CHECK (length(text) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL,
  UNIQUE(user_id,operation_id)
);
CREATE INDEX meeting_chat_page ON meeting_messages(meeting_id,created_at DESC,id DESC);
CREATE TABLE meeting_homework (
  id uuid PRIMARY KEY,
  meeting_id uuid NOT NULL REFERENCES scheduled_meetings(id),
  student_id uuid NOT NULL REFERENCES users(id),
  assignment_id uuid NOT NULL REFERENCES plan_assignments(id) UNIQUE,
  action_id uuid NOT NULL REFERENCES teacher_actions(id),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL
);
