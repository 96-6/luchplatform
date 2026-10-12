CREATE TABLE users (
  id uuid PRIMARY KEY,
  email varchar(254) NOT NULL UNIQUE CHECK (email = lower(email)),
  full_name varchar(100) NOT NULL,
  role varchar(20) NOT NULL CHECK (role IN ('student', 'teacher', 'superadmin')),
  email_verified_at timestamptz,
  totp_secret_ciphertext text,
  totp_enabled_at timestamptz,
  last_totp_counter bigint NOT NULL DEFAULT -1,
  is_demo boolean NOT NULL DEFAULT false,
  is_blocked boolean NOT NULL DEFAULT false,
  access_verified boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, role)
);

CREATE TABLE teacher_students (
  teacher_id uuid NOT NULL,
  teacher_role varchar(20) NOT NULL DEFAULT 'teacher' CHECK (teacher_role = 'teacher'),
  student_id uuid NOT NULL,
  student_role varchar(20) NOT NULL DEFAULT 'student' CHECK (student_role = 'student'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (teacher_id, student_id),
  FOREIGN KEY (teacher_id, teacher_role) REFERENCES users(id, role) ON DELETE CASCADE,
  FOREIGN KEY (student_id, student_role) REFERENCES users(id, role) ON DELETE CASCADE
);

CREATE TABLE auth_tokens (
  token_hash char(64) PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind varchar(16) NOT NULL CHECK (kind IN ('email', 'enrollment')),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_tokens_user_idx ON auth_tokens (user_id, kind);

CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY,
  token_hash char(64) NOT NULL UNIQUE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_sessions_user_idx ON auth_sessions (user_id, expires_at);

CREATE TABLE security_policy (
  id smallint PRIMARY KEY CHECK (id = 1),
  captcha_enabled boolean NOT NULL DEFAULT true,
  vpn_check_enabled boolean NOT NULL DEFAULT false,
  ip_allowlist jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(ip_allowlist) = 'array'),
  session_hours integer NOT NULL DEFAULT 24 CHECK (session_hours BETWEEN 1 AND 168),
  revision integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id)
);
INSERT INTO security_policy (id) VALUES (1);

CREATE TABLE captcha_challenges (
  id uuid PRIMARY KEY,
  answer_hash char(64) NOT NULL,
  ip_hash char(64) NOT NULL,
  purpose varchar(16) NOT NULL CHECK (purpose IN ('login', 'register', 'enrollment')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE auth_rate_limits (
  key_hash char(64) PRIMARY KEY,
  window_started_at timestamptz NOT NULL,
  attempts integer NOT NULL CHECK (attempts > 0)
);

CREATE TABLE mail_outbox (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient varchar(254) NOT NULL,
  subject text NOT NULL,
  body_ciphertext text NOT NULL,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mail_outbox_user_idx ON mail_outbox (user_id, created_at DESC);

CREATE TABLE network_assessments (
  id uuid PRIMARY KEY,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  ip text NOT NULL,
  policy_revision integer NOT NULL,
  observations jsonb NOT NULL,
  denied boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX network_assessments_user_idx ON network_assessments (user_id, created_at DESC);

CREATE TABLE security_audit (
  id uuid PRIMARY KEY,
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  target_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action varchar(60) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX security_audit_created_idx ON security_audit (created_at DESC);
