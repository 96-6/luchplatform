ALTER TABLE users ADD COLUMN password_hash_ciphertext text;
ALTER TABLE users ADD COLUMN password_changed_at timestamptz;
ALTER TABLE users ADD COLUMN auth_revision integer NOT NULL DEFAULT 0 CHECK (auth_revision >= 0);
ALTER TABLE auth_sessions ADD COLUMN auth_revision integer NOT NULL DEFAULT 0;
ALTER TABLE auth_tokens ADD COLUMN auth_revision integer NOT NULL DEFAULT 0;
ALTER TABLE auth_tokens DROP CONSTRAINT auth_tokens_kind_check;
ALTER TABLE auth_tokens ADD CONSTRAINT auth_tokens_kind_check CHECK (kind IN ('email','enrollment','password'));
ALTER TABLE captcha_challenges DROP CONSTRAINT captcha_challenges_purpose_check;
ALTER TABLE captcha_challenges ADD CONSTRAINT captcha_challenges_purpose_check CHECK (purpose IN ('login','register','enrollment','password'));
ALTER TABLE admin_account_operations DROP CONSTRAINT admin_account_operations_kind_check;
ALTER TABLE admin_account_operations ADD CONSTRAINT admin_account_operations_kind_check CHECK (kind IN ('create','reset','password'));
CREATE TABLE auth_login_challenges (
  token_hash char(64) PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  auth_revision integer NOT NULL,
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_login_challenges_user ON auth_login_challenges(user_id);
UPDATE auth_sessions SET revoked_at=now() WHERE revoked_at IS NULL AND local_debug=false;
UPDATE auth_tokens SET consumed_at=now() WHERE kind='enrollment' AND consumed_at IS NULL;
