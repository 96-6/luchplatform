CREATE TABLE platform_update_channel (
 id smallint PRIMARY KEY CHECK(id=1),
 checked_at timestamptz,
 next_check_at timestamptz,
 checking_since timestamptz,
 latest_commit text,
 latest_fingerprint text,
 latest_committed_at timestamptz,
 etag text,
 last_error text
);
INSERT INTO platform_update_channel(id) VALUES(1);
CREATE TABLE platform_update_jobs (
 id uuid PRIMARY KEY,
 actor_id uuid NOT NULL REFERENCES users(id),
 operation_id uuid NOT NULL,
 target_commit text NOT NULL CHECK(target_commit ~ '^[a-f0-9]{40}$'),
 phase text NOT NULL DEFAULT 'queued',
 created_at timestamptz NOT NULL DEFAULT now(),
 completed_at timestamptz,
 restored boolean NOT NULL DEFAULT false,
 UNIQUE(actor_id,operation_id)
);
CREATE UNIQUE INDEX platform_update_one_active ON platform_update_jobs((true))
 WHERE phase NOT IN ('completed','failed','rollback_failed');
