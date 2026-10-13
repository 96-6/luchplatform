ALTER TABLE auth_sessions ADD COLUMN local_debug boolean NOT NULL DEFAULT false;
CREATE TABLE admin_account_operations (
  actor_id uuid NOT NULL REFERENCES users(id),
  operation_id uuid NOT NULL,
  target_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL CHECK (kind IN ('create','reset')),
  payload_hash char(64) NOT NULL,
  credential_fingerprint char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_id,operation_id)
);
