ALTER TABLE meeting_guests ADD COLUMN last_ip text;
ALTER TABLE meeting_sessions ADD COLUMN remote_ip text;

CREATE TABLE meeting_ip_bans (
 id uuid PRIMARY KEY,
 meeting_id uuid NOT NULL REFERENCES scheduled_meetings(id),
 invite_id uuid REFERENCES meeting_invites(id),
 ip text NOT NULL CHECK(length(ip) BETWEEN 2 AND 64),
 target_name text NOT NULL,
 owner_id uuid NOT NULL REFERENCES users(id),
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 1000),
 active boolean NOT NULL DEFAULT true,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 created_at timestamptz NOT NULL,
 updated_at timestamptz NOT NULL,
 updated_by uuid NOT NULL REFERENCES users(id)
);
CREATE UNIQUE INDEX active_meeting_ip_ban ON meeting_ip_bans(COALESCE(invite_id,meeting_id),ip) WHERE active;
CREATE INDEX meeting_ip_ban_owner ON meeting_ip_bans(owner_id,created_at DESC,id DESC);
CREATE INDEX meeting_ip_ban_lookup ON meeting_ip_bans(ip) WHERE active;
CREATE TABLE meeting_ip_ban_events (
 id uuid PRIMARY KEY,
 ban_id uuid NOT NULL REFERENCES meeting_ip_bans(id),
 actor_id uuid NOT NULL REFERENCES users(id),
 operation_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('created','updated','revoked','reactivated')),
 before_state jsonb,
 after_state jsonb NOT NULL,
 created_at timestamptz NOT NULL,
 UNIQUE(actor_id,operation_id)
);
CREATE INDEX meeting_ip_ban_history ON meeting_ip_ban_events(ban_id,created_at,id);
CREATE TABLE meeting_ban_confirmations (
 id uuid PRIMARY KEY,
 actor_id uuid NOT NULL REFERENCES users(id),
 session_id uuid NOT NULL REFERENCES auth_sessions(id),
 operation_id uuid NOT NULL,
 meeting_id uuid NOT NULL REFERENCES scheduled_meetings(id),
 ban_id uuid REFERENCES meeting_ip_bans(id),
 request jsonb NOT NULL,
 ready_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 consumed_at timestamptz,
 result_id uuid REFERENCES meeting_ip_bans(id),
 UNIQUE(actor_id,operation_id)
);
CREATE INDEX meeting_ban_confirmation_expiry ON meeting_ban_confirmations(expires_at) WHERE consumed_at IS NULL;
