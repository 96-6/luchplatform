CREATE TABLE browser_policy (
 id smallint PRIMARY KEY CHECK (id=1),
 outdated_enabled boolean NOT NULL DEFAULT true,
 enhanced_enabled boolean NOT NULL DEFAULT false,
 blocked_browsers jsonb NOT NULL DEFAULT '["ie","edge_legacy","opera_mini","uc","puffin","qq","webview"]',
 allowed_browsers jsonb NOT NULL DEFAULT '["chrome","chromium","edge","firefox","safari","opera","brave","vivaldi","vanadium","samsung","duckduckgo"]',
 minimum_versions jsonb NOT NULL DEFAULT '{"chromium":154,"firefox":153,"webkit":26}',
 revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by uuid REFERENCES users(id)
);
INSERT INTO browser_policy(id) VALUES(1);
CREATE TABLE browser_challenges (
 id uuid PRIMARY KEY,
 client_hash char(64) NOT NULL,
 nonce_hash char(64) NOT NULL,
 header_hash char(64) NOT NULL,
 policy_revision integer NOT NULL,
 expires_at timestamptz NOT NULL,
 consumed_at timestamptz
);
CREATE INDEX browser_challenge_expiry ON browser_challenges(expires_at);
CREATE TABLE browser_assessments (
 client_hash char(64) PRIMARY KEY,
 header_hash char(64) NOT NULL,
 policy_revision integer NOT NULL,
 signals jsonb NOT NULL,
 decision jsonb NOT NULL,
 verified_until timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 notice_acknowledged boolean NOT NULL DEFAULT false
);
CREATE INDEX browser_assessment_expiry ON browser_assessments(expires_at);
CREATE TABLE browser_notice_acknowledgements (
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 browser text NOT NULL,
 acknowledged_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,browser)
);
