CREATE TABLE client_protection_policy (
 id smallint PRIMARY KEY CHECK(id=1),
 interaction_enabled boolean NOT NULL DEFAULT false,
 interaction_roles jsonb NOT NULL DEFAULT '["student","teacher"]',
 blockers_enabled boolean NOT NULL DEFAULT false,
 blockers_roles jsonb NOT NULL DEFAULT '["student","teacher"]',
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by uuid REFERENCES users(id)
);
INSERT INTO client_protection_policy(id) VALUES(1);
CREATE TABLE client_capability_challenges (
 id uuid PRIMARY KEY,
 session_id uuid NOT NULL REFERENCES auth_sessions(id) ON DELETE CASCADE,
 client_hash text NOT NULL,
 header_hash text NOT NULL,
 nonce_hash text NOT NULL,
 policy_revision integer NOT NULL,
 resource_seen boolean NOT NULL DEFAULT false,
 consumed_at timestamptz,
 expires_at timestamptz NOT NULL
);
CREATE INDEX client_challenge_expiry ON client_capability_challenges(expires_at);
CREATE TABLE client_capability_grants (
 session_id uuid NOT NULL REFERENCES auth_sessions(id) ON DELETE CASCADE,
 client_hash text NOT NULL,
 header_hash text NOT NULL,
 policy_revision integer NOT NULL,
 verified_until timestamptz NOT NULL,
 PRIMARY KEY(session_id,client_hash)
);
CREATE INDEX client_grant_expiry ON client_capability_grants(verified_until);
