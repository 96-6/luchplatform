ALTER TABLE scheduled_meetings ADD COLUMN kind text NOT NULL DEFAULT 'scheduled' CHECK (kind IN ('scheduled','adhoc'));
ALTER TABLE scheduled_meetings ADD COLUMN duration_minutes integer CHECK (duration_minutes BETWEEN 1 AND 10080);
ALTER TABLE scheduled_meetings ALTER COLUMN ends_at DROP NOT NULL;
ALTER TABLE scheduled_meetings DROP CONSTRAINT scheduled_meetings_check;
ALTER TABLE scheduled_meetings ADD CONSTRAINT meeting_time_bounds CHECK (
  (kind='scheduled' AND ends_at IS NOT NULL AND ends_at>starts_at AND ends_at<=starts_at+interval '8 hours') OR
  (kind='adhoc' AND (ends_at IS NULL OR ends_at>starts_at))
);
ALTER TABLE meeting_members DROP CONSTRAINT meeting_members_role_check;
ALTER TABLE meeting_members ADD CONSTRAINT meeting_members_role_check CHECK (role IN ('organizer','student','participant'));
CREATE TABLE meeting_invites (
 id uuid PRIMARY KEY,
 meeting_id uuid NOT NULL REFERENCES scheduled_meetings(id),
 created_by uuid NOT NULL REFERENCES users(id),
 token_hash char(64) NOT NULL UNIQUE,
 token_ciphertext text NOT NULL,
 reusable boolean NOT NULL,
 allow_guests boolean NOT NULL,
 expires_at timestamptz,
 revoked_at timestamptz,
 used_by_user_id uuid REFERENCES users(id),
 used_by_guest_id uuid,
 created_at timestamptz NOT NULL,
 revision integer NOT NULL DEFAULT 1,
 CHECK (used_by_user_id IS NULL OR used_by_guest_id IS NULL)
);
CREATE INDEX meeting_invite_target ON meeting_invites(meeting_id);
CREATE TABLE meeting_invite_history (
 invite_id uuid NOT NULL REFERENCES meeting_invites(id),
 meeting_id uuid NOT NULL REFERENCES scheduled_meetings(id),
 PRIMARY KEY(invite_id,meeting_id)
);
CREATE TABLE meeting_guests (
 id uuid PRIMARY KEY,
 meeting_id uuid NOT NULL REFERENCES scheduled_meetings(id),
 invite_id uuid NOT NULL REFERENCES meeting_invites(id),
 full_name text NOT NULL CHECK (length(full_name) BETWEEN 1 AND 100),
 token_hash char(64) NOT NULL UNIQUE,
 token_ciphertext text NOT NULL,
 join_operation_id uuid NOT NULL,
 expires_at timestamptz NOT NULL,
 blocked_at timestamptz,
 admitted_at timestamptz,
 audio_allowed boolean NOT NULL DEFAULT true,
 video_allowed boolean NOT NULL DEFAULT true,
 screen_allowed boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL,
 UNIQUE(invite_id,meeting_id,join_operation_id)
);
ALTER TABLE meeting_invites ADD CONSTRAINT invite_guest_owner FOREIGN KEY(used_by_guest_id) REFERENCES meeting_guests(id);
ALTER TABLE meeting_sessions ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE meeting_sessions ADD COLUMN guest_id uuid REFERENCES meeting_guests(id);
ALTER TABLE meeting_sessions ADD CONSTRAINT meeting_session_identity CHECK ((user_id IS NULL) <> (guest_id IS NULL));
CREATE UNIQUE INDEX one_active_guest_session ON meeting_sessions(meeting_id,guest_id) WHERE state IN ('waiting','admitted');
ALTER TABLE meeting_operations ALTER COLUMN actor_id DROP NOT NULL;
ALTER TABLE meeting_operations ADD COLUMN guest_actor_id uuid REFERENCES meeting_guests(id);
ALTER TABLE meeting_operations ADD CONSTRAINT meeting_operation_identity CHECK ((actor_id IS NULL) <> (guest_actor_id IS NULL));
CREATE UNIQUE INDEX guest_meeting_operation ON meeting_operations(guest_actor_id,operation_id);
ALTER TABLE meeting_messages ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE meeting_messages ADD COLUMN guest_id uuid REFERENCES meeting_guests(id);
ALTER TABLE meeting_messages ADD COLUMN attachment_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE meeting_messages ADD CONSTRAINT meeting_message_identity CHECK ((user_id IS NULL) <> (guest_id IS NULL));
ALTER TABLE meeting_messages DROP CONSTRAINT meeting_messages_text_check;
ALTER TABLE meeting_messages ADD CONSTRAINT meeting_message_content CHECK (length(text)<=2000 AND (length(text)>0 OR cardinality(attachment_ids)>0) AND cardinality(attachment_ids)<=5);
CREATE UNIQUE INDEX guest_message_operation ON meeting_messages(guest_id,operation_id);
CREATE TABLE meeting_file_policy (
 id smallint PRIMARY KEY CHECK (id=1),
 max_file_mb integer NOT NULL DEFAULT 125 CHECK (max_file_mb BETWEEN 1 AND 1024),
 large_file_mb integer NOT NULL DEFAULT 50 CHECK (large_file_mb BETWEEN 0 AND 1024),
 retention_days integer NOT NULL DEFAULT 10 CHECK (retention_days BETWEEN 1 AND 3650),
 revision integer NOT NULL DEFAULT 1,
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by uuid REFERENCES users(id),
 CHECK (large_file_mb<=max_file_mb)
);
INSERT INTO meeting_file_policy(id) VALUES(1);
CREATE TABLE meeting_files (
 id uuid PRIMARY KEY,
 meeting_id uuid NOT NULL REFERENCES scheduled_meetings(id),
 owner_user_id uuid REFERENCES users(id),
 owner_guest_id uuid REFERENCES meeting_guests(id),
 operation_id uuid NOT NULL,
 message_id uuid REFERENCES meeting_messages(id),
 filename text NOT NULL,
 media_type text NOT NULL,
 size_bytes bigint NOT NULL CHECK (size_bytes>0 AND size_bytes<=1073741824),
 content_hash char(64) NOT NULL,
 storage_key uuid NOT NULL UNIQUE,
 created_at timestamptz NOT NULL,
 expires_at timestamptz,
 deleted_at timestamptz,
 purged_at timestamptz,
 CHECK ((owner_user_id IS NULL) <> (owner_guest_id IS NULL)),
 UNIQUE(owner_user_id,operation_id),
 UNIQUE(owner_guest_id,operation_id)
);
CREATE INDEX meeting_file_message ON meeting_files(message_id);
CREATE INDEX meeting_file_expiry ON meeting_files(expires_at) WHERE purged_at IS NULL;
